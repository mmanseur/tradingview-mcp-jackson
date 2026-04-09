/**
 * Morning Brief Script — Automated daily swing trading brief
 * Runs at 9:25 ET, Mon-Fri
 *
 * 1. Connects to TradingView via CDP (must be running with --remote-debugging-port=9222)
 * 2. Scans all 7 TSX watchlist tickers
 * 3. Collects quote + indicator data
 * 4. Calculates RSI, trend, support/resistance
 * 5. Generates a markdown file on Desktop/briefs/
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as chart from '../core/chart.js';
import * as data from '../core/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIEFS_DIR = resolve(process.env.USERPROFILE || process.env.HOME, 'Desktop', 'briefs');

// --- Config ---
const WATCHLIST = [
  { symbol: 'TSX:BBD-B', name: 'Bombardier',             sector: 'Aerospace/Defense' },
  { symbol: 'TSX:WPM',   name: 'Wheaton Precious Metals', sector: 'Mining/Gold' },
  { symbol: 'TSX:CLS',   name: 'Celestica',              sector: 'Tech/Semis' },
  { symbol: 'TSX:AEM',   name: 'Agnico Eagle Mines',     sector: 'Mining/Gold' },
  { symbol: 'TSX:CGG',   name: 'China Gold International', sector: 'Mining/Gold' },
  { symbol: 'TSX:VNP',   name: '5N Plus',                sector: 'Mining/Materials' },
];

const CAPITAL = 10000;
const RISK_PCT = 0.03; // 3%
const MAX_RISK = CAPITAL * RISK_PCT; // 300$

// --- Helpers ---
function calcRSI(closes) {
  if (closes.length < 15) return null;
  const recent = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return Math.round(ema * 100) / 100;
}

function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = Math.round((ema12 - ema26) * 100) / 100;
  // Approximate signal line from last 9 MACD values
  return { macd: macdLine, ema12, ema26, signal: macdLine > 0 ? 'Haussier' : 'Baissier' };
}

function findSupport(lows) {
  if (lows.length < 5) return null;
  const recent = lows.slice(-20);
  return Math.round(Math.min(...recent) * 100) / 100;
}

function findResistance(highs) {
  if (highs.length < 5) return null;
  const recent = highs.slice(-20);
  return Math.round(Math.max(...recent) * 100) / 100;
}

function signalFromData(rsi, macdSignal, price, ema20, ema50) {
  let score = 0;
  if (rsi !== null) {
    if (rsi < 30) score += 2;
    else if (rsi < 45) score += 1;
    else if (rsi > 70) score -= 2;
    else if (rsi > 55) score -= 0;
  }
  if (macdSignal === 'Haussier') score += 1;
  else if (macdSignal === 'Baissier') score -= 1;
  if (ema20 && price > ema20) score += 1;
  else if (ema20 && price < ema20) score -= 1;
  if (ema50 && price > ema50) score += 1;
  else if (ema50 && price < ema50) score -= 1;

  if (score >= 3) return 'ACHAT FORT';
  if (score >= 1) return 'ACHAT';
  if (score <= -3) return 'VENTE FORTE';
  if (score <= -1) return 'VENTE';
  return 'NEUTRE';
}

function positionSize(entryPrice, stopPrice) {
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (riskPerShare === 0) return 0;
  const shares = Math.floor(MAX_RISK / riskPerShare);
  const cost = shares * entryPrice;
  // Cap at total capital
  if (cost > CAPITAL) return Math.floor(CAPITAL / entryPrice);
  return shares;
}

// --- Main ---
async function run() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });

  console.log(`[${dateStr} ${timeStr}] Morning brief starting...`);

  // Check CDP connection
  try {
    await chart.getState();
  } catch (e) {
    console.error('ERROR: TradingView CDP not connected. Launch TradingView with --remote-debugging-port=9222 first.');
    process.exit(1);
  }

  // Save original state
  let originalState;
  try {
    originalState = await chart.getState();
  } catch (_) {}

  // Switch to Daily timeframe
  await chart.setTimeframe({ timeframe: 'D' });
  await sleep(1000);

  const results = [];

  for (const ticker of WATCHLIST) {
    console.log(`  Scanning ${ticker.symbol}...`);
    try {
      await chart.setSymbol({ symbol: ticker.symbol });
      await sleep(2000);

      const [quote, ohlcv] = await Promise.all([
        data.getQuote({}),
        data.getOhlcv({ count: 60, summary: false }),
      ]);

      const closes = ohlcv?.bars?.map(b => b.close) || [];
      const highs = ohlcv?.bars?.map(b => b.high) || [];
      const lows = ohlcv?.bars?.map(b => b.low) || [];
      const volumes = ohlcv?.bars?.map(b => b.volume) || [];

      const rsi = calcRSI(closes);
      const ema20 = calcEMA(closes, 20);
      const ema50 = calcEMA(closes, 50);
      const macd = calcMACD(closes);
      const support = findSupport(lows);
      const resistance = findResistance(highs);
      const avgVolume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : null;

      const price = quote?.last || quote?.close || closes[closes.length - 1];
      const signal = signalFromData(rsi, macd?.signal, price, ema20, ema50);

      // Position sizing
      const stopLoss = support ? Math.round((support - support * 0.01) * 100) / 100 : null;
      const shares = stopLoss ? positionSize(price, stopLoss) : null;

      results.push({
        ...ticker,
        price,
        open: quote?.open,
        high: quote?.high,
        low: quote?.low,
        volume: quote?.volume,
        avgVolume,
        rsi,
        ema20,
        ema50,
        macd,
        support,
        resistance,
        signal,
        stopLoss,
        shares,
        tp1: resistance ? Math.round(resistance * 100) / 100 : null,
        tp2: resistance ? Math.round(resistance * 1.03 * 100) / 100 : null,
      });
    } catch (err) {
      results.push({ ...ticker, error: err.message });
    }
  }

  // Restore original chart
  if (originalState?.symbol) {
    try {
      await chart.setSymbol({ symbol: originalState.symbol });
      if (originalState.resolution) await chart.setTimeframe({ timeframe: originalState.resolution });
    } catch (_) {}
  }

  // Generate markdown
  const md = generateMarkdown(dateStr, timeStr, results);

  // Save
  mkdirSync(BRIEFS_DIR, { recursive: true });
  const filePath = resolve(BRIEFS_DIR, `${dateStr}.md`);
  writeFileSync(filePath, md, 'utf8');
  console.log(`\nBrief saved: ${filePath}`);
  console.log('Done!');
}

function generateMarkdown(date, time, results) {
  const lines = [];
  lines.push(`# Brief Matinal TSX — ${date}`);
  lines.push(`> Genere a ${time} ET | Capital: ${CAPITAL}$ | Risque max/trade: ${MAX_RISK}$ (${RISK_PCT * 100}%)`);
  lines.push('');

  // Summary table
  lines.push('## Resume');
  lines.push('');
  lines.push('| Ticker | Prix | Chg | RSI | EMA20 | Signal | Action |');
  lines.push('|--------|------|-----|-----|-------|--------|--------|');
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.symbol} | ERROR | - | - | - | - | ${r.error} |`);
      continue;
    }
    const chg = r.open ? ((r.price - r.open) / r.open * 100).toFixed(2) + '%' : '-';
    const pos = r.price > (r.ema20 || 0) ? 'Au-dessus' : 'En-dessous';
    lines.push(`| **${r.symbol}** | ${r.price} | ${chg} | ${r.rsi || '-'} | ${r.ema20 || '-'} (${pos}) | **${r.signal}** | Voir details |`);
  }
  lines.push('');

  // Detailed analysis per ticker
  lines.push('---');
  lines.push('## Details par ticker');
  lines.push('');

  for (const r of results) {
    if (r.error) continue;

    lines.push(`### ${r.symbol} — ${r.name} (${r.sector})`);
    lines.push('');
    lines.push(`| Indicateur | Valeur |`);
    lines.push(`|---|---|`);
    lines.push(`| Prix | **${r.price} CAD** |`);
    lines.push(`| O/H/L | ${r.open || '-'} / ${r.high || '-'} / ${r.low || '-'} |`);
    lines.push(`| Volume | ${r.volume?.toLocaleString() || '-'} (moy: ${r.avgVolume?.toLocaleString() || '-'}) |`);
    lines.push(`| RSI(14) | ${r.rsi || '-'} |`);
    lines.push(`| EMA 20 | ${r.ema20 || '-'} |`);
    lines.push(`| EMA 50 | ${r.ema50 || '-'} |`);
    lines.push(`| MACD | ${r.macd ? `${r.macd.macd} (${r.macd.signal})` : '-'} |`);
    lines.push(`| Support | ${r.support || '-'} |`);
    lines.push(`| Resistance | ${r.resistance || '-'} |`);
    lines.push(`| **Signal** | **${r.signal}** |`);
    lines.push('');

    // Trade plan
    if (r.signal === 'ACHAT FORT' || r.signal === 'ACHAT') {
      lines.push(`**Plan de trade (ACHAT):**`);
      lines.push(`- Entree: ${r.price} - ${r.support ? Math.round((r.support + r.price) / 2 * 100) / 100 : r.price}`);
      lines.push(`- Stop loss: ${r.stopLoss || '-'}`);
      lines.push(`- TP1: ${r.tp1 || '-'} (resistance)`);
      lines.push(`- TP2: ${r.tp2 || '-'} (+3% au-dela)`);
      lines.push(`- Position: ${r.shares || '-'} actions (${r.shares ? Math.round(r.shares * r.price) + '$' : '-'})`);
      lines.push(`- Risque: ${r.shares && r.stopLoss ? Math.round(r.shares * Math.abs(r.price - r.stopLoss)) + '$' : '-'}`);
    } else if (r.signal === 'VENTE FORTE' || r.signal === 'VENTE') {
      lines.push(`**Plan de trade (VENTE/ATTENTE):**`);
      lines.push(`- Ne pas acheter. Attendre retour sur support ${r.support || '-'}`);
      lines.push(`- Si position ouverte: stop loss a ${r.ema20 || '-'} (EMA20)`);
    } else {
      lines.push(`**Plan de trade (NEUTRE):**`);
      lines.push(`- Pas de signal clair. Surveiller.`);
      lines.push(`- Achat si pullback vers ${r.support || '-'} avec RSI < 35`);
      lines.push(`- Achat si cassure au-dessus de ${r.resistance || '-'} avec volume`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push('## Regles du jour');
  lines.push('');
  lines.push('- Max 3 positions ouvertes simultanement');
  lines.push('- Risque max par trade: 300$ (3% de 10 000$)');
  lines.push('- Si 2 trades perdants consecutifs: STOP pour la journee');
  lines.push('- Toujours un stop loss defini AVANT d\'entrer');
  lines.push(`- Horaires TSX: 9h30 - 16h00 ET`);
  lines.push('');

  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
