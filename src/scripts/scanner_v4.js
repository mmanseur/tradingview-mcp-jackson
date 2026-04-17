/**
 * Portfolio Analyzer V4 — Analyse quotidienne des positions IBKR
 *
 * Lit les positions ouvertes depuis le panneau Trading IBKR de TradingView,
 * analyse chaque position sur Daily + 4h avec l'indicateur dédié à chaque
 * ticker (Momentum V4 par défaut, Gold Momentum Pro pour WPM/AEM), et génère
 * un rapport markdown avec recommandation par position.
 *
 * Prérequis:
 *   - TradingView lancé avec CDP port 9222
 *   - Panneau Trading IBKR ouvert (positions visibles)
 *   - Indicateurs "Momentum V4" ET "Gold Momentum Pro" présents sur le chart
 *
 * Exécution: node src/scripts/scanner_v4.js
 * Cron 9h00 lun-ven via Windows Task Scheduler (ClaudeScannerV4)
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as chart from '../core/chart.js';
import * as data from '../core/data.js';
import { sendReportEmail } from '../core/mailer.js';
import { readIbkrPositions, toTradingViewSymbol } from './ibkr_positions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

// ---------- Universe ----------
const universeData = JSON.parse(readFileSync(resolve(__dirname, 'scanner_universe.json'), 'utf8'));
const UNIVERSE_TICKERS = [...universeData.watchlist];

// ---------- Config ----------
const TIMEFRAMES = ['D', '240']; // Daily + 4h
const SLEEP_SYMBOL_MS = 1500;
const SLEEP_TIMEFRAME_MS = 900;
const RISK_PER_TRADE_PCT = 0.03; // 3% max de risque par position (pour sizing info)

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

// ---------- Indicator reader ----------
// Single unified indicator "Momentum V4 [BBD-B Backtest]" auto-switches logic:
//   WPM / AEM → Gold Momentum Pro (Donchian turtle, EMA 13/26/55)
//   Others    → Momentum V4       (EMA cross, EMA 8/21/50)
// The IsGoldPro data-window field = 1 signals which variant is active.
async function readIndicator() {
  const res = await data.getStudyValues();
  const studies = res?.studies || [];
  const study = studies.find((s) => /momentum\s*v4/i.test(s.name));
  const v = study?.values;
  if (!v) return null;

  const isGoldPro = (toNum(v['IsGoldPro']) || 0) > 0;
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
    _variant:     isGoldPro ? 'gold-pro' : 'v4',
  };
}

// Single indicator config — all tickers use the same reader.
// The indicator auto-detects the ticker and switches logic internally.
const INDICATOR_NAME = 'Momentum V4 [BBD-B Backtest]';

function getIndicatorFor(_tvSymbol) {
  return { name: INDICATOR_NAME, reader: readIndicator };
}

async function analyzeOne(symbol, timeframe, indicatorCfg) {
  await chart.setTimeframe({ timeframe });
  await sleep(SLEEP_TIMEFRAME_MS);

  const [quote, ohlcv, values] = await Promise.all([
    data.getQuote({}),
    data.getOhlcv({ count: 60, summary: true }),
    indicatorCfg.reader(),
  ]);

  const v = values;
  const indicatorUsed = indicatorCfg.name;
  if (!v) {
    return { timeframe, error: `Indicateur "${INDICATOR_NAME}" absent du chart — vérifier que l'indicateur est chargé` };
  }

  const price = quote?.last || quote?.close;
  const alignedBull =
    v.emaFast != null && v.emaMid != null && v.emaSlow != null &&
    v.emaFast > v.emaMid && v.emaMid > v.emaSlow && price > v.emaFast;
  const alignedBear =
    v.emaFast != null && v.emaMid != null && v.emaSlow != null &&
    v.emaFast < v.emaMid && v.emaMid < v.emaSlow && price < v.emaFast;
  const extensionPct = price && v.emaFast ? ((price - v.emaFast) / v.emaFast) * 100 : null;

  return {
    timeframe,
    price,
    volume: quote?.volume,
    high: quote?.high,
    low: quote?.low,
    avgVolume: ohlcv?.avg_volume,
    changePct: ohlcv?.change_pct,
    periodHigh: ohlcv?.high,
    periodLow: ohlcv?.low,
    v4: v, // conservé pour compatibilité nommage
    indicatorUsed,
    alignedBull,
    alignedBear,
    extensionPct,
  };
}

/**
 * Génère la recommandation pour une position en fonction de son état technique.
 * Retourne: { action, severity, reason, stop, target1, target2, riskPerShare, rewardPerShare }
 */
