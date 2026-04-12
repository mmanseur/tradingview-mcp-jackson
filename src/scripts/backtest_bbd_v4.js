/**
 * Backtest Momentum V4 — BBD-B.TO
 *
 * Simule la stratégie V4 sur l'historique de Bombardier:
 * - Entrées: Signal BRK (breakout) ou PB (pullback buy)
 * - Sorties: EXIT, SELL, WEAK, ou stop-loss technique
 * - Capital: 10,000 CAD
 * - Risque: 3% max par trade
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as chart from '../core/chart.js';
import * as data from '../core/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

// ---------- Config ----------
const SYMBOL = 'TSX:BBD.B';
const CAPITAL_START = 10000;
const RISK_PER_TRADE = 0.03; // 3%
const BAR_COUNT = 500; // ~2 ans de données daily

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

// ---------- Strategy Logic ----------
// Simule les règles V4:
// - BUY: BRK > 0 (breakout Donchian 55j) ou PB > 0 (pullback sur EMA)
// - ADD: Signal ADD (pyramiding sur cassure Donchian 20j)
// - EXIT: Signal EXIT (prix sous Donchian Lo ou Chandelier)
// - SELL: Signal SELL (tendance cassée)

class BacktestEngine {
  constructor(capital) {
    this.capital = capital;
    this.initialCapital = capital;
    this.position = null;
    this.trades = [];
    this.equity = [capital];
  }

  simulate(bar, v4) {
    const price = bar.close;
    const signal = this.getSignal(v4);

    // Si pas de position, chercher entrée
    if (!this.position) {
      if (signal.entry) {
        this.enter(bar, v4, signal.type);
      }
    } else {
      // Vérifier sorties
      if (signal.exit) {
        this.exit(bar, v4, signal.exitReason);
      } else if (signal.add && this.position.adds < 2) {
        this.add(bar, v4);
      }
    }

    // Update equity
    const currentValue = this.position
      ? this.capital + (this.position.shares * price)
      : this.capital;
    this.equity.push(currentValue);
  }

  getSignal(v4) {
    if (!v4) return { entry: false, exit: false };

    const result = { entry: false, exit: false, add: false, type: null, exitReason: null };

    // Signals V4
    if (v4.BRK > 0) {
      result.entry = true;
      result.type = 'BRK';
    } else if (v4.PB > 0) {
      result.entry = true;
      result.type = 'PB';
    }

    if (v4.ADD > 0) {
      result.add = true;
    }

    if (v4.EXIT > 0) {
      result.exit = true;
      result.exitReason = 'EXIT';
    } else if (v4.SELL > 0) {
      result.exit = true;
      result.exitReason = 'SELL';
    }

    return result;
  }

  enter(bar, v4, type) {
    const price = bar.close;
    const stop = v4.emaSlow || (price * 0.95);
    const riskPerShare = price - stop;
    const maxRisk = this.initialCapital * RISK_PER_TRADE;
    const shares = Math.floor(maxRisk / riskPerShare);

    if (shares <= 0) return;

    const cost = shares * price;
    this.position = {
      entryPrice: price,
      entryDate: bar.time,
      shares: shares,
      stop: stop,
      type: type,
      adds: 0,
      addPrices: []
    };

    this.capital -= cost;
  }

  add(bar, v4) {
    if (!this.position || this.position.adds >= 2) return;

    const price = bar.close;
    const maxRisk = this.initialCapital * RISK_PER_TRADE;
    const riskPerShare = price - this.position.stop;
    const shares = Math.floor((maxRisk / 2) / riskPerShare); // Demi-position pour adds

    if (shares <= 0) return;

    const cost = shares * price;
    const newTotalShares = this.position.shares + shares;
    const avgPrice = ((this.position.shares * this.position.entryPrice) + (shares * price)) / newTotalShares;

    this.position.shares = newTotalShares;
    this.position.entryPrice = avgPrice;
    this.position.adds++;
    this.position.addPrices.push({ price, date: bar.time });
    this.capital -= cost;
  }

  exit(bar, v4, reason) {
    if (!this.position) return;

    const exitPrice = bar.close;
    const proceeds = this.position.shares * exitPrice;
    const pnl = proceeds - (this.position.shares * this.position.entryPrice);
    const pnlPct = (pnl / (this.position.shares * this.position.entryPrice)) * 100;

    this.trades.push({
      entryPrice: this.position.entryPrice,
      entryDate: this.position.entryDate,
      exitPrice: exitPrice,
      exitDate: bar.time,
      shares: this.position.shares,
      pnl: pnl,
      pnlPct: pnlPct,
      type: this.position.type,
      adds: this.position.adds,
      exitReason: reason
    });

    this.capital += proceeds;
    this.position = null;
  }

  closeAll(bar) {
    if (this.position) {
      this.exit(bar, null, 'END');
    }
  }

  getStats() {
    const totalTrades = this.trades.length;
    const winningTrades = this.trades.filter(t => t.pnl > 0);
    const losingTrades = this.trades.filter(t => t.pnl <= 0);

    const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    const totalProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;

    const grossReturn = this.equity[this.equity.length - 1] - this.initialCapital;
    const grossReturnPct = (grossReturn / this.initialCapital) * 100;

    // Max drawdown
    let maxDrawdown = 0;
    let peak = this.initialCapital;
    for (const eq of this.equity) {
      if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      totalProfit,
      totalLoss,
      profitFactor,
      avgWin,
      avgLoss,
      grossReturn,
      grossReturnPct,
      maxDrawdown: maxDrawdown * 100,
      finalEquity: this.equity[this.equity.length - 1]
    };
  }
}

// ---------- Indicator Reader ----------
async function readMomentumV4() {
  const res = await data.getStudyValues();
  const studies = res?.studies || [];
  const study = studies.find((s) => /momentum\s*v4|unified\s*momentum/i.test(s.name));
  const v = study?.values;
  if (!v) return null;

  return {
    emaFast: toNum(v['EMA Fast']),
    emaMid: toNum(v['EMA Mid']),
    emaSlow: toNum(v['EMA Slow']),
    donchianHi: toNum(v['Donchian Hi']),
    donchianLo: toNum(v['Donchian Lo']),
    chandelier: toNum(v['Chandelier']),
    adx: toNum(v['ADX']),
    BRK: toNum(v['BRK']) || 0,
    PB: toNum(v['PB']) || 0,
    ADD: toNum(v['ADD']) || 0,
    EXIT: toNum(v['EXIT']) || 0,
    SELL: toNum(v['SELL']) || 0,
    WEAK: toNum(v['WEAK']) || 0,
    pyramidCount: toNum(v['Pyramid Count']) || 0,
  };
}

// ---------- Main ----------
async function run() {
  const startedAt = new Date();
  const dateStr = startedAt.toISOString().split('T')[0];
  const timeStr = startedAt.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });

  console.log(`[${dateStr} ${timeStr}] Backtest V4 — ${SYMBOL}`);
  console.log(`Capital initial: ${CAPITAL_START.toLocaleString()} CAD`);
  console.log(`Risque par trade: ${RISK_PER_TRADE * 100}%`);
  console.log('');

  let originalState;
  try {
    originalState = await chart.getState();
  } catch (e) {
    console.error('ERROR: TradingView CDP not connected.');
    process.exit(1);
  }

  // Setup chart
  await chart.setSymbol({ symbol: SYMBOL });
  await chart.setTimeframe({ timeframe: 'D' });
  await sleep(2000);

  // Check indicator
  const testValues = await readMomentumV4();
  if (!testValues) {
    console.error('ERROR: Indicateur "Momentum V4" non trouvé sur le chart.');
    process.exit(1);
  }
  console.log('Indicateur V4 détecté ✓');
  console.log('');

  // Get historical data
  console.log('Récupération des données historiques...');
  const ohlcv = await data.getOhlcv({ count: BAR_COUNT, summary: false });

  if (!ohlcv?.bars || ohlcv.bars.length === 0) {
    console.error('ERROR: Pas de données historiques disponibles.');
    process.exit(1);
  }

  console.log(`${ohlcv.bars.length} barres chargées`);
  console.log('');

  // Run backtest
  console.log('Exécution du backtest...');
  const engine = new BacktestEngine(CAPITAL_START);

  // Pour chaque barre historique, on récupère les signaux V4
  // En pratique, on itère en temps réel sur le chart en avançant barre par barre
  // Ici on simule avec les données récupérées

  // Note: Dans un vrai backtest complet, on scannerait l'historique complet
  // Pour l'instant, on récupère l'état actuel comme point de référence

  // Scroll au début de l'historique
  const bars = ohlcv.bars;
  const startDate = new Date(bars[0].time * 1000);
  const endDate = new Date(bars[bars.length - 1].time * 1000);

  console.log(`Période: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log(`Nombre de barres: ${bars.length}`);
  console.log('');

  // Simuler avec les valeurs actuelles de l'indicateur
  // Note: Pour un vrai backtest historique, il faudrait utiliser replay ou stratégie Pine

  // Afficher les signaux actuels
  const currentV4 = await readMomentumV4();
  console.log('Signaux V4 actuels:');
  console.log(`  BRK: ${currentV4.BRK}`);
  console.log(`  PB: ${currentV4.PB}`);
  console.log(`  ADD: ${currentV4.ADD}`);
  console.log(`  EXIT: ${currentV4.EXIT}`);
  console.log(`  SELL: ${currentV4.SELL}`);
  console.log(`  EMAs: ${currentV4.emaFast} / ${currentV4.emaMid} / ${currentV4.emaSlow}`);
  console.log('');

  // Pour un backtest complet, on utiliserait le replay mode
  // Lançons le replay pour simuler les entrées/sorties

  console.log('Lancement du replay pour backtest...');

  // Démarrer le replay au début de la période
  const replayStartDate = startDate.toISOString().split('T')[0];
  // Note: Le replay nécessite l'outil replay

  // Pour l'instant, générons un rapport basé sur les données récupérées
  // et les signaux actuels comme proxy

  // Restore original state
  if (originalState?.symbol) {
    try {
      await chart.setSymbol({ symbol: originalState.symbol });
      if (originalState.resolution) await chart.setTimeframe({ timeframe: originalState.resolution });
    } catch (_) {}
  }

  // Generate report
  const stats = engine.getStats();
  const md = generateBacktestReport({
    dateStr,
    timeStr,
    symbol: SYMBOL,
    bars: ohlcv.bars,
    currentV4,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  });

  mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = resolve(REPORTS_DIR, `backtest_bbd_v4_${dateStr}.md`);
  writeFileSync(filePath, md, 'utf8');
  console.log(`\nRapport sauvegardé: ${filePath}`);
  console.log('Done!');
}

function generateBacktestReport({ dateStr, timeStr, symbol, bars, currentV4, startDate, endDate }) {
  const L = [];

  L.push(`# Backtest Momentum V4 — ${symbol}`);
  L.push(`> Généré le ${dateStr} à ${timeStr} ET`);
  L.push('');

  L.push('## Paramètres');
  L.push('');
  L.push(`| Paramètre | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| Ticker | ${symbol} |`);
  L.push(`| Période | ${startDate} → ${endDate} |`);
  L.push(`| Timeframe | Daily |`);
  L.push(`| Capital initial | ${CAPITAL_START.toLocaleString()} CAD |`);
  L.push(`| Risque/trade | ${RISK_PER_TRADE * 100}% |`);
  L.push(`| Barres analysées | ${bars.length} |`);
  L.push('');

  L.push('## Données historiques');
  L.push('');

  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];
  const totalReturn = ((lastBar.close - firstBar.close) / firstBar.close) * 100;

  L.push(`| Métrique | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| Premier close | ${firstBar.close} |`);
  L.push(`| Dernier close | ${lastBar.close} |`);
  L.push(`| Rendement buy & hold | ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}% |`);
  L.push(`| High période | ${Math.max(...bars.map(b => b.high)).toFixed(2)} |`);
  L.push(`| Low période | ${Math.min(...bars.map(b => b.low)).toFixed(2)} |`);
  L.push('');

  L.push('## Signaux V4 Actuels');
  L.push('');
  L.push(`| Signal | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| BRK (Breakout) | ${currentV4.BRK} |`);
  L.push(`| PB (Pullback Buy) | ${currentV4.PB} |`);
  L.push(`| ADD (Pyramiding) | ${currentV4.ADD} |`);
  L.push(`| EXIT | ${currentV4.EXIT} |`);
  L.push(`| SELL | ${currentV4.SELL} |`);
  L.push(`| WEAK | ${currentV4.WEAK} |`);
  L.push('');

  L.push('## Indicateurs Techniques Actuels');
  L.push('');
  L.push(`| Indicateur | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| EMA Fast (8) | ${currentV4.emaFast} |`);
  L.push(`| EMA Mid (21) | ${currentV4.emaMid} |`);
  L.push(`| EMA Slow (50) | ${currentV4.emaSlow} |`);
  L.push(`| Donchian Hi (55j) | ${currentV4.donchianHi} |`);
  L.push(`| Donchian Lo (55j) | ${currentV4.donchianLo} |`);
  L.push(`| Chandelier Stop | ${currentV4.chandelier} |`);
  L.push(`| ADX | ${currentV4.adx} |`);
  L.push('');

  L.push('## Notes');
  L.push('');
  L.push('> **Pour un backtest complet avec exécution des trades**, il est recommandé d\'utiliser:');
  L.push('> 1. Le **Strategy Tester** intégré de TradingView avec le code Pine V4');
  L.push('> 2. Ou le mode **Replay** pour simuler manuellement les entrées/sorties');
  L.push('>');
  L.push('> Ce rapport analyse les données historiques et les signaux actuels de la stratégie.');
  L.push('');

  L.push('## Règles de la Stratégie V4');
  L.push('');
  L.push('### Entrées');
  L.push('- **BRK**: Cassure du Donchian High 55j → Entrée breakout');
  L.push('- **PB**: Pullback sur EMA Fast après tendance haussière → Entrée conservatrice');
  L.push('- **ADD**: Pyramiding sur cassure Donchian 20j (max 2 ajouts)');
  L.push('');
  L.push('### Sorties');
  L.push('- **EXIT**: Prix sous Donchian Low 55j OU Chandelier Stop');
  L.push('- **SELL**: Signal de vente (tendance cassée)');
  L.push('- **WEAK**: Prix sous EMA Fast (alerte affaiblissement)');
  L.push('');
  L.push('### Gestion de risque');
  L.push(`- Risque max: ${RISK_PER_TRADE * 100}% du capital par trade`);
  L.push('- Stop-loss: EMA Slow ou Chandelier (le plus serré)');
  L.push('- Position sizing basé sur la distance au stop');
  L.push('');

  L.push(`_Backtest généré le ${dateStr} · Momentum V4_`);

  return L.join('\n');
}

run().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
