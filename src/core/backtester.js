/**
 * backtester.js — Module partagé de backtesting
 *
 * Exporte 7 stratégies backtestables + compareStrategies :
 *   1. backtestV4           — Momentum V4 (EMA cross 8/21/50)
 *   2. backtestGold         — Gold Momentum Pro (Donchian turtle 13/26/55)
 *   3. backtestMACD         — MACD Cross + filtre EMA 50
 *   4. backtestSupertrend   — Supertrend ATR trailing
 *   5. backtestDonchianPure — Donchian Turtle sans filtre EMA
 *   6. backtestRSIReversion — RSI oversold + EMA 200 trend filter
 *   7. backtestBBSqueeze    — Bollinger Band Squeeze Breakout
 *
 * Utilisé par : strategy-optimizer.js, trading-agent.js
 */
import https from 'node:https';

// ─── Fetch Yahoo Finance ─────────────────────────────────────
export function fetchYahoo(symbol, range = '3y') {
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
              date:   new Date(ts[i] * 1000).toISOString().split('T')[0],
              open:   q.open[i],
              high:   q.high[i],
              low:    q.low[i],
              close:  q.close[i],
              volume: q.volume[i] || 0,
            });
          }
          res(bars);
        } catch (e) { rej(new Error(`Parse error ${symbol}: ${e.message}`)); }
      });
      r.on('error', rej);
    }).on('error', rej);
  });
}

const _cache = {};
export async function getBars(symbol) {
  if (_cache[symbol]) return _cache[symbol];
  console.log(`  📥 Fetch Yahoo: ${symbol}...`);
  const bars = await fetchYahoo(symbol, '3y');
  _cache[symbol] = bars;
  return bars;
}

