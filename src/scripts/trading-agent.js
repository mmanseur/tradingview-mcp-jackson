/**
 * Trading Agent — Analyse des positions + recommandations + alertes
 *
 * Architecture: Claude API + Tool Use (boucle locale)
 * Les MCP TradingView et IBKR tournent en local → on appelle les modules
 * directement plutôt qu'un Managed Agent cloud.
 *
 * Outils exposés à Claude:
 *   • get_positions       — lit les positions IBKR depuis le panneau Trading TV
 *   • analyze_symbol      — analyse technique multi-TF avec indicateur Momentum V4
 *   • get_price           — prix en temps réel (quote TradingView)
 *   • send_alert          — envoie un email d'alerte via Gmail SMTP
 *
 * Usage: node src/scripts/trading-agent.js
 * Cron: déclenchable par task scheduler ou npm run agent
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

// Charge .env (même logique que mailer.js — pas de dépendance dotenv)
{
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
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

import * as chart from '../core/chart.js';
import * as data from '../core/data.js';
import { readIbkrPositions, toTradingViewSymbol } from './ibkr_positions.js';
import { sendReportEmail } from '../core/mailer.js';
import { compareStrategies } from '../core/backtester.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(REPO_ROOT, 'reports');

// ─── Helpers ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ─── Lecteur d'indicateur (copié de scanner_v4.js) ──────────
async function readIndicator() {
  const res = await data.getStudyValues();
  const studies = res?.studies || [];
  const study = studies.find((s) => /momentum\s*v4/i.test(s.name));
  const v = study?.values;
  if (!v) return null;

  const isGoldPro    = (toNum(v['IsGoldPro'])    || 0) > 0;
  const isSupertrend = (toNum(v['IsSupertrend']) || 0) > 0;
  return {
    emaFast:         toNum(v['EMA Fast']),
    emaMid:          toNum(v['EMA Mid']),
    emaSlow:         toNum(v['EMA Slow']),
    donchianHi:      toNum(v['Donchian Hi']),
    donchianLo:      toNum(v['Donchian Lo']),
    chandelier:      toNum(v['Chandelier']),
    adx:             toNum(v['ADX']),
    BRK:             toNum(v['BRK'])  || 0,
    PB:              toNum(v['PB'])   || 0,
    ADD:             toNum(v['ADD'])  || 0,
    EXIT:            toNum(v['EXIT']) || 0,
    SELL:            toNum(v['SELL']) || 0,
    WEAK:            toNum(v['WEAK']) || 0,
    pyramidCount:    toNum(v['Pyramid Count']) || 0,
    supertrendLevel: toNum(v['Supertrend Level']),
    variant:         isGoldPro ? 'gold-pro' : isSupertrend ? 'supertrend' : 'v4',
  };
}

// ─── Définitions des outils Claude ──────────────────────────
const TOOLS = [
  {
    name: 'get_positions',
    description:
      'Lit les positions ouvertes depuis le panneau Trading IBKR de TradingView. ' +
      'Retourne la liste des positions avec symbole, côté (Long/Short), quantité, prix moyen, ' +
      'prix actuel, P&L non-réalisé, et P&L journalier.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'analyze_symbol',
    description:
      'Analyse technique complète d\'un symbole TSX sur deux timeframes (Daily + 4h). ' +
      'Navigue sur le symbole dans TradingView et lit les signaux de l\'indicateur Momentum V4 ' +
      '(ou Gold Momentum Pro pour WPM/AEM). Retourne: prix, EMAs, signaux BRK/PB/ADD/EXIT/SELL/WEAK, ADX.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbole TradingView, ex: "TSX:BBD-B", "TSX:WPM", "TSX:AEM"',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_price',
    description: 'Retourne le prix en temps réel du symbole actuellement affiché sur TradingView.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'compare_strategies',
    description:
      'Compare les 7 stratégies disponibles sur un symbole TSX via backtest Yahoo Finance 3 ans. ' +
      'Stratégies: Momentum V4, Gold Momentum Pro, MACD Cross, Supertrend, Donchian Pure, RSI Reversion, BB Squeeze. ' +
      'Utiliser quand un ticker sous-performe ou avant de changer de stratégie. ' +
      'Retourne le classement par score risque-ajusté et indique si un changement est recommandé.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbole Yahoo Finance, ex: "BBD-B.TO", "WPM.TO", "CLS.TO"',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'send_alert',
    description:
      'Envoie un email d\'alerte de trading via Gmail SMTP. ' +
      'Utiliser pour les signaux urgents: BRK (achat), SELL (vente), EXIT (sortie stop). ' +
      'Ne pas envoyer pour les signaux WEAK ou INFO.',
    input_schema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Sujet de l\'email, ex: "🔔 BRK BBD-B.TO — Signal achat"',
        },
        body: {
          type: 'string',
          description: 'Corps de l\'email en markdown avec les détails du signal',
        },
        urgency: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'high=BRK/SELL/EXIT urgents, medium=PB/ADD, low=rapport info',
        },
      },
      required: ['subject', 'body', 'urgency'],
    },
  },
];

// ─── Implémentations des outils ──────────────────────────────
async function executeTool(name, input) {
  switch (name) {
    case 'get_positions': {
      try {
        // Ouvre le panneau trading si besoin
        const positions = await readIbkrPositions();
        if (!positions.length) {
          return { positions: [], message: 'Aucune position ouverte trouvée dans IBKR.' };
        }
        return {
          positions: positions.map((p) => ({
            ...p,
            tvSymbol: toTradingViewSymbol(p),
            pnlPct: p.avgPrice > 0
              ? (((p.lastPrice - p.avgPrice) / p.avgPrice) * 100).toFixed(2) + '%'
              : null,
          })),
          count: positions.length,
        };
      } catch (err) {
        return { error: `Erreur lecture positions: ${err.message}` };
      }
    }

    case 'analyze_symbol': {
      const { symbol } = input;
      try {
        // Navigue vers le symbole
        await chart.setSymbol({ symbol });
        await sleep(2000);

        const results = {};
        for (const tf of ['D', '240']) {
          await chart.setTimeframe({ timeframe: tf });
          await sleep(1200);

          const [quote, ohlcv, indicator] = await Promise.all([
            data.getQuote({}),
            data.getOhlcv({ count: 50, summary: true }),
            readIndicator(),
          ]);

          const price = quote?.last || quote?.close;
          results[tf === 'D' ? 'daily' : '4h'] = {
            timeframe: tf === 'D' ? 'Daily' : '4h',
            price,
            high: quote?.high,
            low: quote?.low,
            volume: quote?.volume,
            avgVolume: ohlcv?.avg_volume,
            changePct: ohlcv?.change_pct,
            periodHigh: ohlcv?.high,
            periodLow: ohlcv?.low,
            indicator: indicator ?? { error: 'Indicateur non trouvé — vérifier que Momentum V4 est sur le chart' },
          };
        }
        return { symbol, ...results };
      } catch (err) {
        return { symbol, error: `Erreur analyse: ${err.message}` };
      }
    }

    case 'get_price': {
      try {
        const quote = await data.getQuote({});
        return { price: quote?.last || quote?.close, quote };
      } catch (err) {
        return { error: `Erreur prix: ${err.message}` };
      }
    }

    case 'send_alert': {
      const { subject, body, urgency } = input;
      try {
        // Sauvegarde le rapport
        if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
        const filename = `alert_${date}_${time}.md`;
        const reportPath = resolve(REPORTS_DIR, filename);
        writeFileSync(reportPath, `# ${subject}\n\n${body}`, 'utf8');

        if (urgency === 'high' || urgency === 'medium') {
          const r = await sendReportEmail({
            subject: `[Trading Agent] ${subject}`,
            reportPath,
            previewText: subject,
          });
          return r.sent
            ? { sent: true, messageId: r.messageId, file: filename }
            : { sent: false, reason: r.reason, file: filename };
        }
        return { sent: false, reason: 'urgency=low — rapport sauvegardé sans email', file: filename };
      } catch (err) {
        return { error: `Erreur alerte: ${err.message}` };
      }
    }

    case 'compare_strategies': {
      const { symbol } = input;
      try {
        return await compareStrategies(symbol);
      } catch (err) {
        return { error: `Erreur compare_strategies: ${err.message}` };
      }
    }

    default:
      return { error: `Outil inconnu: ${name}` };
  }
}

// ─── Prompt système ──────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un agent de trading swing sur le TSX (Toronto Stock Exchange) avec un capital de ~9 000 $CAD.

## Stratégie active
- **Momentum V4** (EMAs 8/21/50) pour BBD-B, CLS, CGG, VNP et autres
- **Gold Momentum Pro** (Donchian turtle, EMAs 13/26/55) pour WPM et AEM
- Courtier: Interactive Brokers (IBKR)
- Objectif: +50%/an en swing trading (quelques jours à quelques semaines)

## Signaux de l'indicateur
- **BRK** = Breakout → ENTRÉE LONG (achat)
- **PB**  = Pullback → ENTRÉE LONG en repli sur EMA (ou add si déjà en position)
- **ADD** = Pyramiding → AJOUTER au long existant (Gold Pro uniquement, max 2)
- **EXIT** = Sortie → FERMER LONG (chandelier ou Donchian Lo cassé)
- **SELL** = Vente → FERMER LONG + évaluer SHORT (alignement baissier + EMA cross)
- **WEAK** = Faiblesse → surveiller, NE PAS agir encore

## Logique LONG / SHORT
**LONG** — entrer quand:
- BRK ou PB sur Daily ET 4h en bull_align (EMA Fast > Mid > Slow)
- Supertrend crossUp (BBD-B/CLS) ou Donchian breakout (WPM/AEM)

**SHORT** — entrer quand TOUTES ces conditions sont réunies:
- Signal SELL sur Daily (bear_align + EMA crossunder)
- 4h aussi en bear_align (EMA Fast < Mid < Slow)
- Prix sous les 3 EMAs
- Confirmation: ADX > 20 ou volume > 1.3x moyenne
- NE PAS shorter un ticker en simple WEAK sans SELL confirmé

**FERMER LONG** — quand EXIT ou SELL sur Daily

**ATTENDRE** — tous les autres cas (NEUTRE, WEAK seul, signal non confirmé sur 4h)

## Règles de décision
1. Double timeframe obligatoire: signal Daily + confirmation 4h
2. SHORT = signal fort seulement, pas sur WEAK ni sur simple repli
3. Éviter: volumes faibles (< 1.3x moyenne), ADX < 20 (Gold Pro)
4. Stop max 3% du capital = ~270$ par position

## Ton processus pour chaque session
1. Lire les positions IBKR ouvertes (get_positions)
2. Pour chaque position: analyser le symbole (analyze_symbol) → CONSERVER / FERMER / INVERSER
3. Pour chaque ticker de l'univers sans position: chercher entrées LONG ou SHORT
4. Formuler des recommandations avec action explicite (LONG / SHORT / FERMER / ATTENDRE)
5. Envoyer des alertes email SEULEMENT pour les signaux LONG urgent, SHORT, EXIT

## Quand utiliser compare_strategies
- Un ticker est en WEAK depuis plus de 5 séances consécutives
- Une position est en drawdown > 15% sans signal EXIT clair
- Un ticker n'a pas généré de signal BRK/PB depuis plus de 30 jours
- L'utilisateur demande explicitement une comparaison
→ Lancer compare_strategies(symbol), présenter le top 3 et indiquer si changement recommandé

## Format de sortie — STRICT, NE PAS DÉVIER

RÈGLE ABSOLUE: chaque ticker DOIT utiliser exactement ce bloc, rien de plus, rien de moins.
Ne pas ajouter de texte narratif, d'analyse supplémentaire, de bullets, ni de commentaires hors du bloc.

Exemple exact attendu:
--- BBD-B.TO ---
ACTION    : LONG
Signal D  : BRK
Signal 4h : bull_align
Prix      : 8.45$
Entrée    : 8.45$ (marché immédiat)
Stop      : 7.95$ (-5.9% / -230$)
Cible     : 9.80$ (+16%)
Taille    : 460 actions (230$ risqué / 2.6% capital)
Urgence   : URGENT

--- WPM.TO ---
ACTION    : ATTENDRE
Signal D  : NEUTRE
Signal 4h : bull_align
Prix      : 72.10$
Entrée    : n/a
Stop      : n/a
Cible     : n/a
Taille    : n/a
Urgence   : INFO

Les seules valeurs possibles pour ACTION: LONG / SHORT / FERMER LONG / CONSERVER LONG / ATTENDRE
Pour ATTENDRE: Entrée, Stop, Cible, Taille = n/a
Calcul Taille: risque max 270$ par position, stop = distance en $ * nb actions

Sois concis et factuel. Zéro texte hors des blocs. Décisions basées uniquement sur les données.`;

// ─── Boucle d'agent principale ───────────────────────────────
async function runTradingAgent() {
  const client = new Anthropic();
  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toTimeString().split(' ')[0];

  console.log(`\n🤖 Trading Agent — ${date} ${time}`);
  console.log('─'.repeat(50));

  const messages = [
    {
      role: 'user',
      content: `Session d'analyse du ${date} à ${time}.

Effectue l'analyse complète:
1. Lis mes positions IBKR ouvertes
2. Analyse chaque position (Daily + 4h)
3. Identifie les signaux urgents (BRK, EXIT, SELL)
4. Envoie un email pour tout signal urgent
5. Fournis un rapport final avec recommandations pour toutes les positions

Univers de surveillance si pas en position: BBD-B.TO, WPM.TO, CLS.TO, AEM.TO, CGG.TO, VNP.TO, SHOP.TO`,
    },
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 20; // garde-fou

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n[Itération ${iteration}]`);

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Affiche le texte en temps réel
    let currentText = '';
    stream.on('text', (delta) => {
      process.stdout.write(delta);
      currentText += delta;
    });

    const response = await stream.finalMessage();

    if (response.stop_reason === 'end_turn') {
      console.log('\n\n✅ Agent terminé.');
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      console.log(`\n⚠️  Stop reason inattendu: ${response.stop_reason}`);
      break;
    }

    // Traite les appels d'outils
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      console.log(`\n🔧 Outil: ${block.name}`, JSON.stringify(block.input));
      const result = await executeTool(block.name, block.input);
      console.log(`   ↳ Résultat:`, JSON.stringify(result).slice(0, 200));

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error('\n⚠️  Limite d\'itérations atteinte');
  }
}

// ─── Point d'entrée ──────────────────────────────────────────
runTradingAgent().catch((err) => {
  console.error('\n❌ Erreur agent:', err.message);
  process.exit(1);
});
