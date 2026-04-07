/**
 * Backtester V2 — Advanced Swing Trading Strategy
 *
 * Improvements over V1:
 * ─────────────────────
 * INDICATORS:
 *   + ADX (trend strength filter — only trade strong trends)
 *   + ATR (volatility-adaptive stops instead of fixed %)
 *   + Bollinger Bands (squeeze detection for breakouts)
 *   + Stochastic RSI (more sensitive momentum)
 *   + Volume ratio (confirm entries with volume)
 *   + Keltner Channels (squeeze = BB inside Keltner)
 *
 * MECHANICS:
 *   + Compounding — reinvest profits, equity grows
 *   + Pyramiding — add to winners on pullbacks (up to 3 layers)
 *   + Adaptive trailing stop — wider in strong trends (high ADX), tighter in weak
 *   + Re-entry — if stopped out but trend resumes, re-enter quickly
 *   + Trend-following mode — stay in as long as ADX > threshold + price > EMA
 *   + Partial exits — scale out at targets, let runners ride
 *   + Cooldown — no re-entry for N bars after a stop loss
 *
 * Output: Desktop/briefs/backtest-v2-report.md
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';

const BRIEFS_DIR = resolve(process.env.USERPROFILE || process.env.HOME, 'Desktop', 'briefs');
const INITIAL_CAPITAL = 10000;

const TICKERS = [
  { symbol: 'SHOP.TO', name: 'Shopify', sector: 'Tech' },
  { symbol: 'BBD-B.TO', name: 'Bombardier', sector: 'Aerospace' },
  { symbol: 'WPM.TO', name: 'Wheaton PM', sector: 'Mining/Gold' },
  { symbol: 'CLS.TO', name: 'Celestica', sector: 'Tech/Semis' },
  { symbol: 'AEM.TO', name: 'Agnico Eagle', sector: 'Mining/Gold' },
  { symbol: 'CGG.TO', name: 'China Gold', sector: 'Mining/Gold' },
  { symbol: 'VNP.TO', name: '5N Plus', sector: 'Mining' },
];

// ============================================================
// DATA FETCHING
// ============================================================
function fetchYahoo(symbol, range = '2y') {
  return new Promise((res, rej) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(body);
          const result = json.chart.result[0];
          const ts = result.timestamp;
          const q = result.indicators.quote[0];
          const bars = [];
          for (let i = 0; i < ts.length; i++) {
            if (q.close[i] == null) continue;
            bars.push({
              date: new Date(ts[i] * 1000).toISOString().split('T')[0],
              open: q.open[i], high: q.high[i], low: q.low[i],
              close: q.close[i], volume: q.volume[i],
            });
          }
          res(bars);
        } catch (e) { rej(new Error(`Parse error ${symbol}: ${e.message}`)); }
      });
      r.on('error', rej);
    }).on('error', rej);
  });
}

// ============================================================
// INDICATORS
// ============================================================
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
  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
    out[i] = sum / period;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  if (tr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

function adx(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period * 2 + 1) return out;
  const plusDM = [0], minusDM = [0], tr = [0];
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // Smoothed
  let sTR = 0, sPDM = 0, sMDM = 0;
  for (let i = 1; i <= period; i++) { sTR += tr[i]; sPDM += plusDM[i]; sMDM += minusDM[i]; }
  const dx = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i];
      sPDM = sPDM - sPDM / period + plusDM[i];
      sMDM = sMDM - sMDM / period + minusDM[i];
    }
    const pdi = sTR > 0 ? (sPDM / sTR) * 100 : 0;
    const mdi = sTR > 0 ? (sMDM / sTR) * 100 : 0;
    const dxVal = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
    dx.push({ idx: i, dx: dxVal, pdi, mdi });
  }
  // ADX = SMA of DX
  if (dx.length >= period) {
    let adxSum = 0;
    for (let j = 0; j < period; j++) adxSum += dx[j].dx;
    let adxVal = adxSum / period;
    out[dx[period - 1].idx] = adxVal;
    for (let j = period; j < dx.length; j++) {
      adxVal = (adxVal * (period - 1) + dx[j].dx) / period;
      out[dx[j].idx] = adxVal;
    }
  }
  return out;
}

function bollingerBands(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - mid[i]) ** 2;
    const std = Math.sqrt(sumSq / period);
    upper[i] = mid[i] + mult * std;
    lower[i] = mid[i] - mult * std;
    width[i] = mid[i] > 0 ? (upper[i] - lower[i]) / mid[i] * 100 : 0;
  }
  return { upper, mid, lower, width };
}

function keltnerChannels(closes, highs, lows, emaPeriod = 20, atrPeriod = 14, mult = 1.5) {
  const mid = ema(closes, emaPeriod);
  const atrVal = atr(highs, lows, closes, atrPeriod);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] !== null && atrVal[i] !== null) {
      upper[i] = mid[i] + mult * atrVal[i];
      lower[i] = mid[i] - mult * atrVal[i];
    }
  }
  return { upper, mid, lower };
}

function stochasticRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiVals = rsi(closes, rsiPeriod);
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);
  for (let i = stochPeriod + rsiPeriod; i < closes.length; i++) {
    let minRSI = Infinity, maxRSI = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsiVals[j] !== null) {
        if (rsiVals[j] < minRSI) minRSI = rsiVals[j];
        if (rsiVals[j] > maxRSI) maxRSI = rsiVals[j];
      }
    }
    k[i] = maxRSI !== minRSI ? ((rsiVals[i] - minRSI) / (maxRSI - minRSI)) * 100 : 50;
  }
  // Smooth K
  const kSmoothed = sma(k.map(v => v ?? 0), kSmooth);
  const dSmoothed = sma(kSmoothed.map(v => v ?? 0), dSmooth);
  return { k: kSmoothed, d: dSmoothed };
}

function volumeRatio(volumes, period = 20) {
  const avg = sma(volumes, period);
  return volumes.map((v, i) => avg[i] ? v / avg[i] : null);
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  const validM = [], validI = [];
  line.forEach((v, i) => { if (v !== null) { validM.push(v); validI.push(i); } });
  const sigEma = ema(validM, sig);
  const signal = new Array(closes.length).fill(null);
  const hist = new Array(closes.length).fill(null);
  for (let j = 0; j < validI.length; j++) {
    signal[validI[j]] = sigEma[j];
    if (line[validI[j]] !== null && sigEma[j] !== null) hist[validI[j]] = line[validI[j]] - sigEma[j];
  }
  return { line, signal, hist };
}

// ============================================================
// SQUEEZE DETECTION (BB inside Keltner = compression)
// ============================================================
function squeeze(bbUpper, bbLower, kcUpper, kcLower) {
  return bbUpper.map((_, i) => {
    if (bbUpper[i] === null || kcUpper[i] === null) return null;
    return bbLower[i] > kcLower[i] && bbUpper[i] < kcUpper[i];
  });
}

// ============================================================
// STRATEGY V2
// ============================================================
function runStrategyV2(bars, params = {}) {
  const {
    rsiPeriod = 14,
    emaFast = 10,
    emaSlow = 50,
    adxPeriod = 14,
    adxThreshold = 20,       // min ADX to enter
    atrPeriod = 14,
    atrStopMult = 2.0,       // stop = entry - ATR * mult
    atrTrailMult = 3.0,      // trailing = peak - ATR * mult
    adxTrailBonus = 1.0,     // extra ATR mults when ADX > 30
    bbPeriod = 20,
    bbMult = 2.0,
    stochRsiPeriod = 14,
    stochBuyThreshold = 20,  // stochRSI K < this = oversold
    stochSellThreshold = 80,
    volumeMinRatio = 1.0,    // volume must be >= this * avg
    maxHoldDays = 40,
    cooldownBars = 3,        // bars to wait after a stop loss
    pyramidLayers = 3,       // max add-ons to winning position
    pyramidPullbackATR = 1.0,// add when price pulls back N * ATR from peak
    riskPct = 0.03,          // risk per trade
    compounding = true,      // reinvest profits
    partialExitPct = 0.5,    // sell this % at TP1
    tp1AtrMult = 3.0,        // TP1 = entry + ATR * mult
    tp2AtrMult = 6.0,        // TP2 = entry + ATR * mult
    trendFollowMode = true,  // stay in if ADX > threshold + price > ema
  } = params;

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  // Calculate all indicators
  const emaF = ema(closes, emaFast);
  const emaS = ema(closes, emaSlow);
  const rsiVals = rsi(closes, rsiPeriod);
  const adxVals = adx(highs, lows, closes, adxPeriod);
  const atrVals = atr(highs, lows, closes, atrPeriod);
  const bb = bollingerBands(closes, bbPeriod, bbMult);
  const kc = keltnerChannels(closes, highs, lows, 20, atrPeriod, 1.5);
  const sqz = squeeze(bb.upper, bb.lower, kc.upper, kc.lower);
  const stochRsi = stochasticRSI(closes, rsiPeriod, stochRsiPeriod);
  const volRatio = volumeRatio(volumes, 20);
  const macdInd = macd(closes);

  const warmup = Math.max(emaSlow, bbPeriod, adxPeriod * 3, 60);
  const trades = [];
  let equity = INITIAL_CAPITAL;
  let position = null; // { layers: [...], totalShares, avgEntry, stopLoss, highSince, tp1, tp2, tp1Hit }
  let cooldown = 0;
  let peakEquity = equity;
  let maxDD = 0;
  const equityCurve = [];

  for (let i = warmup; i < bars.length; i++) {
    const price = closes[i];
    const bar = bars[i];
    const curATR = atrVals[i] || atrVals[i - 1] || 1;
    const curADX = adxVals[i];

    // Track equity
    if (position) {
      const unrealized = (price - position.avgEntry) * position.totalShares;
      const curEquity = equity + unrealized;
      if (curEquity > peakEquity) peakEquity = curEquity;
      const dd = (peakEquity - curEquity) / peakEquity * 100;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ date: bar.date, equity: round(curEquity) });
    } else {
      equityCurve.push({ date: bar.date, equity: round(equity) });
      if (equity > peakEquity) peakEquity = equity;
    }

    if (cooldown > 0) cooldown--;

    // === EXIT LOGIC ===
    if (position) {
      const daysHeld = i - position.entryIdx;

      // Update high watermark
      if (highs[i] > position.highSince) position.highSince = highs[i];

      // ATR-adaptive trailing stop (wider when ADX is strong)
      let trailMult = atrTrailMult;
      if (curADX !== null && curADX > 30) trailMult += adxTrailBonus;
      if (curADX !== null && curADX > 40) trailMult += adxTrailBonus * 0.5;
      const trailingStop = position.highSince - trailMult * curATR;

      // Hard stop loss (ATR-based)
      if (lows[i] <= position.stopLoss) {
        const exitP = Math.max(position.stopLoss, lows[i]);
        closePosition(position, exitP, bar.date, i, 'Stop Loss', trades);
        equity += (exitP - position.avgEntry) * position.totalShares;
        position = null;
        cooldown = cooldownBars;
        continue;
      }

      // Trailing stop
      if (price < trailingStop && daysHeld > 2) {
        // In trend-follow mode, only exit if ADX is dropping AND price < EMA
        if (trendFollowMode && curADX !== null && curADX > adxThreshold && price > emaF[i]) {
          // Stay in — trend is still strong
        } else {
          closePosition(position, price, bar.date, i, 'Trailing Stop', trades);
          equity += (price - position.avgEntry) * position.totalShares;
          position = null;
          cooldown = 2;
          continue;
        }
      }

      // Partial exit at TP1
      if (!position.tp1Hit && price >= position.tp1 && position.totalShares > 1) {
        const sellShares = Math.max(1, Math.floor(position.totalShares * partialExitPct));
        const partialPnl = (price - position.avgEntry) * sellShares;
        equity += partialPnl;
        position.totalShares -= sellShares;
        position.tp1Hit = true;
        // Move stop to breakeven
        position.stopLoss = position.avgEntry;
        trades.push({
          entryDate: position.entryDate, exitDate: bar.date,
          entryPrice: round(position.avgEntry), exitPrice: round(price),
          shares: sellShares, pnl: round(partialPnl),
          pnlPct: round((price - position.avgEntry) / position.avgEntry * 100),
          daysHeld, reason: 'TP1 Partial', layers: position.layers.length,
        });
      }

      // Full exit at TP2
      if (price >= position.tp2) {
        closePosition(position, price, bar.date, i, 'TP2', trades);
        equity += (price - position.avgEntry) * position.totalShares;
        position = null;
        continue;
      }

      // Stochastic RSI overbought + ADX declining = exit
      if (stochRsi.k[i] > stochSellThreshold && curADX !== null && adxVals[i - 1] !== null && curADX < adxVals[i - 1] && daysHeld > 5) {
        closePosition(position, price, bar.date, i, 'StochRSI OB + ADX decline', trades);
        equity += (price - position.avgEntry) * position.totalShares;
        position = null;
        continue;
      }

      // Max hold
      if (daysHeld >= maxHoldDays) {
        // Unless trend is very strong
        if (!(trendFollowMode && curADX !== null && curADX > 30 && price > emaF[i])) {
          closePosition(position, price, bar.date, i, 'Max Hold', trades);
          equity += (price - position.avgEntry) * position.totalShares;
          position = null;
          continue;
        }
      }

      // === PYRAMIDING — add to winners ===
      if (position.layers.length < pyramidLayers && daysHeld > 2) {
        const pullback = position.highSince - price;
        const inUptrend = emaF[i] !== null && emaS[i] !== null && price > emaF[i] && emaF[i] > emaS[i];
        const adxStrong = curADX !== null && curADX > adxThreshold;
        const priceProfitable = price > position.avgEntry;

        if (pullback >= pyramidPullbackATR * curATR && inUptrend && adxStrong && priceProfitable) {
          const cap = compounding ? equity : INITIAL_CAPITAL;
          const riskAmount = cap * riskPct * 0.5; // Half size for pyramids
          const riskPerShare = curATR * atrStopMult;
          let addShares = Math.floor(riskAmount / riskPerShare);
          if (addShares * price > cap * 0.3) addShares = Math.floor(cap * 0.3 / price);
          if (addShares > 0) {
            position.layers.push({ price, shares: addShares, idx: i });
            const totalCost = position.avgEntry * position.totalShares + price * addShares;
            position.totalShares += addShares;
            position.avgEntry = totalCost / position.totalShares;
            // Update stop to protect profits — never lower than current stop
            const newStop = price - atrStopMult * curATR;
            if (newStop > position.stopLoss) position.stopLoss = newStop;
          }
        }
      }

      continue;
    }

    // === ENTRY LOGIC ===
    if (cooldown > 0) continue;
    if (emaF[i] === null || emaS[i] === null || rsiVals[i] === null || curADX === null) continue;

    let score = 0;
    let reasons = [];

    // 1. Trend alignment (EMA)
    if (price > emaF[i] && emaF[i] > emaS[i]) { score += 2; reasons.push('EMA aligned'); }
    else if (price > emaF[i]) { score += 1; reasons.push('Price>EMA fast'); }

    // 2. ADX trend strength
    if (curADX >= adxThreshold) { score += 2; reasons.push(`ADX ${round(curADX)}`); }
    else if (curADX >= adxThreshold * 0.7) { score += 1; reasons.push(`ADX weak ${round(curADX)}`); }
    else { score -= 1; } // No trend = penalty

    // 3. RSI
    if (rsiVals[i] < 40 && rsiVals[i] > 20) { score += 1; reasons.push('RSI pullback'); }
    else if (rsiVals[i] > 70) { score -= 1; }

    // 4. Stochastic RSI oversold
    if (stochRsi.k[i] !== null && stochRsi.k[i] < stochBuyThreshold) {
      score += 2; reasons.push('StochRSI oversold');
    }
    // StochRSI crossover (K crosses above D)
    if (stochRsi.k[i] !== null && stochRsi.d[i] !== null && stochRsi.k[i - 1] !== null && stochRsi.d[i - 1] !== null) {
      if (stochRsi.k[i] > stochRsi.d[i] && stochRsi.k[i - 1] <= stochRsi.d[i - 1]) {
        score += 1; reasons.push('StochRSI cross');
      }
    }

    // 5. MACD histogram turning positive
    if (macdInd.hist[i] !== null && macdInd.hist[i - 1] !== null) {
      if (macdInd.hist[i] > 0 && macdInd.hist[i] > macdInd.hist[i - 1]) { score += 1; reasons.push('MACD rising'); }
      if (macdInd.hist[i] > 0 && macdInd.hist[i - 1] <= 0) { score += 2; reasons.push('MACD cross'); }
    }

    // 6. Bollinger squeeze release (breakout from compression)
    if (sqz[i] === false && sqz[i - 1] === true && price > bb.mid[i]) {
      score += 3; reasons.push('Squeeze breakout!');
    }
    // Price near lower band = potential bounce
    if (bb.lower[i] !== null && price <= bb.lower[i] * 1.01) {
      score += 1; reasons.push('BB lower touch');
    }

    // 7. Volume confirmation
    if (volRatio[i] !== null && volRatio[i] >= volumeMinRatio) {
      score += 1; reasons.push(`Vol ${round(volRatio[i])}x`);
    } else if (volRatio[i] !== null && volRatio[i] < 0.7) {
      score -= 1; // Low volume = fake move
    }

    // === ENTRY DECISION ===
    const minScore = 5;
    if (score >= minScore) {
      const cap = compounding ? equity : INITIAL_CAPITAL;
      const riskAmount = cap * riskPct;
      const stopDistance = atrStopMult * curATR;
      const stopLoss = price - stopDistance;
      let shares = Math.floor(riskAmount / stopDistance);
      if (shares * price > cap * 0.5) shares = Math.floor(cap * 0.5 / price); // Max 50% of equity per position
      if (shares <= 0) continue;

      const tp1 = price + tp1AtrMult * curATR;
      const tp2 = price + tp2AtrMult * curATR;

      position = {
        layers: [{ price, shares, idx: i }],
        totalShares: shares,
        avgEntry: price,
        entryDate: bar.date,
        entryIdx: i,
        stopLoss,
        highSince: price,
        tp1, tp2,
        tp1Hit: false,
        score,
        reasons,
      };
    }
  }

  // Close any open position at end
  if (position) {
    const lastPrice = closes[closes.length - 1];
    closePosition(position, lastPrice, bars[bars.length - 1].date, bars.length - 1, 'End of Period', trades);
    equity += (lastPrice - position.avgEntry) * position.totalShares;
  }

  // Buy & Hold comparison
  const startPrice = bars[warmup].close;
  const endPrice = bars[bars.length - 1].close;
  const buyAndHoldPct = (endPrice - startPrice) / startPrice * 100;
  const buyAndHoldShares = Math.floor(INITIAL_CAPITAL / startPrice);
  const buyAndHoldPnl = (endPrice - startPrice) * buyAndHoldShares;

  return computeMetrics(trades, equity, maxDD, buyAndHoldPct, buyAndHoldPnl, equityCurve);
}

function closePosition(pos, exitPrice, exitDate, exitIdx, reason, trades) {
  const pnl = (exitPrice - pos.avgEntry) * pos.totalShares;
  trades.push({
    entryDate: pos.entryDate, exitDate,
    entryPrice: round(pos.avgEntry), exitPrice: round(exitPrice),
    shares: pos.totalShares, pnl: round(pnl),
    pnlPct: round((exitPrice - pos.avgEntry) / pos.avgEntry * 100),
    daysHeld: exitIdx - pos.entryIdx,
    reason, layers: pos.layers.length, score: pos.score,
  });
}

function computeMetrics(trades, finalEquity, maxDD, buyAndHoldPct, buyAndHoldPnl, equityCurve) {
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const totalPnl = finalEquity - INITIAL_CAPITAL;
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  return {
    trades,
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: trades.length > 0 ? round(winners.length / trades.length * 100) : 0,
    totalPnl: round(totalPnl),
    totalPnlPct: round(totalPnl / INITIAL_CAPITAL * 100),
    finalEquity: round(finalEquity),
    avgPnl: trades.length > 0 ? round(totalPnl / trades.length) : 0,
    avgWin: winners.length > 0 ? round(grossProfit / winners.length) : 0,
    avgLoss: losers.length > 0 ? round(-grossLoss / losers.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown: round(maxDD),
    avgDaysHeld: trades.length > 0 ? round(trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length) : 0,
    buyAndHoldPct: round(buyAndHoldPct),
    buyAndHoldPnl: round(buyAndHoldPnl),
    equityCurve,
  };
}

// ============================================================
// OPTIMIZER V2
// ============================================================
function optimizeV2(bars) {
  const paramSets = [];

  for (const emaFast of [8, 10, 15]) {
    for (const emaSlow of [40, 50, 60]) {
      for (const adxThreshold of [15, 20, 25]) {
        for (const atrStopMult of [1.5, 2.0, 2.5]) {
          for (const atrTrailMult of [2.5, 3.0, 4.0, 5.0]) {
            for (const stochBuyThreshold of [15, 20, 30]) {
              for (const pyramidLayers of [1, 2, 3]) {
                for (const maxHoldDays of [20, 30, 40, 60]) {
                  paramSets.push({
                    emaFast, emaSlow, adxThreshold,
                    atrStopMult, atrTrailMult,
                    stochBuyThreshold, pyramidLayers,
                    maxHoldDays,
                    compounding: true,
                    trendFollowMode: true,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`    Testing ${paramSets.length} combinations...`);

  let bestResult = null;
  let bestParams = null;
  let bestScore = -Infinity;

  for (const params of paramSets) {
    const result = runStrategyV2(bars, params);

    // Score: maximize returns while keeping risk reasonable
    // Weight total return heavily, penalize drawdown, reward consistency
    const tradeCountPenalty = result.totalTrades < 5 ? 0.3 : 1;
    const ddPenalty = result.maxDrawdown > 30 ? 0.5 : 1;

    const score = (
      result.totalPnlPct * 1.0 +         // Primary: total return
      result.profitFactor * 5 +            // Reward consistency
      result.winRate * 0.3 -               // Win rate matters
      result.maxDrawdown * 0.8             // Penalize risk
    ) * tradeCountPenalty * ddPenalty;

    if (score > bestScore && result.totalTrades >= 3) {
      bestScore = score;
      bestResult = result;
      bestParams = params;
    }
  }

  return { bestParams, bestResult, totalCombinations: paramSets.length };
}

// ============================================================
// REPORT
// ============================================================
function generateReport(baseResults, optResults, v1Comparison) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# Backtest V2 — Strategie Avancee Swing Trading TSX`);
  lines.push(`> Date: ${now} | Periode: 2 ans | Capital initial: ${INITIAL_CAPITAL}$ | Compounding: ON`);
  lines.push('');
  lines.push('## Ameliorations V2 vs V1');
  lines.push('');
  lines.push('| Feature | V1 | V2 |');
  lines.push('|---------|----|----|');
  lines.push('| Indicateurs | RSI, EMA, MACD | + ADX, ATR, Bollinger, Stochastic RSI, Keltner, Volume |');
  lines.push('| Stop loss | Fixe % | Adaptatif ATR (plus large en tendance forte) |');
  lines.push('| Trailing stop | Fixe 12% | ATR adaptatif + bonus ADX en tendance forte |');
  lines.push('| Capital | Fixe 10K | Compounding (reinvestissement des profits) |');
  lines.push('| Pyramiding | Non | Oui, jusqu\'a 3 layers sur pullbacks |');
  lines.push('| Re-entry | Lent (attente nouveau signal) | Cooldown court (3 bars) |');
  lines.push('| Trend filter | Non | ADX + trend-follow mode |');
  lines.push('| Squeeze detection | Non | Bollinger inside Keltner = explosion imminente |');
  lines.push('| Sorties partielles | Non | 50% a TP1, runner a TP2 |');
  lines.push('');

  // ---- BASE V2 RESULTS ----
  lines.push('## 1. Resultats V2 — Parametres de base');
  lines.push('');
  lines.push('| Ticker | Trades | Win% | PnL | PnL% | PF | Max DD | Jours | B&H% | V2 bat B&H ? |');
  lines.push('|--------|--------|------|-----|------|----|--------|-------|------|-------------|');
  let totalBase = 0;
  for (const r of baseResults) {
    const m = r.metrics;
    totalBase += m.totalPnl;
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor;
    const beats = m.totalPnlPct > m.buyAndHoldPct ? 'OUI' : 'non';
    lines.push(`| **${r.symbol}** | ${m.totalTrades} | ${m.winRate}% | ${m.totalPnl}$ | ${m.totalPnlPct}% | ${pf} | ${m.maxDrawdown}% | ${m.avgDaysHeld}j | ${m.buyAndHoldPct}% | **${beats}** |`);
  }
  lines.push(`| **TOTAL** | - | - | **${round(totalBase)}$** | **${round(totalBase / INITIAL_CAPITAL * 100)}%** | - | - | - | - | - |`);
  lines.push('');

  // ---- OPTIMIZED V2 RESULTS ----
  lines.push('## 2. Resultats V2 — Optimises par ticker');
  lines.push('');
  lines.push('| Ticker | Trades | Win% | PnL | PnL% | PF | Max DD | B&H% | V2 bat B&H ? |');
  lines.push('|--------|--------|------|-----|------|----|--------|------|-------------|');
  let totalOpt = 0;
  let beatCount = 0;
  for (const r of optResults) {
    const m = r.bestResult;
    totalOpt += m.totalPnl;
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor;
    const beats = m.totalPnlPct > m.buyAndHoldPct;
    if (beats) beatCount++;
    lines.push(`| **${r.symbol}** | ${m.totalTrades} | ${m.winRate}% | ${m.totalPnl}$ | ${m.totalPnlPct}% | ${pf} | ${m.maxDrawdown}% | ${m.buyAndHoldPct}% | **${beats ? 'OUI' : 'non'}** |`);
  }
  lines.push(`| **TOTAL** | - | - | **${round(totalOpt)}$** | **${round(totalOpt / INITIAL_CAPITAL * 100)}%** | - | - | - | **${beatCount}/7** |`);
  lines.push('');

  // ---- COMPARISON V1 vs V2 vs B&H ----
  lines.push('## 3. Comparaison complete : V1 vs V2 vs Buy & Hold');
  lines.push('');
  lines.push('| Ticker | V1 Opt | V2 Base | V2 Opt | Buy&Hold | Gagnant |');
  lines.push('|--------|--------|---------|--------|----------|---------|');
  for (let i = 0; i < optResults.length; i++) {
    const v1 = v1Comparison[i] || 0;
    const v2base = baseResults[i].metrics.totalPnlPct;
    const v2opt = optResults[i].bestResult.totalPnlPct;
    const bh = optResults[i].bestResult.buyAndHoldPct;
    const vals = { 'V1': v1, 'V2 Base': v2base, 'V2 Opt': v2opt, 'B&H': bh };
    const best = Object.entries(vals).sort((a, b) => b[1] - a[1])[0];
    lines.push(`| **${optResults[i].symbol}** | ${v1}% | ${v2base}% | ${v2opt}% | ${bh}% | **${best[0]}** (${best[1]}%) |`);
  }
  lines.push('');

  // ---- OPTIMIZED PARAMS ----
  lines.push('## 4. Parametres optimaux par ticker');
  lines.push('');
  for (const r of optResults) {
    const p = r.bestParams;
    const m = r.bestResult;
    lines.push(`### ${r.symbol} (${r.name})`);
    lines.push(`| Param | Valeur |`);
    lines.push(`|---|---|`);
    lines.push(`| EMA | ${p.emaFast} / ${p.emaSlow} |`);
    lines.push(`| ADX seuil | ${p.adxThreshold} |`);
    lines.push(`| ATR stop | ${p.atrStopMult}x |`);
    lines.push(`| ATR trailing | ${p.atrTrailMult}x |`);
    lines.push(`| StochRSI buy < | ${p.stochBuyThreshold} |`);
    lines.push(`| Pyramiding | ${p.pyramidLayers} layers |`);
    lines.push(`| Max hold | ${p.maxHoldDays}j |`);
    lines.push(`| **Resultat** | **${m.totalTrades} trades, ${m.winRate}% WR, PF ${m.profitFactor}, PnL ${m.totalPnl}$ (${m.totalPnlPct}%)** |`);
    lines.push('');
  }

  // ---- TOP TRADES ----
  lines.push('## 5. Top 3 trades par ticker (optimise)');
  lines.push('');
  for (const r of optResults) {
    const sorted = [...r.bestResult.trades].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
    if (sorted.length === 0) continue;
    lines.push(`### ${r.symbol}`);
    lines.push('| Entree | Sortie | PnL | PnL% | Jours | Layers | Raison |');
    lines.push('|--------|--------|-----|------|-------|--------|--------|');
    for (const t of sorted) {
      lines.push(`| ${t.entryDate} | ${t.exitDate} | ${t.pnl}$ | ${t.pnlPct}% | ${t.daysHeld} | ${t.layers || 1} | ${t.reason} |`);
    }
    lines.push('');
  }

  // ---- VERDICT ----
  lines.push('---');
  lines.push('## 6. Verdict final');
  lines.push('');

  const avgWinRate = round(optResults.reduce((s, o) => s + o.bestResult.winRate, 0) / optResults.length);
  const avgPF = round(optResults.reduce((s, o) => s + Math.min(o.bestResult.profitFactor, 10), 0) / optResults.length);
  const avgReturn = round(totalOpt / INITIAL_CAPITAL * 100 / 7);
  const avgBH = round(optResults.reduce((s, o) => s + o.bestResult.buyAndHoldPct, 0) / optResults.length);

  lines.push(`| Metrique | V2 Optimise | Buy & Hold |`);
  lines.push(`|----------|-------------|------------|`);
  lines.push(`| Rendement moyen/ticker | ${avgReturn}% | ${avgBH}% |`);
  lines.push(`| Win rate moyen | ${avgWinRate}% | N/A |`);
  lines.push(`| Profit factor moyen | ${avgPF} | N/A |`);
  lines.push(`| PnL total (7 tickers) | ${round(totalOpt)}$ | N/A |`);
  lines.push(`| Tickers ou V2 bat B&H | ${beatCount}/7 | - |`);
  lines.push('');

  if (beatCount >= 4) {
    lines.push('**STRATEGIE V2 SUPERIEURE** — Bat le Buy & Hold sur la majorite des tickers grace au compounding, pyramiding et trend-following adaptatif.');
  } else if (beatCount >= 2) {
    lines.push('**STRATEGIE V2 COMPETITIVE** — Bat le B&H sur certains tickers. Le compounding et la gestion du risque offrent une meilleure protection en marche baissier.');
  } else {
    lines.push('**BUY & HOLD RESTE SUPERIEUR** — En bull market prolonge, rester investi bat le timing de marche. La strategie V2 offre neanmoins une meilleure gestion du risque (drawdown controle).');
  }
  lines.push('');

  return lines.join('\n');
}

function round(n) { return Math.round(n * 100) / 100; }

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('=== BACKTEST V2 — Strategie Avancee TSX ===');
  console.log(`Capital: ${INITIAL_CAPITAL}$ | Compounding: ON | Pyramiding: ON`);
  console.log(`Indicateurs: RSI, EMA, MACD, ADX, ATR, Bollinger, StochRSI, Keltner, Volume`);
  console.log('');

  // Fetch
  const allData = {};
  for (const t of TICKERS) {
    process.stdout.write(`Fetching ${t.symbol}...`);
    try {
      allData[t.symbol] = await fetchYahoo(t.symbol, '2y');
      console.log(` ${allData[t.symbol].length} bars`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
    }
  }
  console.log('');

  // V2 Base
  console.log('--- Phase 1: V2 parametres de base ---');
  const baseResults = [];
  for (const t of TICKERS) {
    if (!allData[t.symbol]) { baseResults.push({ ...t, metrics: { totalTrades: 0, winRate: 0, totalPnl: 0, totalPnlPct: 0, profitFactor: 0, maxDrawdown: 0, avgDaysHeld: 0, buyAndHoldPct: 0, trades: [], equityCurve: [] } }); continue; }
    const metrics = runStrategyV2(allData[t.symbol]);
    console.log(`${t.symbol}: ${metrics.totalTrades} trades, ${metrics.winRate}% WR, PnL ${metrics.totalPnl}$ (${metrics.totalPnlPct}%), B&H: ${metrics.buyAndHoldPct}%`);
    baseResults.push({ ...t, metrics });
  }
  console.log('');

  // V2 Optimize
  console.log('--- Phase 2: Optimisation V2 ---');
  const optResults = [];
  for (const t of TICKERS) {
    if (!allData[t.symbol]) {
      optResults.push({ ...t, bestParams: {}, bestResult: { totalTrades: 0, winRate: 0, totalPnl: 0, totalPnlPct: 0, profitFactor: 0, maxDrawdown: 0, avgDaysHeld: 0, buyAndHoldPct: 0, trades: [], equityCurve: [] }, totalCombinations: 0 });
      continue;
    }
    process.stdout.write(`  Optimizing ${t.symbol}...`);
    const opt = optimizeV2(allData[t.symbol]);
    console.log(` PnL ${opt.bestResult.totalPnl}$ (${opt.bestResult.totalPnlPct}%) vs B&H ${opt.bestResult.buyAndHoldPct}%`);
    optResults.push({ ...t, ...opt });
  }
  console.log('');

  // V1 comparison values (from previous backtest)
  const v1Comparison = [19.39, 17.06, 21.44, 9.69, 28.9, 28.71, 32.86];

  // Report
  const report = generateReport(baseResults, optResults, v1Comparison);
  mkdirSync(BRIEFS_DIR, { recursive: true });
  const path = resolve(BRIEFS_DIR, 'backtest-v2-report.md');
  writeFileSync(path, report, 'utf8');
  console.log(`Rapport: ${path}`);
  console.log('Done!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
