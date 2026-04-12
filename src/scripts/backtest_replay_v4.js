/**
 * Backtest Momentum V4 avec Replay — BBD-B.TO
 *
 * Utilise le mode Replay de TradingView pour simuler barre par barre
 * et capturer les signaux V4 historiques.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

// ---------- Config ----------
const SYMBOL = 'TSX:BBD.B';
const START_DATE = '2024-06-01'; // Date de début du backtest
const CAPITAL_START = 10000;
const RISK_PER_TRADE = 0.03;

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

// ---------- Instructions ----------
const INSTRUCTIONS = `
============================================================
BACKTEST MOMENTUM V4 — ${SYMBOL}
============================================================

Ce script va guider le backtest étape par étape.

PARAMÈTRES:
- Ticker: ${SYMBOL}
- Capital: ${CAPITAL_START.toLocaleString()} CAD
- Risque/trade: ${RISK_PER_TRADE * 100}%
- Date début: ${START_DATE}

INSTRUCTIONS MANUELLES:

1. Dans TradingView, active le mode REPLAY:
   - Appuie sur le bouton ▶️ REPLAY en haut du chart
   - Ou utilise le raccourci: Ctrl+R

2. Règle la date de début:
   - Déplace le curseur au ${START_DATE}
   - Ou utilise: Barres → Aller à la date

3. Pour chaque barre, note les signaux V4:
   - BRK (Breakout): Entrée long
   - PB (Pullback Buy): Entrée long
   - ADD: Ajout à la position
   - EXIT: Sortie complète
   - SELL: Sortie complète
   - WEAK: Réduire position

4. Règles de trading:
   - Entrée sur BRK ou PB
   - Stop: EMA Slow (50) ou Chandelier
   - Pyramiding: Max 2 ajouts sur ADD
   - Sortie sur EXIT ou SELL

FORMAT DE Saisie:
Chaque trade = { date, action, price, signal }

Appuie sur ENTRÉE quand tu es prêt à commencer...
`;

// ---------- Main ----------
async function run() {
  const startedAt = new Date();
  const dateStr = startedAt.toISOString().split('T')[0];
  const timeStr = startedAt.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour12: false });

  console.log(INSTRUCTIONS);

  // Attendre confirmation
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });

  console.log('\nDémarrage du backtest...');
  console.log('Préparation du rapport template...');

  // Générer le template de rapport
  const md = generateBacktestTemplate({
    dateStr,
    timeStr,
    symbol: SYMBOL,
    startDate: START_DATE
  });

  mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = resolve(REPORTS_DIR, `backtest_replay_${SYMBOL.replace(':', '_')}_${dateStr}.md`);
  writeFileSync(filePath, md, 'utf8');

  console.log(`\nTemplate créé: ${filePath}`);
  console.log('\n=== PROCHAINES ÉTAPES ===');
  console.log('1. Va sur TradingView');
  console.log('2. Charge le ticker ' + SYMBOL);
  console.log('3. Ajoute l\'indicateur "Momentum V4"');
  console.log('4. Active le mode REPLAY');
  console.log('5. Règle la date au ' + START_DATE);
  console.log('6. Avance barre par barre et note chaque signal');
  console.log('7. Complète le rapport markdown avec tes trades');
  console.log('\nPour t\'aider, voici un exemple de trade log:\n');

  printExampleTradeLog();
}

function generateBacktestTemplate({ dateStr, timeStr, symbol, startDate }) {
  const L = [];

  L.push(`# Backtest Momentum V4 — ${symbol}`);
  L.push(`> Mode: Replay Manual | Généré: ${dateStr} ${timeStr} ET`);
  L.push('');

  L.push('## Configuration');
  L.push('');
  L.push(`| Paramètre | Valeur |`);
  L.push(`|---|---|`);
  L.push(`| Ticker | ${symbol} |`);
  L.push(`| Date début | ${startDate} |`);
  L.push(`| Capital initial | ${CAPITAL_START.toLocaleString()} CAD |`);
  L.push(`| Risque/trade | ${RISK_PER_TRADE * 100}% (${(CAPITAL_START * RISK_PER_TRADE).toFixed(0)} CAD) |`);
  L.push(`| Timeframe | Daily |`);
  L.push(`| Stratégie | Momentum V4 |`);
  L.push('');

  L.push('## Log des Trades');
  L.push('');
  L.push('<!-- Remplis cette section pendant le replay -->');
  L.push('');
  L.push('| # | Date | Action | Signal | Prix | Shares | Stop | P/L | Cum P/L |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  L.push('| 1 | YYYY-MM-DD | BUY | BRK | 0.00 | 0 | 0.00 | - | - |');
  L.push('| 2 | YYYY-MM-DD | SELL | EXIT | 0.00 | 0 | - | 0.00 | 0.00 |');
  L.push('');

  L.push('## Résumé des Trades');
  L.push('');
  L.push('<!-- À remplir après le backtest -->');
  L.push('');
  L.push('| Métrique | Valeur |');
  L.push(`|---|---|`);
  L.push(`| Nombre de trades | - |`);
  L.push(`| Win rate | -% |`);
  L.push(`| Profit total | - CAD |`);
  L.push(`| Profit % | -% |`);
  L.push(`| Profit factor | - |`);
  L.push(`| Max drawdown | -% |`);
  L.push(`| Gain moyen | - CAD |`);
  L.push(`| Perte moyenne | - CAD |`);
  L.push('');

  L.push('## Signaux Observés');
  L.push('');
  L.push('### Entrées (BRK/PB)');
  L.push('- Date: Signal → Prix');
  L.push('');
  L.push('### Ajouts (ADD)');
  L.push('- Date: Signal → Prix');
  L.push('');
  L.push('### Sorties (EXIT/SELL)');
  L.push('- Date: Signal → Prix → P/L');
  L.push('');

  L.push('## Analyse');
  L.push('');
  L.push('### Points forts de la stratégie');
  L.push('- ');
  L.push('');
  L.push('### Points faibles / Améliorations');
  L.push('- ');
  L.push('');
  L.push('### Comparaison Buy & Hold');
  L.push('- Rendement B&H: __%');
  L.push('- Rendement V4: __%');
  L.push('- Surperformance: __%');
  L.push('');

  L.push('## Notes');
  L.push('');
  L.push('_Backtest manuel via Replay Mode · À compléter_');

  return L.join('\n');
}

function printExampleTradeLog() {
  console.log('```');
  console.log('EXEMPLE DE LOG:');
  console.log('');
  console.log('Trade #1:');
  console.log('  Date: 2024-06-15');
  console.log('  Signal: BRK (Breakout Donchian 55j)');
  console.log('  Prix entrée: 85.50');
  console.log('  Stop: 82.00 (EMA 50)');
  console.log('  Risque: 3.50 CAD/action');
  console.log('  Shares: 85 (300$ / 3.50)');
  console.log('  Position: 7,267 CAD');
  console.log('');
  console.log('Trade #1 - Sortie:');
  console.log('  Date: 2024-07-20');
  console.log('  Signal: EXIT (prix sous Chandelier)');
  console.log('  Prix sortie: 92.30');
  console.log('  P/L: +578 CAD (+8%)');
  console.log('```');
  console.log('');
}

run().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
