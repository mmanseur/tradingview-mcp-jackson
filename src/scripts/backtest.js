/**
 * Backtester — Swing Trading Strategy for TSX Watchlist
 *
 * Fetches 2 years of daily OHLCV from Yahoo Finance,
 * runs the strategy (RSI/EMA/MACD signals + stop loss / take profit),
 * then optimizes parameters per ticker.
 *
 * Output: Desktop/briefs/backtest-report.md
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';

const BRIEFS_DIR = resolve(process.env.USERPROFILE || process.env.HOME, 'Desktop', 'briefs');
const CAPITAL = 10000;
const RISK_PCT = 0.03;
const MAX_RISK = CAPITAL * RISK_PCT;

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
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includePrePost=false`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const result = json.chart.result[0];
          const timestamps = result.timestamp;
          const q = result.indicators.quote[0];
          const bars = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (q.close[i] == null) continue;
            bars.push({
              date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
              open: q.open[i],
              high: q.high[i],
              low: q.low[i],
              close: q.close[i],
              volume: q.volume[i],
            });
          }
          resolve(bars);
        } catch (e) {
          reject(new Error(`Parse error for ${symbol}: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ============================================================
// INDICATORS
// ============================================================
function calcEMA(data, period) {
  const ema = new Array(data.length).fill(null);
  if (data.length < period) return ema;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  // Signal line = EMA of MACD line
  const validMacd = [];
  const validIdx = [];
  macdLine.forEach((v, i) => { if (v !== null) { validMacd.push(v); validIdx.push(i); } });
  const sigEma = calcEMA(validMacd, signal);
  const signalLine = new Array(closes.length).fill(null);
  const histogram = new Array(closes.length).fill(null);
  for (let j = 0; j < validIdx.length; j++) {
    signalLine[validIdx[j]] = sigEma[j];
    if (macdLine[validIdx[j]] !== null && sigEma[j] !== null) {
      histogram[validIdx[j]] = macdLine[validIdx[j]] - sigEma[j];
    }
  }
  return { macdLine, signalLine, histogram };
}

function findSwingLow(lows, idx, lookback = 20) {
  const start = Math.max(0, idx - lookback);
  let min = Infinity;
  for (let i = start; i < idx; i++) {
    if (lows[i] < min) min = lows[i];
  }
  return min;
}

function findSwingHigh(highs, idx, lookback = 20) {
  const start = Math.max(0, idx - lookback);
  let max = -Infinity;
  for (let i = start; i < idx; i++) {
    if (highs[i] > max) max = highs[i];
  }
  return max;
}

// ============================================================
// STRATEGY ENGINE
// ============================================================
function runStrategy(bars, params = {}) {
  const {
    rsiPeriod = 14,
    emaFast = 20,
    emaSlow = 50,
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9,
    rsiBuyThreshold = 45,
    rsiSellThreshold = 70,
    stopLossPct = 0.03,    // 3% below support
    tp1Pct = 0.00,         // TP1 at resistance
    tp2Pct = 0.03,         // TP2 = resistance + 3%
    trailingStopPct = 0.08, // 8% trailing stop
    maxHoldDays = 20,
  } = params;

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  const rsi = calcRSI(closes, rsiPeriod);
  const emaF = calcEMA(closes, emaFast);
  const emaS = calcEMA(closes, emaSlow);
  const macd = calcMACD(closes, macdFast, macdSlow, macdSignal);

  const trades = [];
  let position = null;

  for (let i = emaSlow + 10; i < bars.length; i++) {
    const price = closes[i];
    const bar = bars[i];

    // --- EXIT LOGIC ---
    if (position) {
      const daysHeld = i - position.entryIdx;
      const support = findSwingLow(lows, i, 20);

      // Stop loss hit (intraday low)
      if (lows[i] <= position.stopLoss) {
        closeTrade(position, position.stopLoss, bar.date, i, 'Stop Loss', trades);
        position = null;
        continue;
      }

      // Trailing stop
      if (highs[i] > position.highSinceEntry) position.highSinceEntry = highs[i];
      const trailingStop = position.highSinceEntry * (1 - trailingStopPct);
      if (price < trailingStop && daysHeld > 3) {
        closeTrade(position, price, bar.date, i, 'Trailing Stop', trades);
        position = null;
        continue;
      }

      // TP1 — sell 50% at resistance
      if (!position.tp1Hit && price >= position.tp1) {
        position.tp1Hit = true;
        position.sharesReduced = Math.floor(position.shares / 2);
        // Record partial exit
      }

      // TP2 — sell rest
      if (price >= position.tp2) {
        closeTrade(position, price, bar.date, i, 'TP2', trades);
        position = null;
        continue;
      }

      // RSI overbought exit
      if (rsi[i] !== null && rsi[i] > rsiSellThreshold && daysHeld > 2) {
        closeTrade(position, price, bar.date, i, 'RSI Overbought', trades);
        position = null;
        continue;
      }

      // Max hold time
      if (daysHeld >= maxHoldDays) {
        closeTrade(position, price, bar.date, i, 'Max Hold', trades);
        position = null;
        continue;
      }

      continue;
    }

    // --- ENTRY LOGIC ---
    if (rsi[i] === null || emaF[i] === null || emaS[i] === null || macd.histogram[i] === null) continue;

    let score = 0;

    // RSI signal
    if (rsi[i] < 30) score += 2;
    else if (rsi[i] < rsiBuyThreshold) score += 1;
    else if (rsi[i] > 55) score -= 0;

    // EMA alignment
    if (price > emaF[i]) score += 1;
    if (price > emaS[i]) score += 1;
    if (emaF[i] > emaS[i]) score += 1; // Golden alignment

    // MACD
    if (macd.histogram[i] > 0 && macd.histogram[i] > (macd.histogram[i - 1] || 0)) score += 1;
    else if (macd.histogram[i] < 0) score -= 1;

    // MACD crossover (signal line cross)
    if (macd.macdLine[i] > macd.signalLine[i] && macd.macdLine[i - 1] <= macd.signalLine[i - 1]) {
      score += 2; // Bullish crossover bonus
    }

    if (score >= 3) {
      const support = findSwingLow(lows, i, 20);
      const resistance = findSwingHigh(highs, i, 20);
      const stopLoss = support * (1 - stopLossPct);
      const tp1 = resistance * (1 + tp1Pct);
      const tp2 = resistance * (1 + tp2Pct);

      const riskPerShare = price - stopLoss;
      if (riskPerShare <= 0) continue;

      let shares = Math.floor(MAX_RISK / riskPerShare);
      if (shares * price > CAPITAL) shares = Math.floor(CAPITAL / price);
      if (shares <= 0) continue;

      position = {
        entryPrice: price,
        entryDate: bar.date,
        entryIdx: i,
        shares,
        stopLoss,
        tp1,
        tp2,
        tp1Hit: false,
        sharesReduced: 0,
        highSinceEntry: price,
        score,
      };
    }
  }

  // Close any open position at end
  if (position) {
    closeTrade(position, closes[closes.length - 1], bars[bars.length - 1].date, bars.length - 1, 'End of Period', trades);
  }

  return computeMetrics(trades, bars);
}

function closeTrade(pos, exitPrice, exitDate, exitIdx, reason, trades) {
  const pnl = (exitPrice - pos.entryPrice) * pos.shares;
  const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
  const daysHeld = exitIdx - pos.entryIdx;
  trades.push({
    entryDate: pos.entryDate,
    exitDate,
    entryPrice: round(pos.entryPrice),
    exitPrice: round(exitPrice),
    shares: pos.shares,
    pnl: round(pnl),
    pnlPct: round(pnlPct),
    daysHeld,
    reason,
    score: pos.score,
  });
}

function computeMetrics(trades, bars) {
  if (trades.length === 0) {
    return { trades: [], totalTrades: 0, winners: 0, losers: 0, winRate: 0, totalPnl: 0, avgPnl: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, maxDrawdown: 0, avgDaysHeld: 0, buyAndHold: 0 };
  }

  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  // Max drawdown
  let peak = CAPITAL;
  let equity = CAPITAL;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Buy & Hold comparison
  const startPrice = bars[50]?.close || bars[0].close; // after warmup
  const endPrice = bars[bars.length - 1].close;
  const buyAndHold = (endPrice - startPrice) / startPrice * 100;

  return {
    trades,
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: round(winners.length / trades.length * 100),
    totalPnl: round(totalPnl),
    totalPnlPct: round(totalPnl / CAPITAL * 100),
    avgPnl: round(totalPnl / trades.length),
    avgWin: winners.length > 0 ? round(grossProfit / winners.length) : 0,
    avgLoss: losers.length > 0 ? round(-grossLoss / losers.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: round(maxDD),
    avgDaysHeld: round(trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length),
    buyAndHold: round(buyAndHold),
    finalEquity: round(CAPITAL + totalPnl),
  };
}

// ============================================================
// OPTIMIZER
// ============================================================
function optimize(bars) {
  const paramGrid = [];

  // Generate parameter combinations
  for (const rsiPeriod of [10, 14, 21]) {
    for (const emaFast of [10, 15, 20]) {
      for (const emaSlow of [40, 50, 60]) {
        for (const rsiBuyThreshold of [35, 40, 45, 50]) {
          for (const stopLossPct of [0.01, 0.02, 0.03, 0.05]) {
            for (const trailingStopPct of [0.05, 0.08, 0.10, 0.12]) {
              for (const maxHoldDays of [10, 15, 20, 30]) {
                paramGrid.push({
                  rsiPeriod, emaFast, emaSlow,
                  rsiBuyThreshold, stopLossPct,
                  trailingStopPct, maxHoldDays,
                });
              }
            }
          }
        }
      }
    }
  }

  console.log(`    Testing ${paramGrid.length} parameter combinations...`);

  let bestResult = null;
  let bestParams = null;
  let bestScore = -Infinity;

  for (const params of paramGrid) {
    const result = runStrategy(bars, params);
    // Score: weighted combination of profit factor, win rate, and total PnL
    // Penalize low trade count (< 5 trades = unreliable)
    const tradeCountPenalty = result.totalTrades < 5 ? 0.5 : 1;
    const score = (
      result.profitFactor * 2 +
      result.winRate * 0.5 +
      result.totalPnlPct * 0.3 -
      result.maxDrawdown * 0.5
    ) * tradeCountPenalty;

    if (score > bestScore && result.totalTrades >= 3) {
      bestScore = score;
      bestResult = result;
      bestParams = params;
    }
  }

  return { bestParams, bestResult, totalCombinations: paramGrid.length };
}

// ============================================================
// REPORT GENERATION
// ============================================================
function generateReport(results, optimized) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# Rapport de Backtest — Strategie Swing Trading TSX`);
  lines.push(`> Date: ${now} | Periode: 2 ans | Capital: ${CAPITAL}$ | Risque: ${RISK_PCT * 100}%`);
  lines.push('');

  // ---- SUMMARY TABLE ----
  lines.push('## 1. Resultats — Strategie de base (RSI 14, EMA 20/50, MACD 12/26/9)');
  lines.push('');
  lines.push('| Ticker | Trades | Win% | PnL | PnL% | Profit Factor | Max DD | Jours moy | Buy&Hold |');
  lines.push('|--------|--------|------|-----|------|---------------|--------|-----------|----------|');
  let totalBasePnl = 0;
  for (const r of results) {
    const m = r.metrics;
    totalBasePnl += m.totalPnl;
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor;
    lines.push(`| **${r.symbol}** | ${m.totalTrades} | ${m.winRate}% | ${m.totalPnl}$ | ${m.totalPnlPct}% | ${pf} | ${m.maxDrawdown}% | ${m.avgDaysHeld}j | ${m.buyAndHold}% |`);
  }
  lines.push(`| **TOTAL** | - | - | **${round(totalBasePnl)}$** | **${round(totalBasePnl / CAPITAL * 100)}%** | - | - | - | - |`);
  lines.push('');

  // ---- TRADE DETAILS (top 5 per ticker) ----
  lines.push('## 2. Meilleurs et pires trades (strategie de base)');
  lines.push('');
  for (const r of results) {
    if (r.metrics.trades.length === 0) continue;
    lines.push(`### ${r.symbol} (${r.name})`);
    lines.push('| Entree | Sortie | Prix E | Prix S | PnL | PnL% | Jours | Raison |');
    lines.push('|--------|--------|--------|--------|-----|------|-------|--------|');
    const sorted = [...r.metrics.trades].sort((a, b) => b.pnl - a.pnl);
    const top = sorted.slice(0, 3);
    const bottom = sorted.slice(-3).reverse();
    const shown = [...top, ...bottom].filter((t, i, arr) => arr.findIndex(x => x.entryDate === t.entryDate) === i);
    for (const t of shown) {
      lines.push(`| ${t.entryDate} | ${t.exitDate} | ${t.entryPrice} | ${t.exitPrice} | ${t.pnl}$ | ${t.pnlPct}% | ${t.daysHeld} | ${t.reason} |`);
    }
    lines.push('');
  }

  // ---- OPTIMIZED RESULTS ----
  lines.push('---');
  lines.push('## 3. Resultats optimises (meilleurs parametres par ticker)');
  lines.push('');
  lines.push('| Ticker | Trades | Win% | PnL | PnL% | PF | Max DD | RSI | EMA F/S | Buy RSI< | Stop% | Trail% | Hold |');
  lines.push('|--------|--------|------|-----|------|----|--------|-----|---------|----------|-------|--------|------|');
  let totalOptPnl = 0;
  for (const o of optimized) {
    const m = o.bestResult;
    const p = o.bestParams;
    totalOptPnl += m.totalPnl;
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor;
    lines.push(`| **${o.symbol}** | ${m.totalTrades} | ${m.winRate}% | ${m.totalPnl}$ | ${m.totalPnlPct}% | ${pf} | ${m.maxDrawdown}% | ${p.rsiPeriod} | ${p.emaFast}/${p.emaSlow} | ${p.rsiBuyThreshold} | ${round(p.stopLossPct * 100)}% | ${round(p.trailingStopPct * 100)}% | ${p.maxHoldDays}j |`);
  }
  lines.push(`| **TOTAL** | - | - | **${round(totalOptPnl)}$** | **${round(totalOptPnl / CAPITAL * 100)}%** | - | - | - | - | - | - | - | - |`);
  lines.push('');

  // ---- COMPARISON ----
  lines.push('## 4. Comparaison : Base vs Optimise vs Buy & Hold');
  lines.push('');
  lines.push('| Ticker | Base PnL | Optimise PnL | Buy&Hold | Meilleure approche |');
  lines.push('|--------|----------|-------------|----------|-------------------|');
  for (let i = 0; i < results.length; i++) {
    const base = results[i].metrics;
    const opt = optimized[i].bestResult;
    const bh = base.buyAndHold;
    const basePct = base.totalPnlPct;
    const optPct = opt.totalPnlPct;
    const best = optPct >= basePct && optPct >= bh ? 'Optimise' : basePct >= bh ? 'Base' : 'Buy & Hold';
    lines.push(`| **${results[i].symbol}** | ${basePct}% | ${optPct}% | ${bh}% | **${best}** |`);
  }
  lines.push('');

  // ---- RECOMMENDED PARAMS ----
  lines.push('## 5. Parametres recommandes par ticker');
  lines.push('');
  for (const o of optimized) {
    const p = o.bestParams;
    const m = o.bestResult;
    lines.push(`### ${o.symbol} (${o.name})`);
    lines.push(`- **RSI**: periode ${p.rsiPeriod}, achat si < ${p.rsiBuyThreshold}`);
    lines.push(`- **EMA**: rapide ${p.emaFast}, lente ${p.emaSlow}`);
    lines.push(`- **Stop loss**: ${round(p.stopLossPct * 100)}% sous le support`);
    lines.push(`- **Trailing stop**: ${round(p.trailingStopPct * 100)}%`);
    lines.push(`- **Max hold**: ${p.maxHoldDays} jours`);
    lines.push(`- **Resultat**: ${m.totalTrades} trades, ${m.winRate}% win rate, PF ${m.profitFactor}, PnL ${m.totalPnl}$`);
    lines.push('');
  }

  // ---- VERDICT ----
  lines.push('---');
  lines.push('## 6. Verdict');
  lines.push('');

  const avgWinRate = round(optimized.reduce((s, o) => s + o.bestResult.winRate, 0) / optimized.length);
  const avgPF = round(optimized.reduce((s, o) => s + (o.bestResult.profitFactor === Infinity ? 3 : o.bestResult.profitFactor), 0) / optimized.length);

  if (avgWinRate > 55 && avgPF > 1.3) {
    lines.push('**STRATEGIE VIABLE** — Les backtests montrent des resultats positifs avec les parametres optimises.');
  } else if (avgWinRate > 45 && avgPF > 1.0) {
    lines.push('**STRATEGIE MARGINALE** — Resultats mixtes. Certains tickers performent bien, d\'autres non. Ajuster les parametres par ticker.');
  } else {
    lines.push('**STRATEGIE A REVOIR** — Les rendements ne justifient pas le risque. Considerer une approche differente.');
  }
  lines.push('');
  lines.push(`- Win rate moyen (optimise): ${avgWinRate}%`);
  lines.push(`- Profit factor moyen: ${avgPF}`);
  lines.push(`- PnL total (base): ${round(totalBasePnl)}$ (${round(totalBasePnl / CAPITAL * 100)}%)`);
  lines.push(`- PnL total (optimise): ${round(totalOptPnl)}$ (${round(totalOptPnl / CAPITAL * 100)}%)`);
  lines.push('');

  return lines.join('\n');
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('=== BACKTEST — Strategie Swing Trading TSX ===');
  console.log(`Capital: ${CAPITAL}$ | Risque: ${RISK_PCT * 100}% | Periode: 2 ans`);
  console.log('');

  // Fetch data
  const allData = {};
  for (const t of TICKERS) {
    process.stdout.write(`Fetching ${t.symbol}...`);
    try {
      allData[t.symbol] = await fetchYahoo(t.symbol, '2y');
      console.log(` ${allData[t.symbol].length} bars`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
      allData[t.symbol] = null;
    }
  }
  console.log('');

  // Run base strategy
  console.log('--- Phase 1: Strategie de base ---');
  const baseResults = [];
  for (const t of TICKERS) {
    if (!allData[t.symbol]) { baseResults.push({ ...t, metrics: computeMetrics([], []) }); continue; }
    const metrics = runStrategy(allData[t.symbol]);
    console.log(`${t.symbol}: ${metrics.totalTrades} trades, ${metrics.winRate}% WR, PnL ${metrics.totalPnl}$, PF ${metrics.profitFactor}`);
    baseResults.push({ ...t, metrics });
  }
  console.log('');

  // Optimize
  console.log('--- Phase 2: Optimisation par ticker ---');
  const optimizedResults = [];
  for (const t of TICKERS) {
    if (!allData[t.symbol]) {
      optimizedResults.push({ ...t, bestParams: {}, bestResult: computeMetrics([], []), totalCombinations: 0 });
      continue;
    }
    process.stdout.write(`  Optimizing ${t.symbol}...`);
    const opt = optimize(allData[t.symbol]);
    console.log(` Best: ${opt.bestResult.totalTrades} trades, ${opt.bestResult.winRate}% WR, PnL ${opt.bestResult.totalPnl}$`);
    optimizedResults.push({ ...t, ...opt });
  }
  console.log('');

  // Generate report
  const report = generateReport(baseResults, optimizedResults);
  mkdirSync(BRIEFS_DIR, { recursive: true });
  const reportPath = resolve(BRIEFS_DIR, 'backtest-report.md');
  writeFileSync(reportPath, report, 'utf8');
  console.log(`Rapport sauvegarde: ${reportPath}`);
  console.log('Done!');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