function buildRecommendation(position, daily, h4) {
  if (!position.avgPrice) return buildEntrySignal(daily, h4);
  const entry = position.avgPrice;
  const price = daily?.price || position.lastPrice;
  const v4d = daily?.v4;
  const pnlPct = entry ? ((price - entry) / entry) * 100 : 0;
  const isGoldPro = v4d?._variant === 'gold-pro';

  let action, severity, reason;
  let stop = null;
  let target1 = null;
  let target2 = null;

  // === Gold Momentum Pro — cas spécifiques (prennent priorité sur V4) ===
  if (isGoldPro) {
    // Gold Pro cas 1 : signal EXIT (chandelier ou Donchian Lo touché)
    if (v4d?.EXIT > 0) {
      action = 'EXIT';
      severity = 'high';
      reason = `Gold Pro EXIT actif: prix ${price} sous Donchian Lo ${v4d.donchianLo} ou Chandelier ${v4d.chandelier}. Tendance cassée.`;
      stop = round(price * 0.995);
    }
    // Gold Pro cas 2 : signal ADD (breakout Donchian 20j pendant position)
    else if (v4d?.ADD > 0 && v4d.pyramidCount < 2) {
      action = 'SCALE IN';
      severity = 'opportunity';
      reason = `Gold Pro ADD: cassure Donchian 20j, pyramid count ${v4d.pyramidCount}/2. Ajouter à la position.`;
      stop = round(v4d.chandelier);
      target1 = round(v4d.donchianHi);
    }
    // Gold Pro cas 3 : BRK fresh signal
    else if (v4d?.BRK > 0) {
      action = daily.price > daily.v4.donchianHi ? 'ADD' : 'BUY';
      severity = 'opportunity';
      reason = `Gold Pro BRK: cassure 55j Donchian (${v4d.donchianHi}). Setup turtle fort.`;
      stop = round(v4d.chandelier);
      target1 = round(daily.periodHigh);
    }
    // Gold Pro cas 4 : aligné haussier + position saine → HOLD avec stop chandelier/Donchian Lo
    else if (daily?.alignedBull) {
      action = 'HOLD';
      severity = pnlPct > 0 ? 'ok' : 'ok';
      reason = `Gold Pro: structure haussière intacte, ADX ${v4d?.adx?.toFixed(1)}. Let winners run.`;
      // Stop = le plus haut entre Chandelier et Donchian Lo (plus serré = plus protecteur)
      stop = round(Math.max(v4d.chandelier || 0, v4d.donchianLo || 0));
      target1 = round(v4d.donchianHi);
    }
    // Gold Pro cas 5 : signal WEAK
    else if (v4d?.WEAK > 0) {
      action = 'TIGHTEN STOP';
      severity = 'medium';
      reason = `Gold Pro WEAK: prix sous EMA Fast. Surveiller rapprochement du Chandelier ${v4d.chandelier}.`;
      stop = round(v4d.chandelier);
    }
    // Gold Pro fallback
    else {
      action = 'WATCH';
      severity = 'neutral';
      reason = `Gold Pro: aucun signal fort. ADX ${v4d?.adx?.toFixed(1)}. Surveillance.`;
      stop = round(v4d.chandelier);
    }
    const riskPerShare = stop && price ? round(price - stop) : null;
    const rewardPerShare = target1 && price ? round(target1 - price) : null;
    const rr = riskPerShare && rewardPerShare && riskPerShare > 0 ? round(rewardPerShare / riskPerShare, 1) : null;
    return { action, severity, reason, stop, target1, target2, riskPerShare, rewardPerShare, rr };
  }

  // === Momentum V4 — logique existante inchangée ===

  // Cas 1 : signal SELL explicite sur Daily
  if (v4d?.SELL > 0) {
    action = 'EXIT';
    severity = 'high';
    reason = 'Signal SELL actif sur Daily — sortie immédiate recommandée.';
    stop = round(price * 0.995);
  }
  // Cas 2 : structure baissière (EMA Fast < Mid < Slow ou prix sous EMA Slow)
  else if (daily?.alignedBear || (v4d && price < v4d.emaSlow)) {
    action = 'EXIT / REDUCE';
    severity = 'high';
    reason = `Structure baissière: prix ${price} sous EMA Slow ${v4d?.emaSlow}. Tendance de fond cassée.`;
    stop = round(v4d?.emaFast * 0.98);
  }
  // Cas 3 : signal WEAK ou prix sous EMA Fast (structure affaiblie)
  else if (v4d?.WEAK > 0 || (v4d && price < v4d.emaFast)) {
    action = 'TIGHTEN STOP';
    severity = 'medium';
    reason = `Structure affaiblie: prix ${price} sous EMA Fast ${v4d?.emaFast}. Protéger les gains.`;
    stop = round(v4d?.emaMid);
    target1 = round(daily?.periodHigh);
  }
  // Cas 4 : BRK ou PB actif et alignement haussier → ADD possible
  else if ((v4d?.BRK > 0 || v4d?.PB > 0) && daily?.alignedBull && daily?.extensionPct != null && daily.extensionPct < 5) {
    action = 'ADD';
    severity = 'opportunity';
    reason = `Signal ${v4d.BRK > 0 ? 'BRK (breakout)' : 'PB (pullback)'} actif avec alignement haussier. Extension ${daily.extensionPct.toFixed(1)}% acceptable.`;
    stop = round(v4d.emaSlow);
    target1 = round(daily.periodHigh);
    target2 = round(price * 1.08);
  }
  // Cas 5 : aligné haussier mais très étendu (> 10% au-dessus EMA Fast)
  else if (daily?.alignedBull && daily?.extensionPct != null && daily.extensionPct > 10) {
    action = 'TRIM / TRAIL';
    severity = 'medium';
    reason = `Position étendue de ${daily.extensionPct.toFixed(1)}% au-dessus EMA Fast. Risque de consolidation — sécuriser partiellement.`;
    stop = round(v4d?.emaFast);
    target1 = round(daily?.periodHigh);
  }
  // Cas 6 : aligné haussier, en profit → HOLD
  else if (daily?.alignedBull && pnlPct > 0) {
    action = 'HOLD';
    severity = 'ok';
    reason = `Tendance haussière intacte, P/L +${pnlPct.toFixed(1)}%. Laisser courir.`;
    stop = round(v4d?.emaMid);
    target1 = round(daily?.periodHigh);
  }
  // Cas 7 : aligné haussier mais en perte (mauvaise entrée, structure OK)
  else if (daily?.alignedBull && pnlPct <= 0) {
    action = 'HOLD';
    severity = 'ok';
    reason = `Structure haussière intacte malgré P/L ${pnlPct.toFixed(1)}% (mauvaise entrée). Pas de raison de sortir.`;
    stop = round(v4d?.emaSlow);
    target1 = round(daily?.periodHigh);
  }
  // Cas par défaut : neutre / surveiller
  else {
    action = 'WATCH';
    severity = 'neutral';
    reason = 'Structure neutre — pas de signal fort, surveillance active.';
    stop = round(v4d?.emaSlow);
  }

  const riskPerShare = stop && price ? round(price - stop) : null;
  const rewardPerShare = target1 && price ? round(target1 - price) : null;
  const rr = riskPerShare && rewardPerShare && riskPerShare > 0 ? round(rewardPerShare / riskPerShare, 1) : null;

  return { action, severity, reason, stop, target1, target2, riskPerShare, rewardPerShare, rr };
}

