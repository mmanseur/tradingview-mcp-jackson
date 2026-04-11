# Portfolio Analyzer V4 — Documentation

Analyseur automatisé des **positions IBKR ouvertes** (lues depuis le panneau Trading de TradingView) avec recommandations concrètes par position. Multi-timeframe Daily + 4h.

> **Note** : Ce script scanne **uniquement tes positions IBKR réelles**, pas un univers statique. Il génère une recommandation (HOLD / ADD / TIGHTEN STOP / TRIM / EXIT / WATCH) pour chaque position, avec stop-loss, cibles et ratio risque/rendement.

## Fichiers

- `scanner_v4.js` — script principal (Portfolio Analyzer)
- `ibkr_positions.js` — lecture des positions depuis le panneau Trading TV
- `ensure_tv.js` — preflight CDP
- `run_scanner.bat` — wrapper pour Windows Task Scheduler
- `reports/portfolio_YYYY-MM-DD.md` — rapports d'analyse par position
- `.claude/commands/scan.md` — slash command `/scan`
- `scripts/momentum-v4-indicator.pine` — indicateur unifié (V4 + Gold Momentum Pro)
- `scripts/gold-momentum-pro-strategy.pine` — source Pine de la strategy pour backtest
- `scanner_universe.json` — *(legacy, plus utilisé par le portfolio analyzer)*

## Indicateur unifié — auto-détection par ticker

Un **seul indicateur** `"Momentum V4 [BBD-B Backtest]"` gère les deux logiques :

| Ticker détecté | Logique activée | Paramètres |
|---|---|---|
| WPM, AEM | **Gold Momentum Pro** | EMA 13/26/55, Donchian 55/20, ADX > 20 |
| Tous les autres | **Momentum V4** | EMA 8/21/50, Volume 1.3×, Cooldown 3 bars |

Le champ `IsGoldPro` dans le data window indique le mode actif (1 = Gold Pro, 0 = V4).

**Prérequis** : l'indicateur `"Momentum V4 [BBD-B Backtest]"` doit être **présent sur le chart actif**. Un seul suffit — il s'adapte automatiquement au ticker.

### Ajouter un nouveau ticker gold

Éditer `scripts/momentum-v4-indicator.pine`, ligne `isGoldTicker` :

```pine
isGoldTicker = str.contains(syminfo.ticker, "WPM")
            or str.contains(syminfo.ticker, "AEM")
            or str.contains(syminfo.ticker, "XYZ")  // nouveau ticker gold
```

Puis re-compiler et sauvegarder dans TradingView.

### Gold Momentum Pro — résultats backtest

WPM Daily (~3 ans) :
- **Net P/L : +12 294,36 CAD / +122,94%** (vs +19% Momentum V4)
- 72 trades, Max DD 36,80%
- Philosophie : Donchian 55/20 turtle + pyramiding 2 adds + Chandelier trailing

Détails : `reports/strategy_comparison_wpm_2026-04-10.md`

## Prérequis

1. **TradingView Desktop** lancé avec CDP:
   ```bash
   tradingview.exe --remote-debugging-port=9222
   ```
2. **Indicateur Momentum V4** ajouté sur le chart actif (il est réutilisé pour chaque ticker pendant le scan).
3. Node 18+, dépendances installées (`npm install`).

## Utilisation manuelle

```bash
# Via npm
npm run scan

# Ou directement
node src/scripts/scanner_v4.js
```

## Utilisation dans Claude Code

```
/scan
```

Claude lance le scanner, lit le rapport, et affiche les meilleurs setups avec plan de trade.

## Paramètres

Éditer `scanner_universe.json`:

```json
{
  "min_volume": 100000,          // Volume moyen min (filtre liquidité)
  "watchlist": ["TSX:BBD.B", …], // Priorité haute, marquées ⭐
  "tsx60": ["TSX:RY", …]          // TSX 60
}
```

Éditer en tête de `scanner_v4.js`:

```js
const TIMEFRAMES = ['D', '240'];        // Daily + 4h
const SIGNALS_TO_DETECT = ['BRK', 'PB']; // Signaux ciblés
```

## Format du rapport

Chaque scan produit `reports/scan_YYYY-MM-DD.md` contenant :

1. **Setups détectés** — table triée par score (0–10)
2. **Détails par setup** — EMAs, alignement, extension, plan de trade
3. **Statut watchlist** — vue fixe des 5 tickers perso
4. **Erreurs** — symboles qui ont échoué

