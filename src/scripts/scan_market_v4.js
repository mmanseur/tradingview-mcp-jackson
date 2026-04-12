/**
 * Market Scanner V4 — Détection de setups BRK/PB sur l'univers TSX
 *
 * Parcourt scanner_universe.json (Watchlist + TSX 60),
 * lit les signaux BRK/PB de l'indicateur "Momentum V4 [BBD-B Backtest]"
 * sur Daily + 4h, filtre par volume > 100k, et génère un rapport.
 *
 * Prérequis:
 *   - TradingView lancé avec CDP port 9222
 *   - Indicateur "Momentum V4 [BBD-B Backtest]" présent sur le chart
 *
 * Exécution: node src/scripts/scan_market_v4.js
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as chart from '../core/chart.js';
import * as data from '../core/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

// ---------- Config ----------
const TIMEFRAMES = ['D', '240']; // Daily + 4h
const SLEEP_SYMBOL_MS = 1800;
const SLEEP_TIMEFRAME_MS = 1000;
const MIN_VOLUME = 100000;

// ---------- Load Universe ----------
const UNIVERSE_PATH = resolve(__dirname, 'scanner_universe.json');
const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));

// Merge watchlist + TSX60, remove duplicates
const allSymbols = [...new Set([...universe.watchlist, ...universe.tsx60])];

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

// ---------- Indicator Reader ----------
async function readMomentumV4() {
  const res = await data.getStudyValues();
  const studies = res?.studies || [];
  const study = studies.find((s) => /momentum\s*v4|unified\s*momentum/i.test(s.name));
  const v = study?.values;
  if (!v) return null;

  return {
    emaFast:      toNum(v['EMA Fast']),
    emaMid:       toNum(v['EMA Mid']),
    emaSlow:      toNum(v['EMA Slow']),
    donchianHi:   toNum(v['Donchian Hi']),
    donchianLo:   toNum(v['Donchian Lo']),
    chandelier:   toNum(v['Chandelier']),
    adx:          toNum(v['ADX']),
    BRK:          toNum(v['BRK'])  || 0,
    PB:           toNum(v['PB'])   || 0,
    ADD:          toNum(v['ADD'])  || 0,
    EXIT:         toNum(v['EXIT']) || 0,
    SELL:         toNum(v['SELL']) || 0,
    WEAK:         toNum(v['WEAK']) || 0,
    pyramidCount: toNum(v['Pyramid Count']) || 0,
    _variant:     (toNum(v['IsGoldPro']) || 0) > 0 ? 'gold-pro' : 'v4',
  };
}

// ---------- Score Calculation ----------
function calculateScore(daily, h4) {
  let score = 0;
  let factors = [];

  const dv = daily?.v4;
  const hv = h4?.v4;

  // Signal BRK = +3 points (breakout fort)
  if (dv?.BRK > 0) { score += 3; factors.push('BRK Daily'); }
  else if (hv?.BRK > 0) { score += 2; factors.push('BRK 4h'); }

  // Signal PB = +2 points (pullback achat)
  if (dv?.PB > 0) { score += 2; factors.push('PB Daily'); }
  else if (hv?.PB > 0) { score += 1; factors.push('PB 4h'); }

  // Alignement haussier
  if (daily?.alignedBull) { score += 2; factors.push('Align D'); }
  if (h4?.alignedBull) { score += 1; factors.push('Align 4h'); }

  // Structure Gold Pro (Donchian + ADX)
  if (dv?._variant === 'gold-pro' && dv?.adx > 25) { score += 1; factors.push('ADX>25'); }

  // Signal ADD (pyramiding)
  if (dv?.ADD > 0) { score += 1; factors.push('ADD'); }

  // Pénalités
  if (dv?.EXIT > 0) { score -= 3; factors.push('EXIT'); }
  if (dv?.SELL > 0) { score -= 3; factors.push('SELL'); }
  if (dv?.WEAK > 0) { score -= 1; factors.push('WEAK'); }
  if (daily?.alignedBear) { score -= 2; factors.push('Bear D'); }

  // Extension trop forte = pénalité
  if (daily?.extensionPct > 10) { score -= 1; factors.push('Ext>10%'); }

  return { score, factors };
}

// ---------- Analysis ----------
async function analyzeTicker(symbol) {
  const perTf = {};
  let hasVolume = false;

  for (const tf of TIMEFRAMES) {
    await chart.setTimeframe({ timeframe: tf });
    await sleep(SLEEP_TIMEFRAME_MS);

    const [quote, ohlcv, v4] = await Promise.all([
      data.getQuote({}),
      data.getOhlcv({ count: 60, summary: true }),
      readMomentumV4(),
    ]);

    // Volume filter (Daily only)
    if (tf === 'D' && ohlcv?.avg_volume) {
      hasVolume = ohlcv.avg_volume >= MIN_VOLUME;
    }

    const price = quote?.last || quote?.close;
    const alignedBull = v4?.emaFast && v4?.emaMid && v4?.emaSlow &&
      v4.emaFast > v4.emaMid && v4.emaMid > v4.emaSlow && price > v4.emaFast;
    const alignedBear = v4?.emaFast && v4?.emaMid && v4?.emaSlow &&
      v4.emaFast < v4.emaMid && v4.emaMid < v4.emaSlow && price < v4.emaFast;

    perTf[tf] = {
      price,
      volume: quote?.volume,
      avgVolume: ohlcv?.avg_volume,
      changePct: ohlcv?.change_pct,
      high: ohlcv?.high,
      low: ohlcv?.low,
      v4,
      alignedBull,
      alignedBear,
      extensionPct: price && v4?.emaFast ? ((price - v4.emaFast) / v4.emaFast) * 100 : null,
    };
  }

  const daily = perTf['D'];
  const h4 = perTf['240'];
  const { score, factors } = calculateScore(daily, h4);

  return {
    symbol,
    daily,
    h4,
    score,
    factors,
    hasVolume,
  };
}

// ---------- Main ----------
async function run() {
  const startedAt = new Date();
  const dateStr = startedAt.toISOString().split('T')[0];
  const timeStr = startedAt.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  console.log(`[${dateStr} ${timeStr}] Market Scanner V4 starting...`);
  console.log(`Universe: ${allSymbols.length} tickers (Watchlist ${universe.watchlist.length} + TSX60 ${universe.tsx60.length})`);
  console.log(`Volume min: ${MIN_VOLUME.toLocaleString()}`);
  console.log('');

  let originalState;
  try {
    originalState = await chart.getState();
  } catch (e) {
    console.error('ERROR: TradingView CDP not connected.');
    process.exit(1);
  }

  // Ensure Momentum V4 indicator is on chart
  console.log('Checking indicator...');
  const testValues = await readMomentumV4();
  if (!testValues) {
    console.error('ERROR: Indicator "Momentum V4" (ou "Unified Momentum Strategy") non trouvé sur le chart.');
    console.error('Veuillez ajouter l\'indicateur à votre graphique TradingView actif.');
    process.exit(1);
  }
  console.log('Indicator OK');
  console.log('');

  // Scan all tickers
  const results = [];
  let processed = 0;

  for (const symbol of allSymbols) {
    processed++;
    process.stdout.write(`[${processed}/${allSymbols.length}] ${symbol}... `);

    try {
      await chart.setSymbol({ symbol });
      await sleep(SLEEP_SYMBOL_MS);

      const analysis = await analyzeTicker(symbol);

      // Skip low volume
      if (!analysis.hasVolume) {
        console.log('SKIP (low volume)');
        continue;
      }

      // Only keep setups with score > 0
      if (analysis.score > 0) {
        console.log(`SCORE ${analysis.score} [${analysis.factors.join(', ')}]`);
        results.push(analysis);
      } else {
        console.log(`score ${analysis.score}`);
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Restore original state
  if (originalState?.symbol) {
    try {
      await chart.setSymbol({ symbol: originalState.symbol });
      if (originalState.resolution) await chart.setTimeframe({ timeframe: originalState.resolution });
    } catch (_) {}
  }

  console.log('');
  console.log(`Scan complete: ${results.length} setups found`);
  console.log('');

  // Generate report
  const md = generateMarkdown({ dateStr, timeStr, results });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = resolve(REPORTS_DIR, `scan_${dateStr}.md`);
  writeFileSync(filePath, md, 'utf8');
  console.log(`Report saved: ${filePath}`);

  // Git commit
  try {
    execSync('git add reports/', { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git commit -m "scan v4 ${dateStr} — ${results.length} setups"`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    console.log('Git commit: OK');
  } catch (e) {
    console.log('Git commit skipped:', e.message?.split('\n')[0]);
  }

  // Summary output
  console.log('');
  console.log('=== SCAN SUMMARY ===');
  console.log(`Date: ${dateStr} ${timeStr} ET`);
  console.log(`Setups detected: ${results.length}`);
  console.log('');

  if (results.length > 0) {
    console.log('TOP 3 SETUPS:');
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const r = results[i];
      const d = r.daily;
      console.log(`  ${i+1}. ${r.symbol} — Score ${r.score} [${r.factors.join(', ')}]`);
      console.log(`     Price: ${d.price} | BRK:${d.v4?.BRK || 0} PB:${d.v4?.PB || 0} | Vol: ${(d.avgVolume/1000).toFixed(0)}k`);
    }
  }

  console.log('');
  console.log('Done!');
}

function generateMarkdown({ dateStr, timeStr, results }) {
  const L = [];
  L.push(`# Scan Marché Momentum V4 — ${dateStr}`);
  L.push(`> Généré à ${timeStr} ET · ${results.length} setups détectés · Volume min: ${MIN_VOLUME.toLocaleString()}`);
  L.push('');

  // Summary stats
  const brkCount = results.filter(r => r.factors.some(f => f.includes('BRK'))).length;
  const pbCount = results.filter(r => r.factors.some(f => f.includes('PB'))).length;
  const goldProCount = results.filter(r => r.daily?.v4?._variant === 'gold-pro').length;

  L.push('## Résumé');
  L.push('');
  L.push(`| Métrique | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| Tickers scannés | ${allSymbols.length} |`);
  L.push(`| Setups détectés | **${results.length}** |`);
  L.push(`| Breakouts (BRK) | ${brkCount} |`);
  L.push(`| Pullbacks (PB) | ${pbCount} |`);
  L.push(`| Gold Pro setups | ${goldProCount} |`);
  L.push('');

  // Full results table
  if (results.length > 0) {
    L.push('## Tous les setups');
    L.push('');
    L.push('| Rang | Ticker | Score | Facteurs | Prix | BRK | PB | Alignement | Volume moy |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const d = r.daily;
      const h = r.h4;
      const emojis = r.factors.map(f => {
        if (f.includes('BRK')) return '🚀';
        if (f.includes('PB')) return '🎯';
        if (f.includes('EXIT') || f.includes('SELL')) return '🔴';
        if (f.includes('WEAK')) return '🟡';
        return '✓';
      }).join(' ');
      const align = d?.alignedBull ? '✅ D' : d?.alignedBear ? '❌ D' : '⚪';
      const align4h = h?.alignedBull ? '✅4h' : h?.alignedBear ? '❌4h' : '⚪';
      const volK = d?.avgVolume ? Math.round(d.avgVolume / 1000) + 'k' : '-';
      L.push(`| ${i+1} | **${r.symbol}** | **${r.score}** | ${emojis} ${r.factors.slice(0,3).join(', ')} | ${d?.price || '-'} | ${d?.v4?.BRK || 0} | ${d?.v4?.PB || 0} | ${align} ${align4h} | ${volK} |`);
    }
    L.push('');

    // Top 3 detailed
    L.push('---');
    L.push('## Top 3 Setups — Plans de trade');
    L.push('');

    for (let i = 0; i < Math.min(3, results.length); i++) {
      const r = results[i];
      const d = r.daily;
      const h = r.h4;
      const v = d?.v4;

      L.push(`### ${i+1}. ${r.symbol} — Score ${r.score}`);
      L.push('');
      L.push(`**Signaux détectés:** ${r.factors.join(', ')}`);
      L.push('');

      // Technical data
      L.push('| Indicateur | Daily | 4h |');
      L.push('|---|---|---|');
      L.push(`| Prix | ${d?.price || '-'} | ${h?.price || '-'} |`);
      L.push(`| EMA Fast/Mid/Slow | ${v?.emaFast || '-'} / ${v?.emaMid || '-'} / ${v?.emaSlow || '-'} | - |`);
      L.push(`| Donchian Hi/Lo | ${v?.donchianHi || '-'} / ${v?.donchianLo || '-'} | - |`);
      L.push(`| Chandelier | ${v?.chandelier || '-'} | - |`);
      L.push(`| ADX | ${v?.adx?.toFixed(1) || '-'} | - |`);
      L.push(`| Extension EMA | ${d?.extensionPct?.toFixed(1) || '-'}% | - |`);
      L.push('');

      // Trade plan
      if (v?.BRK > 0 || v?.PB > 0) {
        const entry = d?.price;
        const stop = v?.chandelier || v?.emaMid || (entry * 0.95);
        const target1 = v?.donchianHi || d?.high;
        const riskPerShare = Math.abs(entry - stop);
        const rewardPerShare = target1 ? Math.abs(target1 - entry) : 0;
        const rr = riskPerShare > 0 ? (rewardPerShare / riskPerShare).toFixed(1) : '-';

        L.push('**Plan de trade:**');
        L.push('');
        L.push(`| | Valeur |`);
        L.push(`|---|---|`);
        L.push(`| Direction | ${v?.BRK > 0 ? '🚀 BREAKOUT' : '🎯 PULLBACK'} |`);
        L.push(`| Entrée | ${entry} |`);
        L.push(`| Stop-loss | ${round(stop)} (Chandelier ou EMA Mid) |`);
        L.push(`| Cible | ${round(target1)} (Donchian Hi / High récent) |`);
        L.push(`| Risque/action | ${round(riskPerShare)} CAD |`);
        L.push(`| Reward/action | ${round(rewardPerShare)} CAD |`);
        L.push(`| Ratio R:R | **${rr}:1** |`);
        L.push('');

        // Position sizing for 10k capital
        const CAPITAL = 10000;
        const RISK_PCT = 0.03;
        const maxRisk = CAPITAL * RISK_PCT;
        const shares = riskPerShare > 0 ? Math.floor(maxRisk / riskPerShare) : 0;
        const positionValue = shares * entry;
        L.push(`**Sizing (Capital ${CAPITAL}$):**`);
        L.push(`- Max risque: ${maxRisk}$ (3%)`);
        L.push(`- Shares: ${shares} (${positionValue.toFixed(0)}$ position, ${((positionValue/CAPITAL)*100).toFixed(1)}% du capital)`);
        L.push('');
      }

      L.push('---');
      L.push('');
    }
  }

  // Watchlist status
  L.push('## Statut Watchlist Personnelle');
  L.push('');
  const wlSymbols = universe.watchlist;
  const wlResults = results.filter(r => wlSymbols.includes(r.symbol));
  if (wlResults.length > 0) {
    L.push(`**${wlResults.length} setup(s) détecté(s) dans la watchlist:**`);
    L.push('');
    for (const r of wlResults) {
      L.push(`- **${r.symbol}** — Score ${r.score} [${r.factors.join(', ')}]`);
    }
  } else {
    L.push('Aucun setup détecté dans la watchlist personnelle.');
  }
  L.push('');

  // Footer
  L.push('---');
  L.push('## Règles de trading');
  L.push('');
  L.push('- ⚠️ Max 3% de risque par trade');
  L.push('- ⚠️ Ne pas entrer si extension > 8% au-dessus EMA Fast');
  L.push('- ✅ BRK Daily + alignement = entrée agressive');
  L.push('- ✅ PB Daily + alignement = entrée conservatrice');
  L.push('- 🔴 EXIT ou SELL = sortie immédiate');
  L.push('');
  L.push(`_Scan généré par Market Scanner V4 · Source: TradingView + Momentum V4_`);

  return L.join('\n');
}

run().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
