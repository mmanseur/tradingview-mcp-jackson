/**
 * Lit les positions IBKR depuis le panneau Trading de TradingView.
 *
 * Stratégie:
 *   1. Scrape le DOM du panneau Trading via window.evaluate
 *   2. Cherche les lignes au format "SYMBOL @EXCHANGE | Long/Short | Qty | AvgPrice | LastPrice | Change% | P/L"
 *   3. Parse chaque ligne et retourne un tableau structuré
 *
 * Prérequis: panneau Trading IBKR déjà ouvert dans TradingView.
 */
import { evaluate } from '../connection.js';

/**
 * Retourne un tableau de positions:
 *   [{ symbol, exchange, side, qty, avgPrice, lastPrice, changePct, unrealizedPnl, dailyPnl, positionId }, ...]
 */
export async function readIbkrPositions() {
  const raw = await evaluate(`
    (function() {
      var out = [];
      var seen = {};
      var els = document.querySelectorAll('[data-name], [class*="row"]');
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].innerText || '').trim();
        if (!t || t.length > 600) continue;
        // Motif: "SYMBOL @EXCHANGE\\t|\\tLong/Short\\tQTY\\t|\\tAVG\\t|\\tLAST\\t|\\t±X.XX%\\t|\\t±PL\\tCAD..."
        if (!/@(TSE|NYSE|NASDAQ|AMEX|NYSEARCA|ARCA|BATS)/.test(t)) continue;
        if (!/(Long|Short)/.test(t)) continue;
        if (seen[t]) continue;
        seen[t] = 1;
        out.push(t);
      }
      return out;
    })()
  `);

  const positions = [];
  const lines = Array.isArray(raw) ? raw : [];
  for (const line of lines) {
    const parsed = parsePositionLine(line);
    if (parsed) positions.push(parsed);
  }
  return positions;
}

/**
 * Parse une ligne comme:
 *   "BBD.B @TSE\t|\tLong\t18\t263.60\t|\t258.79\t|\t−0.67%\t|\t−86.54\tCAD\t\t|\t−31.50\tCAD\t566646102"
 */
function parsePositionLine(line) {
  // Normalise whitespace
  const clean = line.replace(/\s+/g, ' ').replace(/\|/g, ' ').trim();
  // Regex tolérante
  const re = /^([A-Z0-9.]+)\s*@(\w+)\s+(Long|Short)\s+([\d,]+)\s+([\d,.]+)\s+([\d,.]+)\s+([−+\-]?[\d.]+%)\s+([−+\-]?[\d,.]+)\s+CAD\s+([−+\-]?[\d,.]+)\s+CAD\s+(\d+)/i;
  const m = clean.match(re);
  if (!m) return null;

  const toNum = (s) => parseFloat(String(s).replace(/,/g, '').replace(/−/g, '-'));
  return {
    symbol: m[1].toUpperCase(),
    exchange: m[2].toUpperCase(),
    side: /long/i.test(m[3]) ? 'Long' : 'Short',
    qty: toNum(m[4]),
    avgPrice: toNum(m[5]),
    lastPrice: toNum(m[6]),
    changePct: m[7].replace('−', '-'),
    unrealizedPnl: toNum(m[8]),
    dailyPnl: toNum(m[9]),
    positionId: m[10],
  };
}

/**
 * Convertit le symbole IBKR (ex: "BBD.B") + exchange ("TSE")
 * vers le format TradingView (ex: "TSX:BBD.B").
 */
export function toTradingViewSymbol({ symbol, exchange }) {
  const map = { TSE: 'TSX' };
  const ex = map[exchange] || exchange;
  return `${ex}:${symbol}`;
}