Le scanner commit automatiquement le rapport avec le message :
```
scan: Momentum V4 report YYYY-MM-DD (N matches)
```

## Scoring

| Condition | Points |
|---|---|
| BRK sur Daily | +4 |
| PB sur Daily | +3 |
| Alignement EMAs haussier (Daily) | +1.5 |
| BRK sur 4h | +1 |
| PB sur 4h | +1 |
| Alignement EMAs haussier (4h) | +0.5 |
| Extension > 8% au-dessus EMA Fast | −1 |

## Automatisation cron (8h30 lun-ven)

### Windows — Task Scheduler
1. Ouvrir **Task Scheduler** → Create Basic Task
2. Trigger: Weekly, Mon-Fri, 08:30
3. Action: Start a program
   - Program: `node`
   - Arguments: `src/scripts/scanner_v4.js`
   - Start in: `D:\Claude\tradingview-mcp-jackson`

### Via Claude Code `CronCreate`
Demande à Claude:
> Crée un cron qui lance `npm run scan` tous les jours ouvrables à 8h30

### Via `/schedule` skill
Demande à Claude:
> /schedule run npm run scan daily at 8:30 weekdays

## Intégration avec le briefing 9h25

Le scanner tourne à 8h30, le briefing à 9h25 — Claude lira automatiquement le dernier rapport dans `reports/` pour enrichir le brief avec les setups détectés.

## 📧 Notifications Email (Gmail SMTP)

Le Portfolio Analyzer envoie **systématiquement** un email à `GMAIL_TO` avec le rapport complet (analyse quotidienne du portefeuille, pas seulement alertes). Le sujet indique le niveau d'attention : 🔴 critique · 🟢 opportunité · ✅ tout OK.

### Configuration — Créer un Gmail App Password

1. Active la **2-Step Verification** sur ton compte Google : https://myaccount.google.com/security
2. Va sur https://myaccount.google.com/apppasswords
3. Crée un App Password nommé "Claude Scanner"
4. Google te donne un code 16 caractères (ex: `abcd efgh ijkl mnop`)

### Configuration — Fichier .env

Copie `.env.example` vers `.env` et remplis :

```bash
cp .env.example .env
```

```
GMAIL_USER=mmanseur@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
GMAIL_TO=mmanseur@gmail.com
MAIL_DISABLED=0
```

Le fichier `.env` est déjà dans `.gitignore` — il ne sera jamais committé.

### Tester l'envoi manuellement

```bash
npm run test:mail
```

Ça envoie le dernier rapport `reports/scan_*.md` à ton adresse — parfait pour valider avant d'activer le cron.

### Désactiver temporairement

Mets `MAIL_DISABLED=1` dans `.env` (ou supprime `GMAIL_APP_PASSWORD`).

## Limitations connues

- L'indicateur Momentum V4 doit être **présent sur le chart** avant de lancer le scan (le scanner ne l'ajoute pas automatiquement).
- Temps d'un scan complet ~5-12 min pour 65 symboles × 2 timeframes.
- Les valeurs BRK/PB sont lues telles qu'affichées par l'indicateur (0 ou > 0).

## 🟢 Preflight CDP (ensure_tv.js)

Le wrapper `run_scanner.bat` appelle d'abord `src/scripts/ensure_tv.js` qui :

1. Pingue CDP port 9222 (`GET /json/version`)
2. Si OK → continue (exit 0)
3. Si inaccessible → génère `reports/alert_cdp_YYYY-MM-DD.md`, envoie un email d'alerte et annule le scan (exit 2)

Test manuel:
```bash
node src/scripts/ensure_tv.js
```

### Pourquoi pas d'auto-lancement ?

L'auto-lancement a été retiré pour sécurité. Raisons :

- Sur un setup **Edge browser mode** (TradingView Web), relancer créerait une 2e instance vide qui prendrait le port 9222 et écraserait l'état réel (chart, indicateurs, layouts).
- Sur un setup **TradingView Desktop MSIX** (Microsoft Store), le path `TradingView.exe` n'est pas détectable via `where` → `core/health.js::launch()` fallback systématiquement sur un browser vide, ce qui est indésirable.

**Approche retenue :** laisser TradingView tourner en permanence (l'app est légère en idle) et alerter par email si le CDP tombe à 8h30. Le scan du jour est annulé proprement, l'utilisateur relance manuellement après avoir vérifié l'état de TV.