// ─── Indicateurs math ────────────────────────────────────────
export function ema(data, period) {
  const out = new Array(data.length).fill(null);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < data.length; i++) out[i] = data[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function sma(data, period) {
  const out = new Array(data.length).fill(null);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  out[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) { sum += data[i] - data[i - period]; out[i] = sum / period; }
  return out;
}

export function atrFn(highs, lows, closes, period = 14) {
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

export function adxFn(highs, lows, closes, period = 14) {
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

export function rsiFn(data, period = 14) {
  const out = new Array(data.length).fill(null);
  if (data.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i-1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export function stddevFn(data, period) {
  const out = new Array(data.length).fill(null);
  const means = sma(data, period);
  for (let i = period - 1; i < data.length; i++) {
    if (means[i] === null) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (data[j] - means[i]) ** 2;
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

function round2(v) { return Math.round(v * 100) / 100; }

// ─── Résumé commun ───────────────────────────────────────────
export function summarize(trades, initialCapital, finalEquity, maxDD) {
  const closed = trades.filter(t => t.pnl !== 0 && t.type !== 'add');
  const winners = closed.filter(t => t.pnl > 0);
  const losers  = closed.filter(t => t.pnl < 0);
  const totalPnl = finalEquity - initialCapital;
  const returnPct = round2(totalPnl / initialCapital * 100);
  const winRate = closed.length > 0 ? round2(winners.length / closed.length * 100) : 0;
  const avgWin  = winners.length > 0 ? round2(winners.reduce((s,t) => s+t.pnl, 0) / winners.length) : 0;
  const avgLoss = losers.length  > 0 ? round2(Math.abs(losers.reduce((s,t) => s+t.pnl, 0) / losers.length)) : 1;
  const profitFactor = avgLoss > 0 ? round2((avgWin * winners.length) / (avgLoss * (losers.length || 1))) : 0;
  const avgBarsWin  = winners.length > 0 ? round2(winners.reduce((s,t)=>s+(t.bars||0),0)/winners.length) : 0;
  const avgBarsLoss = losers.length  > 0 ? round2(losers.reduce((s,t)=>s+(t.bars||0),0)/losers.length) : 0;
  // Score risque-ajusté: return% - maxDD*0.5 + profitFactor*10
  const score = round2(returnPct - maxDD * 0.5 + profitFactor * 10);
  return {
    returnPct, finalEquity: round2(finalEquity), totalTrades: closed.length,
    winRate, profitFactor, maxDrawdownPct: round2(maxDD),
    avgWin, avgLoss, avgBarsWin, avgBarsLoss, score,
    tradeLog: trades.slice(-10),
  };
}

// ─── Helpers Donchian ────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════
// 1. MOMENTUM V4 — EMA cross 8/21/50
// ═══════════════════════════════════════════════════════════
export function backtestV4(bars, params = {}) {
  const {
    emaFast = 8, emaMid = 21, emaSlow = 50,
    volMult = 1.3, atrStopMult = 1.8,
    tp1R = 2.5, tp2R = 5.0, cooldown = 3,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const ef = ema(closes, emaFast);
  const em = ema(closes, emaMid);
  const es = ema(closes, emaSlow);
  const atrV = atrFn(highs, lows, closes, 14);
  const volSma = sma(vols, 20);

  const warmup = Math.max(emaSlow, 60);
  let equity = initialCapital;
  let position = null;
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
    const bearCandle = c < bars[i].open && c < ef[i];
    const crossUp = ef[i] > em[i] && ef[i-1] <= em[i-1];
    const crossDn = ef[i] < em[i] && ef[i-1] >= em[i-1];
    barsSinceSignal++;

    if (position) {
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      if (l <= position.stop) {
        const pnl = (position.stop - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'stop', entry: position.entry, exit: position.stop, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; barsSinceSignal = 0; continue;
      }
      if (!position.tp1Hit && h >= position.tp1) {
        const half = Math.floor(position.shares / 2);
        const pnl = (position.tp1 - position.entry) * half;
        equity += pnl;
        position.shares -= half; position.tp1Hit = true; position.stop = position.entry;
        trades.push({ date: bars[i].date, type: 'tp1', entry: position.entry, exit: position.tp1, pnl: round2(pnl), bars: i - position.entryBar });
      }
      if (h >= position.tp2) {
        const pnl = (position.tp2 - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'tp2', entry: position.entry, exit: position.tp2, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; barsSinceSignal = 0; continue;
      }
      if (bearAlign && volOk && bearCandle && crossDn) {
        const pnl = (c - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'sell', entry: position.entry, exit: c, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; barsSinceSignal = 0;
      }
    } else {
      if (bullAlign && volOk && bullCandle && aboveAll && crossUp && barsSinceSignal >= cooldown) {
        const stop = c - curATR * atrStopMult;
        const tp1  = c + curATR * atrStopMult * tp1R;
        const tp2  = c + curATR * atrStopMult * tp2R;
        const riskPerShare = c - stop;
        if (riskPerShare > 0) {
          const shares = Math.floor(equity * 0.10 / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, stop, tp1, tp2, tp1Hit: false, entryBar: i };
            barsSinceSignal = 0;
          }
        }
      }
    }
  }

  if (position) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: position.entry, exit: lp, pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 2. GOLD MOMENTUM PRO — Donchian turtle 13/26/55
// ═══════════════════════════════════════════════════════════
export function backtestGold(bars, params = {}) {
  const {
    emaFast = 13, emaMid = 26, emaSlow = 55,
    entryLookback = 55, addLookback = 20, exitLookback = 20,
    chandelierLen = 22, chandelierMult = 4.5,
    adxThreshold = 20, maxAdds = 2,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const ef = ema(closes, emaFast);
  const em = ema(closes, emaMid);
  const es = ema(closes, emaSlow);
  const atrV = atrFn(highs, lows, closes, 14);
  const adxV = adxFn(highs, lows, closes, 14);

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

      const exitLowVal = exitLow[i];
      if (exitLowVal && (l <= exitLowVal || l <= chandelier)) {
        const exitPx = Math.max(Math.min(exitLowVal ?? l, chandelier), l);
        const pnl = (exitPx - avgEntry) * totalShares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'exit', entry: round2(avgEntry), exit: round2(exitPx), pnl: round2(pnl), bars: i - entryBar });
        inPos = false; adds = 0; totalShares = 0; continue;
      }
      const addHighVal = addHigh[i];
      if (addHighVal && c > addHighVal && adxOk && adds < maxAdds) {
        const newShares = Math.floor(equity * 0.10 / (curATR * 2));
        if (newShares > 0) {
          avgEntry = (avgEntry * totalShares + c * newShares) / (totalShares + newShares);
          totalShares += newShares; adds++;
          trades.push({ date: bars[i].date, type: 'add', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    } else {
      const entryHighVal = entryHigh[i];
      if (entryHighVal && c > entryHighVal && bullAlign && adxOk) {
        const shares = Math.floor(equity * 0.10 / (curATR * 2));
        if (shares > 0) {
          inPos = true; adds = 0; entryBar = i; totalShares = shares; avgEntry = c;
          trades.push({ date: bars[i].date, type: 'brk', entry: round2(c), pnl: 0, bars: 0 });
        }
      } else if (entryHighVal && c > ef[i] && l < ef[i] && c > entryHighVal * 0.98 && bullAlign && adxOk) {
        const shares = Math.floor(equity * 0.10 / (curATR * 2));
        if (shares > 0) {
          inPos = true; adds = 0; entryBar = i; totalShares = shares; avgEntry = c;
          trades.push({ date: bars[i].date, type: 'pb', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    }
  }

  if (inPos) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - avgEntry) * totalShares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: round2(avgEntry), exit: round2(lp), pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 3. MACD CROSS + FILTRE EMA 50
// ═══════════════════════════════════════════════════════════
export function backtestMACD(bars, params = {}) {
  const {
    fastPeriod = 12, slowPeriod = 26, signalPeriod = 9,
    emaSlowFilter = 50,
    volMult = 1.3, atrStopMult = 1.8,
    tp1R = 2.5, tp2R = 5.0,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const emaF = ema(closes, fastPeriod);
  const emaS = ema(closes, slowPeriod);
  const esFilter = ema(closes, emaSlowFilter);
  const atrV = atrFn(highs, lows, closes, 14);
  const volSma = sma(vols, 20);

  // MACD line
  const macdLine = closes.map((_, i) =>
    emaF[i] !== null && emaS[i] !== null ? emaF[i] - emaS[i] : null
  );
  // Signal line: EMA of MACD (use 0 for nulls, then zero out early values)
  const macdForEma = macdLine.map(v => v ?? 0);
  const sigLine = ema(macdForEma, signalPeriod);
  const firstValid = macdLine.findIndex(v => v !== null);
  for (let i = 0; i < firstValid + signalPeriod + 1; i++) sigLine[i] = null;

  const warmup = Math.max(emaSlowFilter, slowPeriod + signalPeriod + 5);
  let equity = initialCapital;
  let position = null;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], h = highs[i], l = lows[i];
    const macd = macdLine[i], sig = sigLine[i];
    const macdPrev = macdLine[i-1], sigPrev = sigLine[i-1];
    if (macd === null || sig === null || macdPrev === null || sigPrev === null) continue;

    const curATR = atrV[i] || 1;
    const volOk = vols[i] >= (volSma[i] || 0) * volMult;
    const aboveEma50 = c > (esFilter[i] || 0);
    const bullCandle = c > bars[i].open;
    const crossUp = macd > sig && macdPrev <= sigPrev;
    const crossDn = macd < sig && macdPrev >= sigPrev;

    if (position) {
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      if (l <= position.stop) {
        const pnl = (position.stop - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'stop', entry: position.entry, exit: position.stop, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; continue;
      }
      if (!position.tp1Hit && h >= position.tp1) {
        const half = Math.floor(position.shares / 2);
        const pnl = (position.tp1 - position.entry) * half;
        equity += pnl;
        position.shares -= half; position.tp1Hit = true; position.stop = position.entry;
        trades.push({ date: bars[i].date, type: 'tp1', entry: position.entry, exit: position.tp1, pnl: round2(pnl), bars: i - position.entryBar });
      }
      if (h >= position.tp2) {
        const pnl = (position.tp2 - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'tp2', entry: position.entry, exit: position.tp2, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; continue;
      }
      // Sortie: MACD cross down + prix sous EMA50
      if (crossDn && !aboveEma50) {
        const pnl = (c - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'sell', entry: position.entry, exit: c, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
      }
    } else {
      if (crossUp && aboveEma50 && bullCandle && volOk) {
        const stop = c - curATR * atrStopMult;
        const riskPerShare = c - stop;
        if (riskPerShare > 0) {
          const shares = Math.floor(equity * 0.10 / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, stop, tp1: c + curATR * atrStopMult * tp1R, tp2: c + curATR * atrStopMult * tp2R, tp1Hit: false, entryBar: i };
          }
        }
      }
    }
  }

  if (position) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: position.entry, exit: lp, pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 4. SUPERTREND — ATR trailing stop
// ═══════════════════════════════════════════════════════════
export function backtestSupertrend(bars, params = {}) {
  const {
    period = 10, multiplier = 3.0,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const atrV   = atrFn(highs, lows, closes, period);

  const warmup = period + 5;

  // Calcul Supertrend
  const trendDir = new Array(bars.length).fill(0);
  const stLine   = new Array(bars.length).fill(null);
  const ub = new Array(bars.length).fill(null);
  const lb = new Array(bars.length).fill(null);

  for (let i = period; i < bars.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const a = atrV[i] || 1;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;

    ub[i] = (i > period && basicUpper < (ub[i-1] || basicUpper)) || closes[i-1] > (ub[i-1] || basicUpper)
      ? basicUpper : (ub[i-1] || basicUpper);
    lb[i] = (i > period && basicLower > (lb[i-1] || basicLower)) || closes[i-1] < (lb[i-1] || basicLower)
      ? basicLower : (lb[i-1] || basicLower);

    if (i === period) {
      trendDir[i] = closes[i] > ub[i] ? 1 : -1;
    } else {
      if (trendDir[i-1] === -1 && closes[i] > ub[i]) trendDir[i] = 1;
      else if (trendDir[i-1] === 1 && closes[i] < lb[i]) trendDir[i] = -1;
      else trendDir[i] = trendDir[i-1];
    }
    stLine[i] = trendDir[i] === 1 ? lb[i] : ub[i];
  }

  let equity = initialCapital;
  let position = null;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i];

    if (position) {
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      // Sortie: inversion de tendance (bull → bear)
      if (trendDir[i] === -1 && trendDir[i-1] === 1) {
        const exitPx = stLine[i] || c;
        const pnl = (exitPx - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'exit', entry: position.entry, exit: round2(exitPx), pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
      }
    } else {
      // Entrée: inversion bull (bear → bull)
      if (trendDir[i] === 1 && trendDir[i-1] === -1) {
        const riskPerShare = c - (stLine[i] || c * 0.95);
        if (riskPerShare > 0) {
          const shares = Math.floor(equity * 0.10 / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, entryBar: i };
          }
        }
      }
    }
  }

  if (position) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: position.entry, exit: round2(lp), pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 5. DONCHIAN TURTLE PUR — sans filtre EMA
// ═══════════════════════════════════════════════════════════
export function backtestDonchianPure(bars, params = {}) {
  const {
    entryLookback = 55, addLookback = 20, exitLookback = 20,
    chandelierLen = 22, chandelierMult = 4.5,
    adxThreshold = 20, maxAdds = 2,
    minBarsBetweenAdds = 10,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const atrV = atrFn(highs, lows, closes, 14);
  const adxV = adxFn(highs, lows, closes, 14);

  const entryHigh = highest(highs, entryLookback);
  const addHigh   = highest(highs, addLookback);
  const exitLow_  = lowest(lows, exitLookback);
  const chanHigh  = highestCurrent(highs, chandelierLen);

  const warmup = Math.max(entryLookback + 5, 80);
  let equity = initialCapital;
  let inPos = false, adds = 0, entryBar = 0, lastAddBar = 0;
  let totalShares = 0, avgEntry = 0;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], l = lows[i];
    const curATR = atrV[i] || 1;
    const adxOk = (adxV[i] || 0) > adxThreshold;
    const chandelier = chanHigh[i] - curATR * chandelierMult;

    if (inPos) {
      const mktVal = equity + (c - avgEntry) * totalShares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      const exitLowVal = exitLow_[i];
      if (exitLowVal && (l <= exitLowVal || l <= chandelier)) {
        const exitPx = Math.max(Math.min(exitLowVal ?? l, chandelier), l);
        const pnl = (exitPx - avgEntry) * totalShares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'exit', entry: round2(avgEntry), exit: round2(exitPx), pnl: round2(pnl), bars: i - entryBar });
        inPos = false; adds = 0; totalShares = 0; continue;
      }
      const addHighVal = addHigh[i];
      if (addHighVal && c > addHighVal && adxOk && adds < maxAdds && i - lastAddBar >= minBarsBetweenAdds) {
        const newShares = Math.floor(equity * 0.10 / (curATR * 2));
        if (newShares > 0) {
          avgEntry = (avgEntry * totalShares + c * newShares) / (totalShares + newShares);
          totalShares += newShares; adds++; lastAddBar = i;
          trades.push({ date: bars[i].date, type: 'add', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    } else {
      const entryHighVal = entryHigh[i];
      // Pas de filtre EMA — seulement Donchian 55j + ADX
      if (entryHighVal && c > entryHighVal && adxOk) {
        const shares = Math.floor(equity * 0.10 / (curATR * 2));
        if (shares > 0) {
          inPos = true; adds = 0; entryBar = i; lastAddBar = i; totalShares = shares; avgEntry = c;
          trades.push({ date: bars[i].date, type: 'brk', entry: round2(c), pnl: 0, bars: 0 });
        }
      }
    }
  }

  if (inPos) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - avgEntry) * totalShares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: round2(avgEntry), exit: round2(lp), pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 6. RSI REVERSION + FILTRE EMA 200
// ═══════════════════════════════════════════════════════════
export function backtestRSIReversion(bars, params = {}) {
  const {
    rsiPeriod = 14, rsiOversold = 35, rsiOverbought = 65,
    ema200Period = 200, ema50Period = 50,
    atrStopMult = 1.5,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const rsiArr  = rsiFn(closes, rsiPeriod);
  const ema200  = ema(closes, ema200Period);
  const ema50   = ema(closes, ema50Period);
  const atrV    = atrFn(highs, lows, closes, 14);

  const warmup = Math.max(ema200Period + 5, 220);
  let equity = initialCapital;
  let position = null;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], l = lows[i];
    const rsi = rsiArr[i], rsiPrev = rsiArr[i-1];
    if (rsi === null || rsiPrev === null) continue;

    const curATR = atrV[i] || 1;
    const aboveEma200 = c > (ema200[i] || 0);
    const aboveEma50  = c > (ema50[i] || 0);

    // Croisement RSI vers le haut depuis la zone oversold
    const rsiCrossUp = rsi > rsiOversold && rsiPrev <= rsiOversold;
    const rsiCrossUp2 = rsiPrev < rsiOversold + 5 && rsi > rsiOversold;

    if (position) {
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      // Stop ATR
      if (l <= position.stop) {
        const pnl = (position.stop - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'stop', entry: position.entry, exit: position.stop, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; continue;
      }
      // Sortie: RSI overbought ou prix sous EMA50
      if (rsi > rsiOverbought || !aboveEma50) {
        const pnl = (c - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: rsi > rsiOverbought ? 'tp' : 'sell', entry: position.entry, exit: c, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
      }
    } else {
      if ((rsiCrossUp || rsiCrossUp2) && aboveEma200) {
        const stop = c - curATR * atrStopMult;
        const riskPerShare = c - stop;
        if (riskPerShare > 0) {
          const shares = Math.floor(equity * 0.10 / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, stop, entryBar: i };
          }
        }
      }
    }
  }

  if (position) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: position.entry, exit: lp, pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// 7. BOLLINGER BAND SQUEEZE BREAKOUT
// ═══════════════════════════════════════════════════════════
export function backtestBBSqueeze(bars, params = {}) {
  const {
    bbPeriod = 20, bbStdMult = 2.0,
    squeezeThreshold = 0.05, // BBwidth/price < 5%
    squeezeWindow = 5,       // entrée valide dans les N barres post-squeeze
    volMult = 1.5,
    atrStopMult = 1.8, tp1R = 2.5, tp2R = 5.0,
    initialCapital = 9000,
  } = params;

  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const sma20   = sma(closes, bbPeriod);
  const std20   = stddevFn(closes, bbPeriod);
  const atrV    = atrFn(highs, lows, closes, 14);
  const volSma  = sma(vols, 20);

  const warmup = bbPeriod + 5;
  let equity = initialCapital;
  let position = null;
  let barsSinceSqueezeEnd = 999;
  const trades = [];
  let maxDD = 0, peakEq = initialCapital;

  for (let i = warmup; i < bars.length; i++) {
    const c = closes[i], h = highs[i], l = lows[i];
    const mid = sma20[i], sd = std20[i];
    if (mid === null || sd === null) continue;

    const upperBB = mid + bbStdMult * sd;
    const bbWidth = (2 * bbStdMult * sd) / mid;
    const curATR = atrV[i] || 1;
    const volOk = vols[i] >= (volSma[i] || 0) * volMult;
    const bullCandle = c > bars[i].open;

    // Détection squeeze / post-squeeze
    const inSqueeze = bbWidth < squeezeThreshold;
    const prevSqueezing = i > 0 && std20[i-1] !== null && sma20[i-1] !== null
      && (2 * bbStdMult * std20[i-1]) / sma20[i-1] < squeezeThreshold;

    if (inSqueeze) {
      barsSinceSqueezeEnd = 0;
    } else if (prevSqueezing && !inSqueeze) {
      barsSinceSqueezeEnd = 1; // fin du squeeze
    } else {
      barsSinceSqueezeEnd++;
    }

    if (position) {
      const mktVal = equity + (c - position.entry) * position.shares;
      if (mktVal > peakEq) peakEq = mktVal;
      const dd = (peakEq - mktVal) / peakEq * 100;
      if (dd > maxDD) maxDD = dd;

      if (l <= position.stop) {
        const pnl = (position.stop - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'stop', entry: position.entry, exit: position.stop, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; continue;
      }
      if (!position.tp1Hit && h >= position.tp1) {
        const half = Math.floor(position.shares / 2);
        const pnl = (position.tp1 - position.entry) * half;
        equity += pnl;
        position.shares -= half; position.tp1Hit = true; position.stop = position.entry;
        trades.push({ date: bars[i].date, type: 'tp1', entry: position.entry, exit: position.tp1, pnl: round2(pnl), bars: i - position.entryBar });
      }
      if (h >= position.tp2) {
        const pnl = (position.tp2 - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'tp2', entry: position.entry, exit: position.tp2, pnl: round2(pnl), bars: i - position.entryBar });
        position = null; continue;
      }
      // Sortie: retour sous la BB moyenne
      if (c < mid) {
        const pnl = (c - position.entry) * position.shares;
        equity += pnl;
        trades.push({ date: bars[i].date, type: 'sell', entry: position.entry, exit: c, pnl: round2(pnl), bars: i - position.entryBar });
        position = null;
      }
    } else {
      // Entrée: breakout au-dessus de la BB sup après un squeeze récent
      if (c > upperBB && bullCandle && volOk && barsSinceSqueezeEnd <= squeezeWindow) {
        const stop = c - curATR * atrStopMult;
        const riskPerShare = c - stop;
        if (riskPerShare > 0) {
          const shares = Math.floor(equity * 0.10 / riskPerShare);
          if (shares > 0 && c * shares <= equity) {
            position = { shares, entry: c, stop, tp1: c + curATR * atrStopMult * tp1R, tp2: c + curATR * atrStopMult * tp2R, tp1Hit: false, entryBar: i };
          }
        }
      }
    }
  }

  if (position) {
    const lp = closes[bars.length - 1];
    const pnl = (lp - position.entry) * position.shares;
    equity += pnl;
    trades.push({ date: bars[bars.length-1].date, type: 'open', entry: position.entry, exit: lp, pnl: round2(pnl) });
  }
  return summarize(trades, initialCapital, equity, maxDD);
}

// ═══════════════════════════════════════════════════════════
// COMPARE STRATEGIES — Lance les 7 sur un symbole, classe par score
// ═══════════════════════════════════════════════════════════
export async function compareStrategies(symbol, initialCapital = 9000) {
  const bars = await getBars(symbol);
  const isGold = /WPM|AEM/i.test(symbol);

  const strategies = [
    { name: 'Momentum V4',        fn: backtestV4 },
    { name: 'Gold Momentum Pro',  fn: backtestGold },
    { name: 'MACD Cross',         fn: backtestMACD },
    { name: 'Supertrend',         fn: backtestSupertrend },
    { name: 'Donchian Pure',      fn: backtestDonchianPure },
    { name: 'RSI Reversion',      fn: backtestRSIReversion },
    { name: 'BB Squeeze',         fn: backtestBBSqueeze },
  ];

  const results = [];
  for (const { name, fn } of strategies) {
    try {
      const r = fn(bars, { initialCapital });
      results.push({
        strategy: name,
        returnPct: r.returnPct,
        winRate: r.winRate,
        profitFactor: r.profitFactor,
        maxDrawdownPct: r.maxDrawdownPct,
        totalTrades: r.totalTrades,
        score: r.score,
        recommended: false,
      });
    } catch (e) {
      results.push({ strategy: name, error: e.message, score: -999 });
    }
  }

  // Filtre: min 5 trades pour être qualifiée
  const qualified = results.filter(r => !r.error && r.totalTrades >= 5);
  qualified.sort((a, b) => b.score - a.score);
  if (qualified.length > 0) qualified[0].recommended = true;

  const currentStrategy = isGold ? 'Gold Momentum Pro' : 'Momentum V4';
  const current = results.find(r => r.strategy === currentStrategy);
  const winner  = qualified[0] || null;
  const improvement = winner && current && !current.error
    ? round2(winner.returnPct - current.returnPct)
    : null;

  return {
    symbol,
    currentStrategy,
    winner: winner?.strategy || 'N/A',
    improvementPct: improvement,
    shouldSwitch: winner && winner.strategy !== currentStrategy && improvement > 10,
    ranked: qualified,
    disqualified: results.filter(r => r.error || r.totalTrades < 5),
  };
}
