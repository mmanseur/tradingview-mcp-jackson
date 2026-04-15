/**
 * Strategy Optimizer Agent — Optimise Momentum V4 + Gold Momentum Pro
 *
 * Claude analyse les paramètres, lance des backtests via Yahoo Finance,
 * itère pour trouver les meilleurs paramètres, et génère le Pine Script amélioré.
 *
 * Outils:
 *   • read_strategy      — lit le code Pine Script actuel
 *   • run_backtest_v4    — backtest Momentum V4 avec paramètres personnalisés
 *   • run_backtest_gold  — backtest Gold Momentum Pro avec paramètres personnalisés
 *   • save_pine_script   — sauvegarde le Pine Script amélioré
 *
 * Usage: node src/scripts/strategy-optimizer.js
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

// Charge .env
{
  const envPath = resolve(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  }
}

// ─── Fetch Yahoo Finance ─────────────────────────────────────
function fetchYahoo(symbol, range = '3y') {
  return new Promise((res, rej) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try {
          const result = JSON.parse(body).chart.result[0];
          const ts = result.timestamp;
          const q = result.indicators.quote[0];
          const bars = [];
          for (let i = 0; i < ts.length; i++) {
            if (!q.close[i]) continue;
            bars.push({
              date: new Date(ts[i] * 1000).toISOString().split('T')[0],
              open: q.open[i], high: q.high[i], low: q.low[i],
              close: q.close[i], volume: q.volume[i] || 0,
            });
          }
          res(bars);
        } catch (e) { rej(new Error(`Parse error ${symbol}: ${e.message}`)); }
      });
      r.on('error', rej);
    }).on('error', rej);
  });
}

// ─── Indicateurs ─────────────────────────────────────────────
function ema(data, period) {
  const out = new Array(data.length).fill(null);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < data.length; i++) out[i] = data[i] * k + out[i - 1] * (1 - k);
  return out;
}

function sma(data, period) {
  const out = new Array(data.length).fill(null);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) { sum += data[i] - data[i - period]; out[i] = sum / period; }
  return out;
}

function atrFn(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  let sum = 0;
  for (let i = 0; i < period && i < tr.length; i++) sum += tr[i];
  if (tr.length >= period) {
    out[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) out[i] = (out[i-1] * (period-1) + tr[i]) / period;
  }
  return out;
}

function adxFn(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period * 2 + 1) return out;
  const plusDM = [0], minusDM = [0], tr = [0];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  let sTR = 0, sPDM = 0, sMDM = 0;
  for (let i = 1; i <= period; i++) { sTR += tr[i]; sPDM += plusDM[i]; sMDM += minusDM[i]; }
  const dx = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      sTR = sTR - sTR/period + tr[i];
      sPDM = sPDM - sPDM/period + plusDM[i];
      sMDM = sMDM - sMDM/period + minusDM[i];
    }
    const pdi = sTR > 0 ? sPDM/sTR*100 : 0;
    const mdi = sTR > 0 ? sMDM/sTR*100 : 0;
    dx.push({ idx: i, dx: (pdi+mdi) > 0 ? Math.abs(pdi-mdi)/(pdi+mdi)*100 : 0 });
  }
  if (dx.length >= period) {
    let adxSum = 0;
    for (let j = 0; j < period; j++) adxSum += dx[j].dx;
    let adxVal = adxSum / period;
    out[dx[period-1].idx] = adxVal;
    for (let j = period; j < dx.length; j++) {
      adxVal = (adxVal*(period-1) + dx[j].dx) / period;
      out[dx[j].idx] = adxVal;
    }
  }
  return out;
}

function round2(v) { return Math.round(v * 100) / 100; }

// ─── Backtest Momentum V4 ────────────────────────────────────
function backtestV4(bars, params = {}) {
  const {
    emaFast = 8, emaMid = 21, emaSlow = 50,
    volMult = 1.3,          // volume minimum vs 20j SMA
    atrStopMult = 1.8,      // stop = entrée - ATR * mult
    tp1R = 2.5,             // TP1 = entrée + ATR * stopMult * tp1R
    tp2R = 5.0,             // TP2 = entrée + ATR * stopMult * tp2R
    cooldown = 3,           // bars d'attente après signal
    pyramiding = 3,         // max positions ouvertes
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const ef  = ema(closes, emaFast);
  const em  = ema(closes, emaMid);
  const es  = ema(closes, emaSlow);
  const atrV= atrFn(highs, lows, closes, 14);
  const volSma = sma(vols, 20);

  const warmup = Math.max(emaSlow, 60);
  let equity = initialCapital;
  let position = null; // { shares, entry, stop, tp1, tp2, tp1Hit }
  let barsSinceSignal = cooldown;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], h = highs[i], l = lows[i];
    const curATR = atrV[i] || atrV[i-1] || 1;
    const bullAlign = ef[i] > em[i] && em[i] > es[i];
    const bearAlign = ef[i] < em[i] && em[i] < es[i];
    const volOk = vols[i] >= (volSma[i] || 0) * volMult;
    const aboveAll = c > ef[i] && c > em[i] && c > es[i];
    const bullCandle = c > bars[i].open && c > ef[i];
    const crossUp = ef[i] > em[i] && ef[i-1] <= em[i-1];
    const crossDn = ef[i] < em[i] && ef[i-1] >= em[i-1];

    barsSinceSignal++;

    if (position) {
      // Mise à jour peak equity
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      // Stop loss
      if (l <= position.stop) {
        const pnl = (position.stop - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'stop', entry: position.entry, exit: position.stop, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
        barsSinceSignal = 0;
        continue;
      }
      // TP1 (50%)
      if (!position.tp1Hit && h >= position.tp1) {
        const halfShares = Math.floor(position.shares / 2);
        const pnl = (position.tp1 - position.entry) * halfShares;
        equity += pnl;
        position.shares -= halfShares;
        position.tp1Hit = true;
        position.stop = position.entry; // breakeven
        trades.push({ date: bars[i].date, type: 'tp1', entry: position.entry, exit: position.tp1, pnl: round2(pnl), bars: i - position.entryBar });
      }
      // TP2
      if (h >= position.tp2) {
        const pnl = (position.tp2 - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'tp2', entry: position.entry, exit: position.tp2, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
        barsSinceSignal = 0;
        continue;
      }
      // Signal de vente
      if (bearAlign && volOk && bars[i].open > bars[i].close && c < ef[i] && crossDn) {
        const pnl = (c - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'sell', entry: position.entry, exit: c, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
        barsSinceSignal = 0;
      }
    } else {
      // Signal d'entrée BRK
      const brkRaw = bullAlign && volOk && bullCandle && aboveAll && crossUp;
      if (brkRaw && barsSinceSignal >= cooldown) {
        const stop = c - curATR * atrStopMult;
        const tp1  = c + curATR * atrStopMult * tp1R;
        const tp2  = c + curATR * atrStopMult * tp2R;
        const riskPerShare = c - stop;
        if (riskPerShare > 0) {
          const riskAmt = equity * 0.10; // 10% du capital risqué par trade
          const shares = Math.floor(riskAmt / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, stop, tp1, tp2, tp1Hit: false, entryBar: i };
            barsSinceSignal = 0;
          }
        }
      }
    }
  }

  // Ferme position ouverte
  if (position) {
    const lastPrice = closes[bars.length - 1];
    const pnl = (lastPrice - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length - 1].date, type: 'open', entry: position.entry, exit: lastPrice, pnl: round2(pnl) });
  }

  return summarize(trades, initialCapital, equity, maxDD);
}

// ─── Backtest Gold Momentum Pro ──────────────────────────────
function backtestGold(bars, params = {}) {
  const {
    emaFast = 13, emaMid = 26, emaSlow = 55,
    entryLookback = 55,   // Donchian entrée
    addLookback = 20,     // Donchian add
    exitLookback = 20,    // Donchian sortie
    chandelierLen = 22,   // Chandelier lookback
    chandelierMult = 4.5, // Chandelier ATR mult
    adxThreshold = 20,
    maxAdds = 2,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const ef  = ema(closes, emaFast);
  const em  = ema(closes, emaMid);
  const es  = ema(closes, emaSlow);
  const atrV= atrFn(highs, lows, closes, 14);
  const adxV= adxFn(highs, lows, closes, 14);

  // Donchian channels (shifted 1 bar comme Pine: high[1])
  function highest(arr, len, shift = 1) {
    const out = new Array(arr.length).fill(null);
    for (let i = len + shift - 1; i < arr.length; i++) {
      let max = -Infinity;
      for (let j = i - shift - len + 1; j <= i - shift; j++) if (arr[j] > max) max = arr[j];
      out[i] = max;
    }
    return out;
  }
  function lowest(arr, len, shift = 1) {
    const out = new Array(arr.length).fill(null);
    for (let i = len + shift - 1; i < arr.length; i++) {
      let min = Infinity;
      for (let j = i - shift - len + 1; j <= i - shift; j++) if (arr[j] < min) min = arr[j];
      out[i] = min;
    }
    return out;
  }
  function highestCurrent(arr, len) {
    const out = new Array(arr.length).fill(null);
    for (let i = len - 1; i < arr.length; i++) {
      let max = -Infinity;
      for (let j = i - len + 1; j <= i; j++) if (arr[j] > max) max = arr[j];
      out[i] = max;
    }
    return out;
  }

  const entryHigh = highest(highs, entryLookback);
  const addHigh   = highest(highs, addLookback);
  const exitLow   = lowest(lows, exitLookback);
  const chanHigh  = highestCurrent(highs, chandelierLen);

  const warmup = Math.max(emaSlow, entryLookback + 5, 80);
  let equity = initialCapital;
  let inPos = false, adds = 0, entryBar = 0;
  let totalShares = 0, avgEntry = 0;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], h = highs[i], l = lows[i];
    const curATR = atrV[i] || 1;
    const adxOk = (adxV[i] || 0) > adxThreshold;
    const bullAlign = ef[i] > em[i] && em[i] > es[i];
    const chandelier = chanHigh[i] - curATR * chandelierMult;

    if (inPos) {
      const mktVal = equity + (c - avgEntry) * totalShares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      // Exit: Donchian Lo cassé ou Chandelier cassé
      const exitLowVal = exitLow[i];
      const exitSignal = exitLowVal && (l <= exitLowVal || l <= chandelier);
      if (exitSignal) {
        const exitPx = exitLowVal ? Math.max(Math.min(exitLowVal, chandelier), l) : l;
        const pnl = (exitPx - avgEntry) * totalShares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'exit', entry: round2(avgEntry), exit: round2(exitPx), pnl: round2(pnl), bars: i - entryBar });
        inPos = false; adds = 0; totalShares = 0;
        continue;
      }
      // Add: nouveau breakout Donchian 20j
      const addHighVal = addHigh[i];
      if (addHighVal && c > addHighVal && adxOk && adds < maxAdds) {
        const newShares = Math.floor(equity * 0.10 / (curATR * 2));
        if (newShares > 0) {
          avgEntry = (avgEntry * totalShares + c * newShares) / (totalShares + newShares);
          totalShares += newShares;
          adds++;
          trades.push({ date: bars[i].date, type: 'add', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    } else {
      const entryHighVal = entryHigh[i];
      // Breakout Donchian 55j
      if (entryHighVal && c > entryHighVal && bullAlign && adxOk) {
        const shares = Math.floor(equity * 0.10 / (curATR * 2));
        if (shares > 0) {
          inPos = true; adds = 0; entryBar = i;
          totalShares = shares; avgEntry = c;
          trades.push({ date: bars[i].date, type: 'brk', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
      // Pullback sur EMA Fast après breakout
      else if (entryHighVal && c > ef[i] && l < ef[i] && c > entryHighVal * 0.98 && bullAlign && adxOk) {
        const shares = Math.floor(equity * 0.10 / (curATR * 2));
        if (shares > 0) {
          inPos = true; adds = 0; entryBar = i;
          totalShares = shares; avgEntry = c;
          trades.push({ date: bars[i].date, type: 'pb', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    }
  }

  if (inPos) {
    const lastPrice = closes[bars.length - 1];
    const pnl = (lastPrice - avgEntry) * totalShares;
    equity += pnl;
    trades.push({ date: bars[bars.length - 1].date, type: 'open', entry: round2(avgEntry), exit: round2(lastPrice), pnl: round2(pnl) });
  }

  return summarize(trades, initialCapital, equity, maxDD);
}

// ─── Résumé backtest ─────────────────────────────────────────
function summarize(trades, initialCapital, finalEquity, maxDD) {
  const closed = trades.filter(t => t.pnl !== 0 && t.type !== 'add');
  const winners = closed.filter(t => t.pnl > 0);
  const losers  = closed.filter(t => t.pnl < 0);
  const totalPnl = finalEquity - initialCapital;
  const returnPct = round2(totalPnl / initialCapital * 100);
  const winRate = closed.length > 0 ? round2(winners.length / closed.length * 100) : 0;
  const avgWin  = winners.length > 0 ? round2(winners.reduce((s,t) => s+t.pnl, 0) / winners.length) : 0;
  const avgLoss = losers.length  > 0 ? round2(Math.abs(losers.reduce((s,t) => s+t.pnl, 0) / losers.length)) : 1;
  const profitFactor = avgLoss > 0 ? round2((avgWin * winners.length) / (avgLoss * losers.length || 1)) : 0;
  const avgBarsWin  = winners.length > 0 ? round2(winners.reduce((s,t)=>s+(t.bars||0),0)/winners.length) : 0;
  const avgBarsLoss = losers.length  > 0 ? round2(losers.reduce((s,t)=>s+(t.bars||0),0)/losers.length) : 0;

  return {
    returnPct,
    finalEquity: round2(finalEquity),
    totalTrades: closed.length,
    winRate,
    profitFactor,
    maxDrawdownPct: round2(maxDD),
    avgWin, avgLoss,
    avgBarsWin, avgBarsLoss,
    tradeLog: trades.slice(-10), // derniers trades
  };
}

// ─── Cache Yahoo Finance ─────────────────────────────────────
const _cache = {};
async function getBars(symbol) {
  if (_cache[symbol]) return _cache[symbol];
  console.log(`  📥 Fetch Yahoo: ${symbol}...`);
  const bars = await fetchYahoo(symbol, '3y');
  _cache[symbol] = bars;
  return bars;
}

// ─── Définitions des outils ──────────────────────────────────
const TOOLS = [
  {
    name: 'read_strategy',
    description: 'Lit le code Pine Script d\'une stratégie. Retourne le code source complet.',
    input_schema: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['v4', 'gold'],
          description: '"v4" pour Momentum V4 (BBD-B/CLS/CGG/VNP), "gold" pour Gold Momentum Pro (WPM/AEM)',
        },
      },
      required: ['strategy'],
    },
  },
  {
    name: 'run_backtest_v4',
    description:
      'Lance un backtest de la stratégie Momentum V4 (EMA cross) sur un ou plusieurs tickers TSX. ' +
      'Paramètres modifiables: EMAs, volume filter, ATR stop, TP1/TP2, cooldown. ' +
      'Retourne: return%, win rate, profit factor, max drawdown, nb trades.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symboles Yahoo Finance, ex: ["BBD-B.TO", "CLS.TO", "VNP.TO"]',
        },
        params: {
          type: 'object',
          description: 'Paramètres de la stratégie',
          properties: {
            emaFast:      { type: 'number', description: 'EMA rapide (défaut: 8)' },
            emaMid:       { type: 'number', description: 'EMA milieu (défaut: 21)' },
            emaSlow:      { type: 'number', description: 'EMA lente (défaut: 50)' },
            volMult:      { type: 'number', description: 'Volume minimum vs SMA20 (défaut: 1.3)' },
            atrStopMult:  { type: 'number', description: 'Multiplicateur ATR pour le stop (défaut: 1.8)' },
            tp1R:         { type: 'number', description: 'Ratio R:R pour TP1 (défaut: 2.5)' },
            tp2R:         { type: 'number', description: 'Ratio R:R pour TP2 (défaut: 5.0)' },
            cooldown:     { type: 'number', description: 'Barres d\'attente après signal (défaut: 3)' },
          },
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'run_backtest_gold',
    description:
      'Lance un backtest de la stratégie Gold Momentum Pro (Donchian turtle) sur WPM.TO et/ou AEM.TO. ' +
      'Paramètres modifiables: EMAs, lookbacks Donchian, chandelier, ADX threshold. ' +
      'Retourne: return%, win rate, profit factor, max drawdown, nb trades.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symboles Yahoo Finance, ex: ["WPM.TO", "AEM.TO"]',
        },
        params: {
          type: 'object',
          description: 'Paramètres de la stratégie Gold Pro',
          properties: {
            emaFast:        { type: 'number', description: 'EMA rapide (défaut: 13)' },
            emaMid:         { type: 'number', description: 'EMA milieu (défaut: 26)' },
            emaSlow:        { type: 'number', description: 'EMA lente (défaut: 55)' },
            entryLookback:  { type: 'number', description: 'Donchian entrée lookback (défaut: 55)' },
            addLookback:    { type: 'number', description: 'Donchian add lookback (défaut: 20)' },
            exitLookback:   { type: 'number', description: 'Donchian sortie lookback (défaut: 20)' },
            chandelierLen:  { type: 'number', description: 'Chandelier lookback (défaut: 22)' },
            chandelierMult: { type: 'number', description: 'Chandelier ATR mult (défaut: 4.5)' },
            adxThreshold:   { type: 'number', description: 'Seuil ADX minimum (défaut: 20)' },
            maxAdds:        { type: 'number', description: 'Max pyramiding adds (défaut: 2)' },
          },
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'save_pine_script',
    description: 'Sauvegarde un Pine Script amélioré dans le dossier scripts/. À utiliser pour sauvegarder la version finale optimisée.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Nom du fichier, ex: "momentum-v4-optimized.pine"',
        },
        content: {
          type: 'string',
          description: 'Code Pine Script complet',
        },
      },
      required: ['filename', 'content'],
    },
  },
];

// ─── Implémentations des outils ──────────────────────────────
async function executeTool(name, input) {
  switch (name) {
    case 'read_strategy': {
      const file = input.strategy === 'gold'
        ? 'gold-momentum-pro-strategy.pine'
        : 'momentum-v4-strategy-bbd.pine';
      const path = resolve(SCRIPTS_DIR, file);
      if (!existsSync(path)) return { error: `Fichier non trouvé: ${file}` };
      return { filename: file, code: readFileSync(path, 'utf8') };
    }

    case 'run_backtest_v4': {
      const { symbols, params = {} } = input;
      const results = {};
      for (const sym of symbols) {
        try {
          const bars = await getBars(sym);
          results[sym] = backtestV4(bars, params);
        } catch (e) {
          results[sym] = { error: e.message };
        }
      }
      // Moyenne si plusieurs symboles
      const valid = Object.values(results).filter(r => !r.error);
      const avg = valid.length > 1 ? {
        avgReturn: round2(valid.reduce((s,r)=>s+r.returnPct,0)/valid.length),
        avgWinRate: round2(valid.reduce((s,r)=>s+r.winRate,0)/valid.length),
        avgPF: round2(valid.reduce((s,r)=>s+r.profitFactor,0)/valid.length),
        avgMaxDD: round2(valid.reduce((s,r)=>s+r.maxDrawdownPct,0)/valid.length),
      } : null;
      return { params, results, average: avg };
    }

    case 'run_backtest_gold': {
      const { symbols, params = {} } = input;
      const results = {};
      for (const sym of symbols) {
        try {
          const bars = await getBars(sym);
          results[sym] = backtestGold(bars, params);
        } catch (e) {
          results[sym] = { error: e.message };
        }
      }
      const valid = Object.values(results).filter(r => !r.error);
      const avg = valid.length > 1 ? {
        avgReturn: round2(valid.reduce((s,r)=>s+r.returnPct,0)/valid.length),
        avgWinRate: round2(valid.reduce((s,r)=>s+r.winRate,0)/valid.length),
        avgPF: round2(valid.reduce((s,r)=>s+r.profitFactor,0)/valid.length),
        avgMaxDD: round2(valid.reduce((s,r)=>s+r.maxDrawdownPct,0)/valid.length),
      } : null;
      return { params, results, average: avg };
    }

    case 'save_pine_script': {
      const { filename, content } = input;
      const path = resolve(SCRIPTS_DIR, filename);
      writeFileSync(path, content, 'utf8');
      return { saved: path };
    }

    default:
      return { error: `Outil inconnu: ${name}` };
  }
}

// ─── Prompt système ──────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un expert en trading algorithmique et optimisation de stratégies.

## Stratégies à optimiser

### 1. Momentum V4 (EMA cross)
- Utilisé sur: BBD-B.TO, CLS.TO, CGG.TO, VNP.TO
- Paramètres actuels: EMA 8/21/50 | Vol 1.3x | ATR stop 1.8x | TP1 2.5R | TP2 5.0R | Cooldown 3
- Résultats connus: BBD-B +112.61% | 20 trades | Win 50% | PF 4.635 | Max DD 10.52%

### 2. Gold Momentum Pro (Donchian turtle)
- Utilisé sur: WPM.TO, AEM.TO
- Paramètres actuels: EMA 13/26/55 | Donchian 55/20/20 | Chandelier 22×4.5 | ADX > 20 | Max 2 adds
- Résultats connus: WPM +122.94% | 72 trades | Max DD 36.80%

## Ta mission
1. Lire le code source des deux stratégies
2. Tester les paramètres actuels pour avoir un baseline
3. Explorer des variantes de paramètres (EMAs, stops, filtres) pour améliorer:
   - Retour total (maximiser)
   - Profit Factor (cible > 2.0)
   - Max Drawdown (minimiser, cible < 25%)
   - Win rate (cible > 45%)
4. Tester plusieurs combinaisons pour chaque stratégie
5. Synthétiser les meilleurs paramètres trouvés
6. Générer le Pine Script final optimisé (avec les nouveaux paramètres)
7. Sauvegarder le script amélioré

## Règles d'optimisation
- Ne pas over-fitter: tester sur 3 ans de données minimum
- Préférer la robustesse à la performance maximale
- Si un paramètre améliore une stratégie mais dégrade l'autre, indiquer clairement
- Documenter pourquoi chaque changement est justifié
- Le Pine Script final doit être directement utilisable dans TradingView

Commence par lire les deux stratégies, puis lance les backtests de baseline.`;

// ─── Boucle agent ────────────────────────────────────────────
async function runOptimizer() {
  const client = new Anthropic();
  const date = new Date().toISOString().split('T')[0];

  console.log(`\n🔬 Strategy Optimizer — ${date}`);
  console.log('─'.repeat(50));

  const messages = [
    {
      role: 'user',
      content: `Lance l'analyse et l'optimisation complète des deux stratégies: Momentum V4 et Gold Momentum Pro.

Objectifs:
- Tester les paramètres actuels (baseline)
- Explorer au moins 3-4 variantes de paramètres par stratégie
- Trouver la combinaison qui maximise return/drawdown ratio
- Générer et sauvegarder le Pine Script final optimisé pour chaque stratégie`,
    },
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 40;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    process.stdout.write(`\n[Iter ${iteration}] `);

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    stream.on('text', (delta) => process.stdout.write(delta));

    const response = await stream.finalMessage();

    if (response.stop_reason === 'end_turn') {
      console.log('\n\n✅ Optimisation terminée.');
      break;
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`\n  🔧 ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
      const result = await executeTool(block.name, block.input);
      const preview = JSON.stringify(result).slice(0, 300);
      console.log(`     ↳ ${preview}${preview.length >= 300 ? '...' : ''}`);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

runOptimizer().catch((err) => {
  console.error('\n❌ Erreur:', err.message);
  process.exit(1);
});