/**
 * Signal d'entrée pour un ticker de la watchlist sans position IBKR.
 */
function buildEntrySignal(daily, h4) {
  const price = daily?.price;
  const v4d = daily?.v4;
  let action = 'WATCH', severity = 'neutral', reason = 'Aucun signal fort.';
  let stop = null, target1 = null, target2 = null;

  if (!v4d) {
    return { action: 'N/A', severity: 'neutral', reason: 'Indicateur absent du chart', stop: null, target1: null, target2: null, riskPerShare: null, rewardPerShare: null, rr: null };
  }

  const isGoldPro = v4d._variant === 'gold-pro';
  const h4Bull = h4?.alignedBull;

  if (isGoldPro) {
    if (v4d.BRK > 0 && daily.alignedBull) {
      action = 'BUY'; severity = 'opportunity';
      reason = `Gold Pro BRK: cassure Donchian 55j (${v4d.donchianHi}). Confirm 4h: ${h4Bull ? 'Oui' : 'Non'}.`;
      stop = round(v4d.chandelier); target1 = round(v4d.donchianHi);
    } else if (daily.alignedBull) {
      action = 'WATCH'; severity = 'neutral';
      reason = `Gold Pro: structure haussière, pas de signal BRK. ADX ${v4d.adx?.toFixed(1)}.`;
      stop = round(v4d.chandelier);
    } else {
      action = 'EVITER'; severity = 'high';
      reason = `Gold Pro: pas de structure haussière.`;
    }
  } else {
    if (v4d.BRK > 0 && daily.alignedBull && (daily.extensionPct == null || daily.extensionPct < 8)) {
      action = 'BUY'; severity = 'opportunity';
      reason = `BRK breakout + alignement haussier. Extension ${daily.extensionPct?.toFixed(1) ?? '-'}%. ${h4Bull ? 'Confirmé 4h.' : '4h non aligné.'}`;
      stop = round(v4d.emaSlow); target1 = round(daily.periodHigh); target2 = round(price * 1.08);
    } else if (v4d.PB > 0 && daily.alignedBull) {
      action = 'BUY PB'; severity = 'opportunity';
      reason = `Pullback sur structure haussière. Setup optimal. ${h4Bull ? 'Aligné 4h.' : '4h non aligné.'}`;
      stop = round(v4d.emaSlow); target1 = round(daily.periodHigh);
    } else if (daily.alignedBull) {
      action = 'WATCH'; severity = 'neutral';
      reason = `Structure haussière sans signal BRK/PB actif.`;
      stop = round(v4d.emaSlow); target1 = round(daily.periodHigh);
    } else if (daily.alignedBear || v4d.SELL > 0) {
      action = 'EVITER'; severity = 'high';
      reason = `Structure baissière ou signal SELL actif.`;
    }
  }

  const riskPerShare = stop && price ? round(price - stop) : null;
  const rewardPerShare = target1 && price ? round(target1 - price) : null;
  const rr = riskPerShare && rewardPerShare && riskPerShare > 0 ? round(rewardPerShare / riskPerShare, 1) : null;
  return { action, severity, reason, stop, target1, target2, riskPerShare, rewardPerShare, rr };
}

