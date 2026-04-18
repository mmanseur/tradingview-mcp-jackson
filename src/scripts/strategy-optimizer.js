/**
 * Strategy Optimizer Agent — Optimise Momentum V4 + Gold Momentum Pro
 *
 * Claude analyse les paramètres, lance des backtests via Yahoo Finance,
 * itère pour trouver les meilleurs paramètres, et génère le Pine Script amélioré.
 *
 * Outils:
 *   • read_strategy        — lit le code Pine Script actuel
 *   • run_backtest_v4      — backtest Momentum V4 avec paramètres personnalisés
 *   • run_backtest_gold    — backtest Gold Momentum Pro avec paramètres personnalisés
 *   • compare_strategies   — compare les 7 stratégies sur un symbole, retourne le classement
 *   • save_pine_script     — sauvegarde le Pine Script amélioré
 *
 * Usage: node src/scripts/strategy-optimizer.js
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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

import {
  getBars, backtestV4, backtestGold, compareStrategies,
} from '../core/backtester.js';
import * as pine   from '../core/pine.js';
import * as health from '../core/health.js';


// round2 utilisé dans les résultats d'outils locaux
function round2(v) { return Math.round(v * 100) / 100; }

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
    name: 'compare_strategies',
    description:
      'Compare les 7 stratégies disponibles sur un symbole TSX via backtest Yahoo Finance 3 ans. ' +
      'Stratégies testées: Momentum V4, Gold Momentum Pro, MACD Cross, Supertrend, Donchian Pure, RSI Reversion, BB Squeeze. ' +
      'Retourne le classement par score risque-ajusté (return% - maxDD*0.5 + PF*10), le gagnant, et si un changement est recommandé.',
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
    name: 'deploy_to_tradingview',
    description:
      'Déploie un Pine Script sauvegardé localement vers TradingView Desktop: ' +
      'injecte le code dans l\'éditeur Pine, compile, vérifie les erreurs, puis sauvegarde dans le cloud TradingView. ' +
      'À appeler après save_pine_script pour que le script soit actif sur le chart.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Nom du fichier Pine Script dans scripts/, ex: "momentum-v4-optimized.pine"',
        },
      },
      required: ['filename'],
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

    case 'compare_strategies': {
      const { symbol } = input;
      try {
        return await compareStrategies(symbol);
      } catch (e) {
        return { error: `Erreur compare_strategies: ${e.message}` };
      }
    }

    case 'deploy_to_tradingview': {
      const { filename } = input;
      const filePath = resolve(SCRIPTS_DIR, filename);
      if (!existsSync(filePath)) {
        return { error: `Fichier non trouvé: ${filename} — utiliser save_pine_script d'abord` };
      }
      const source = readFileSync(filePath, 'utf8');
      try {
        // 1. Injecter le code dans l'éditeur Pine
        const setResult = await pine.setSource({ source });
        if (!setResult.success) return { error: 'Échec injection source dans Pine Editor' };

        // 2. Compiler + charger sur le chart
        const compileResult = await pine.smartCompile();

        // 3. Vérifier les erreurs
        const errResult = await pine.getErrors();
        if (errResult.has_errors) {
          return {
            deployed: false,
            filename,
            errors: errResult.errors,
            message: `${errResult.error_count} erreur(s) de compilation — script non sauvegardé`,
          };
        }

        // 4. Sauvegarder dans le cloud TradingView
        const saveResult = await pine.save();

        return {
          deployed: true,
          filename,
          lines: setResult.lines_set,
          button_clicked: compileResult.button_clicked,
          study_added: compileResult.study_added,
          save_action: saveResult.action,
          message: 'Script déployé et sauvegardé dans TradingView avec succès',
        };
      } catch (err) {
        return { error: `Erreur déploiement: ${err.message}` };
      }
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

## Stratégies alternatives disponibles (via compare_strategies)
MACD Cross, Supertrend, Donchian Pure, RSI Reversion, BB Squeeze

## Ta mission
1. Lire le code source des deux stratégies
2. Utiliser compare_strategies sur chaque ticker pour identifier la meilleure stratégie
3. Tester les paramètres actuels pour avoir un baseline
4. Explorer des variantes de paramètres (EMAs, stops, filtres) pour améliorer:
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

// ─── Vérifie / lance TradingView ─────────────────────────────
async function ensureTradingViewRunning() {
  try {
    await health.healthCheck();
    console.log('✅ TradingView connecté.');
    return true;
  } catch {
    console.log('⚠️  TradingView non détecté — tentative de lancement...');
    try {
      const result = await health.launch({});
      console.log(`🚀 TradingView lancé: ${result.mode || 'ok'}`);
      // Attendre que TV soit prêt
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try { await health.healthCheck(); console.log('✅ TradingView prêt.'); return true; } catch { /* attendre */ }
      }
      console.warn('⚠️  TradingView lancé mais connexion CDP non établie — déploiement Pine désactivé.');
      return false;
    } catch (launchErr) {
      console.warn(`⚠️  Impossible de lancer TradingView: ${launchErr.message}`);
      console.warn('   Le backtest et la comparaison fonctionneront quand même.');
      console.warn('   Seul deploy_to_tradingview sera indisponible.');
      return false;
    }
  }
}

// ─── Boucle agent ────────────────────────────────────────────
async function runOptimizer() {
  const client = new Anthropic();
  const date = new Date().toISOString().split('T')[0];

  console.log(`\n🔬 Strategy Optimizer — ${date}`);
  console.log('─'.repeat(50));

  const tvReady = await ensureTradingViewRunning();
  if (!tvReady) {
    console.log('ℹ️  Mode dégradé: backtests OK, déploiement TV désactivé.\n');
  }

  const messages = [
    {
      role: 'user',
      content: `Lance l'analyse et l'optimisation complète des deux stratégies: Momentum V4 et Gold Momentum Pro.

Objectifs:
1. Utiliser compare_strategies sur chaque ticker (BBD-B.TO, WPM.TO, AEM.TO, CLS.TO) pour identifier la meilleure stratégie
2. Tester les paramètres actuels (baseline) des stratégies gagnantes
3. Explorer au moins 3-4 variantes de paramètres par stratégie
4. Trouver la combinaison qui maximise return/drawdown ratio
5. Générer et sauvegarder le Pine Script final optimisé avec save_pine_script
6. Déployer le script dans TradingView avec deploy_to_tradingview${tvReady ? '' : '\n\nNOTE: TradingView non connecté — sauter l\'étape deploy_to_tradingview.'}`,
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