function scoreSignal(daily, h4) {
  const v = daily?.v4;
  if (!v) return 0;
  let score = 0;
  if (v.BRK > 0) score += 3;
  if (v.PB > 0) score += 2;
  if (daily.alignedBull) score += 1;
  if (h4?.v4?.BRK > 0 || h4?.v4?.PB > 0) score += 1;
  if (h4?.alignedBull) score += 0.5;
  return score;
}

function severityEmoji(sev) {
  return { high: '🔴', medium: '🟡', opportunity: '🟢', ok: '✅', neutral: '⚪' }[sev] || '⚪';
}

// ---------- Main ----------
async function run() {
  const startedAt = new Date();
  const dateStr = startedAt.toISOString().split('T')[0];
  const timeStr = startedAt.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });
  console.log(`[${dateStr} ${timeStr}] Portfolio Analyzer V4 starting...`);

  let originalState;
  try {
    originalState = await chart.getState();
  } catch (e) {
    console.error('ERROR: TradingView CDP not connected.');
    process.exit(1);
  }

  // 1. Lire les positions IBKR (non-bloquant)
  console.log('Lecture des positions IBKR...');
  let ibkrPositions = [];
  try {
    ibkrPositions = await readIbkrPositions();
  } catch (e) {
    console.log(`IBKR positions indisponibles: ${e.message}`);
  }
  const ibkrMap = new Map(ibkrPositions.map((p) => [toTradingViewSymbol(p), p]));
  console.log(`${ibkrPositions.length} position(s) IBKR détectée(s)`);
  ibkrPositions.forEach((p) => console.log(`  - ${toTradingViewSymbol(p)} ${p.side} ${p.qty} @ ${p.avgPrice}`));

  // 2. Construire la liste complète : univers watchlist + TSX60 (positions IBKR prioritaires)
  const scanTickers = UNIVERSE_TICKERS;
  console.log(`\nUnivers: ${scanTickers.length} tickers à analyser`);

  // 3. Analyser chaque ticker sur D + 4h
  const analyses = [];
  for (const tvSymbol of scanTickers) {
    const ibkrPos = ibkrMap.get(tvSymbol) || null;
    const position = ibkrPos || {
      symbol: tvSymbol.split(':')[1],
      exchange: tvSymbol.split(':')[0],
      side: null, qty: 0, avgPrice: null, lastPrice: null,
      changePct: null, unrealizedPnl: null, dailyPnl: null, positionId: null,
    };
    const isIbkr = !!ibkrPos;
    const indicatorCfg = getIndicatorFor(tvSymbol);
    console.log(`\n${isIbkr ? '[IBKR]' : '      '} ${tvSymbol}...`);
    try {
      await chart.setSymbol({ symbol: tvSymbol });
      await sleep(SLEEP_SYMBOL_MS);

      const perTf = {};
      for (const tf of TIMEFRAMES) {
        perTf[tf] = await analyzeOne(tvSymbol, tf, indicatorCfg);
      }

      const daily = perTf['D'];
      const h4 = perTf['240'];
      const recommendation = buildRecommendation(position, daily, h4);
      const score = scoreSignal(daily, h4);

      analyses.push({ position, tvSymbol, isIbkr, indicatorName: indicatorCfg.name, daily, h4, recommendation, score });
      console.log(`  → ${recommendation.action} (score: ${score})`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      analyses.push({ position, tvSymbol, isIbkr, indicatorName: indicatorCfg.name, error: err.message, score: 0 });
    }
  }

  // 3. Restaurer l'état original
  if (originalState?.symbol) {
    try {
      await chart.setSymbol({ symbol: originalState.symbol });
      if (originalState.resolution) await chart.setTimeframe({ timeframe: originalState.resolution });
    } catch (_) {}
  }

  // 4. Générer le rapport
  const ibkrAnalyses = analyses.filter((a) => a.isIbkr);
  const watchlistAnalyses = analyses.filter((a) => !a.isIbkr).sort((a, b) => b.score - a.score);
  const md = renderMarkdown({ dateStr, timeStr, ibkrAnalyses, watchlistAnalyses });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = resolve(REPORTS_DIR, `scan_${dateStr}.md`);
  writeFileSync(filePath, md, 'utf8');
  console.log(`\nRapport sauvegardé: ${filePath}`);

  // 5. Commit auto
  const setups = analyses.filter((a) => ['BUY', 'BUY PB'].includes(a.recommendation?.action)).length;
  try {
    execSync('git add reports/', { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git commit -m "scan v4 ${dateStr} — ${ibkrAnalyses.length} positions, ${setups} setups"`, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    console.log('Git commit: OK');
  } catch (e) {
    console.log('Git commit skipped:', e.message?.split('\n')[0]);
  }

  // 6. Email systématique (rapport quotidien, plus d'alertes-only)
  try {
    const critical = ibkrAnalyses.filter((a) => a.recommendation?.severity === 'high').length;
    const preview = `${ibkrAnalyses.length} position(s) IBKR · 🟢 ${setups} setups BUY · 🔴 ${critical} critique(s)`;
    const subjectTag = critical > 0 ? '🔴' : setups > 0 ? '🟢' : '✅';
    const r = await sendReportEmail({
      subject: `[Scan V4] ${subjectTag} ${dateStr} — ${ibkrAnalyses.length} pos · ${setups} setups`,
      reportPath: filePath,
      previewText: preview,
    });
    if (r.sent) console.log(`Email envoyé: ${r.messageId}`);
    else console.log(`Email non envoyé: ${r.reason}`);
  } catch (e) {
    console.log(`Email erreur: ${e.message}`);
  }

  console.log('Done!');
}

function renderTechnicalTable(d, h) {
  const L = [];
  const isGold = d?.v4?._variant === 'gold-pro';
  if (isGold) {
    L.push('| TF | Prix | EMA F/M/S | Aligné | ADX | Donchian Hi/Lo | Chandelier | BRK | PB | ADD | EXIT | Pyr |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [tfLabel, tfData] of [['Daily', d], ['4h', h]]) {
      if (!tfData || tfData.error) { L.push(`| ${tfLabel} | - | - | - | - | - | - | - | - | - | - | ${tfData?.error || '-'} |`); continue; }
      const v = tfData.v4;
      const emas = v ? `${v.emaFast} / ${v.emaMid} / ${v.emaSlow}` : '-';
      const aligned = tfData.alignedBull ? '✅' : tfData.alignedBear ? '❌' : '⚪';
      const donch = v ? `${v.donchianHi} / ${v.donchianLo}` : '-';
      L.push(`| ${tfLabel} | ${tfData.price} | ${emas} | ${aligned} | ${v?.adx?.toFixed(1) || '-'} | ${donch} | ${v?.chandelier || '-'} | ${v?.BRK || 0} | ${v?.PB || 0} | ${v?.ADD || 0} | ${v?.EXIT || 0} | ${v?.pyramidCount || 0}/2 |`);
    }
  } else {
    L.push('| TF | Prix | EMA F/M/S | Aligné | BRK | PB | SELL | Ext% |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const [tfLabel, tfData] of [['Daily', d], ['4h', h]]) {
      if (!tfData || tfData.error) { L.push(`| ${tfLabel} | - | - | - | - | - | - | ${tfData?.error || '-'} |`); continue; }
      const emas = tfData.v4 ? `${tfData.v4.emaFast} / ${tfData.v4.emaMid} / ${tfData.v4.emaSlow}` : '-';
      const aligned = tfData.alignedBull ? '✅ Haussier' : tfData.alignedBear ? '❌ Baissier' : '⚪ Neutre';
      const ext = tfData.extensionPct != null ? tfData.extensionPct.toFixed(1) + '%' : '-';
      L.push(`| ${tfLabel} | ${tfData.price} | ${emas} | ${aligned} | ${tfData.v4?.BRK || 0} | ${tfData.v4?.PB || 0} | ${tfData.v4?.SELL || 0} | ${ext} |`);
    }
  }
  return L;
}

function renderRecoTable(r, p) {
  const L = [];
  L.push('| | |');
  L.push('|---|---|');
  if (r.stop != null) {
    const stopLoss = p?.avgPrice ? round((r.stop - p.avgPrice) * p.qty) : null;
    const stopStr = stopLoss != null ? ` (si touché, P/L = ${stopLoss >= 0 ? '+' : ''}${stopLoss} CAD)` : '';
    L.push(`| Stop-loss suggéré | **${r.stop}**${stopStr} |`);
  }
  if (r.target1 != null) L.push(`| Cible 1 | ${r.target1} |`);
  if (r.target2 != null) L.push(`| Cible 2 | ${r.target2} |`);
  if (r.riskPerShare != null) L.push(`| Risque/action | ${r.riskPerShare} CAD |`);
  if (r.rewardPerShare != null) L.push(`| Reward/action | ${r.rewardPerShare} CAD |`);
  if (r.rr != null) L.push(`| Ratio R:R | **${r.rr}:1** |`);
  return L;
}

function renderMarkdown({ dateStr, timeStr, ibkrAnalyses, watchlistAnalyses }) {
  const L = [];
  const totalAnalyses = ibkrAnalyses.length + watchlistAnalyses.length;
  const setups = watchlistAnalyses.filter((a) => ['BUY', 'BUY PB'].includes(a.recommendation?.action));

  L.push(`# Scan Momentum V4 — ${dateStr}`);
  L.push(`> Généré à ${timeStr} ET · ${totalAnalyses} tickers · ${ibkrAnalyses.length} positions IBKR · ${setups.length} setups BUY · Multi-TF Daily + 4h`);
  L.push('');

  // ── Section 1 : Positions IBKR ──────────────────────────────────────────
  L.push('## Positions IBKR');
  L.push('');
  if (ibkrAnalyses.length === 0) {
    L.push('> ⚠️ Aucune position IBKR détectée — panneau Trading ouvert ?');
  } else {
    const totalCost  = ibkrAnalyses.reduce((s, a) => s + (a.position.avgPrice * a.position.qty || 0), 0);
    const totalValue = ibkrAnalyses.reduce((s, a) => s + (a.position.lastPrice * a.position.qty || 0), 0);
    const totalPnl   = ibkrAnalyses.reduce((s, a) => s + (a.position.unrealizedPnl || 0), 0);
    const totalDaily = ibkrAnalyses.reduce((s, a) => s + (a.position.dailyPnl || 0), 0);
    L.push(`| Métrique | Valeur |`);
    L.push(`|---|---|`);
    L.push(`| Positions | **${ibkrAnalyses.length}** |`);
    L.push(`| Coût total | ${round(totalCost)} CAD |`);
    L.push(`| Valeur marché | ${round(totalValue)} CAD |`);
    L.push(`| P/L latent | **${round(totalPnl) >= 0 ? '+' : ''}${round(totalPnl)} CAD** |`);
    L.push(`| P/L du jour | ${round(totalDaily) >= 0 ? '+' : ''}${round(totalDaily)} CAD |`);
    L.push('');
    L.push('| Ticker | Qty | Avg | Last | P/L CAD | P/L % | Signal D | 4h | Action |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const a of ibkrAnalyses) {
      const p = a.position;
      const emoji = a.error ? '❌' : severityEmoji(a.recommendation?.severity);
      if (a.error) { L.push(`| **${a.tvSymbol}** | ${p.qty} | ${p.avgPrice} | - | - | - | - | - | ERROR |`); continue; }
      const pnlPct = p.avgPrice ? ((p.lastPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1) : '-';
      const v4d = a.daily?.v4;
      const dSig = v4d?.BRK > 0 ? 'BRK' : v4d?.PB > 0 ? 'PB' : v4d?.ADD > 0 ? 'ADD' : v4d?.EXIT > 0 ? 'EXIT' : v4d?.SELL > 0 ? 'SELL' : v4d?.WEAK > 0 ? 'WEAK' : '-';
      const h4Al = a.h4?.alignedBull ? '✅' : a.h4?.alignedBear ? '❌' : '⚪';
      const pnlStr = p.unrealizedPnl != null ? `${p.unrealizedPnl >= 0 ? '+' : ''}${p.unrealizedPnl}` : '-';
      L.push(`| **${a.tvSymbol}** | ${p.qty} | ${p.avgPrice} | ${p.lastPrice} | ${pnlStr} | ${pnlPct}% | ${dSig} | ${h4Al} | ${emoji} **${a.recommendation.action}** |`);
    }
    L.push('');
    L.push('### Détails positions IBKR');
    L.push('');
    for (const a of ibkrAnalyses) {
      if (a.error) { L.push(`#### ${a.tvSymbol} — ERREUR\n\`${a.error}\`\n`); continue; }
      const p = a.position; const r = a.recommendation;
      const pnlPct = p.avgPrice ? ((p.lastPrice - p.avgPrice) / p.avgPrice * 100).toFixed(2) : '-';
      const emoji = severityEmoji(r.severity);
      L.push(`#### ${emoji} ${a.tvSymbol} — ${r.action}`);
      L.push('');
      L.push(`**Position:** ${p.side} ${p.qty} @ ${p.avgPrice} · Dernier: ${p.lastPrice} · P/L: **${p.unrealizedPnl >= 0 ? '+' : ''}${p.unrealizedPnl} CAD** (${pnlPct}%) · Jour: ${p.dailyPnl >= 0 ? '+' : ''}${p.dailyPnl} CAD`);
      L.push('');
      L.push(...renderTechnicalTable(a.daily, a.h4));
      L.push('');
      L.push(`> ${emoji} **${r.action}** — ${r.reason}`);
      L.push('');
      L.push(...renderRecoTable(r, p));
      L.push('');
      L.push('---');
      L.push('');
    }
  }

  // ── Section 2 : Top setups watchlist ────────────────────────────────────
  L.push('## Top Setups Watchlist');
  L.push('');
  const topSetups = watchlistAnalyses.filter((a) => !a.error && a.score > 0).slice(0, 20);
  if (topSetups.length === 0) {
    L.push('> Aucun setup BRK/PB détecté dans l\'univers aujourd\'hui.');
  } else {
    L.push(`| # | Ticker | Signal D | Score | Aligné 4h | Action | Stop | Cible 1 | R:R |`);
    L.push(`|---|---|---|---|---|---|---|---|---|`);
    topSetups.forEach((a, i) => {
      const v4d = a.daily?.v4;
      const dSig = v4d?.BRK > 0 ? 'BRK' : v4d?.PB > 0 ? 'PB' : '-';
      const h4Al = a.h4?.alignedBull ? '✅' : a.h4?.alignedBear ? '❌' : '⚪';
      const emoji = severityEmoji(a.recommendation.severity);
      const r = a.recommendation;
      L.push(`| ${i + 1} | **${a.tvSymbol}** | ${dSig} | ${a.score} | ${h4Al} | ${emoji} **${r.action}** | ${r.stop ?? '-'} | ${r.target1 ?? '-'} | ${r.rr ? r.rr + ':1' : '-'} |`);
    });
    L.push('');
    L.push('### Détails top setups');
    L.push('');
    for (const a of topSetups) {
      const r = a.recommendation; const emoji = severityEmoji(r.severity);
      L.push(`#### ${emoji} ${a.tvSymbol} — ${r.action} (score: ${a.score})`);
      L.push('');
      L.push(...renderTechnicalTable(a.daily, a.h4));
      L.push('');
      L.push(`> ${emoji} **${r.action}** — ${r.reason}`);
      L.push('');
      L.push(...renderRecoTable(r, null));
      L.push('');
      L.push('---');
      L.push('');
    }
  }

  // Footer
  L.push('## Règles du jour');
  L.push('');
  L.push('- Max 3% de risque par position');
  L.push('- Entrée BRK/PB uniquement si extension < 8% au-dessus EMA Fast');
  L.push('- EXIT immédiat si signal SELL ou prix < EMA Slow');
  L.push('');
  L.push(`_Scan V4 · ${totalAnalyses} tickers · TradingView + IBKR Live_`);
  return L.join('\n');
}

run().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
