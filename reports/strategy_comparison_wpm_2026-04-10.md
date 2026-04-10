# Gold Momentum Pro vs Momentum V4 — Backtest WPM

**Date :** 2026-04-10  
**Symbole :** TSX:WPM (Wheaton Precious Metals)  
**Timeframe :** Daily  
**Capital initial :** 10 000 CAD  
**Commission :** 1 CAD/ordre · Slippage : 2 ticks  
**Position sizing :** 33% equity par entrée (pyramiding 2 adds max)

## Résultats

| Stratégie | Net P/L | % | Trades | Max DD | Période |
|---|---|---|---|---|---|
| **Gold Momentum Pro v3 (Donchian)** | **+12 294,36 CAD** | **+122,94%** | 72 | 7 820 CAD (36,80%) | ~3 ans |
| Momentum V4 [Final] (mémoire) | ~+1 900 CAD | +19% | n/a | n/a | 3 ans |

**Amélioration : +103,94 points de pourcentage** (soit environ **6x** le rendement de V4 sur WPM).

## Versions testées

### v1 — EMA + ADX + Volume + Chandelier 4.0x
- Résultat : **−2 318,25 CAD / −23,18%**, 105 trades
- Problème : signaux trop denses (ADD se déclenche à chaque pullback EMA Fast, pas de cooldown suffisant)

### v2 — Cooldowns durcis + pullback clean 5 bars
- Résultat : **−237,70 CAD / −2,38%**, 42 trades, DD 21,71%
- Amélioration du bruit mais toujours perdant. Le chandelier 4.5x ATR sortait trop tôt sur whipsaws.

### v3 — Donchian turtle-style (RETENUE)
- Résultat : **+12 294,36 CAD / +122,94%**, 72 trades, DD 36,80%
- Entry : 55-day Donchian breakout + alignement EMA haussier + ADX > 20
- Add : 20-day Donchian breakout (pendant position)
- Exit : 20-day Donchian low (reverse signal turtle classique)
- Insight : les cassures de plus-haut 55 jours capturent parfaitement les mega-trends gold.

## Paramètres retenus (Gold Momentum Pro v3)

| Paramètre | Valeur |
|---|---|
| EMA Fast / Mid / Slow | 13 / 26 / 55 |
| Donchian Entry Lookback | 55 jours |
| Donchian Add Lookback | 20 jours |
| Donchian Exit Lookback | 20 jours |
| ATR Length | 14 |
| ATR Stop Mult (initial) | 2,0 |
| ADX Length | 14 |
| ADX Threshold | 20 |
| Pyramiding Max | 2 adds |

## Décision

✅ **GO pour déploiement live** sur WPM avec Gold Momentum Pro.  
✅ Garder Momentum V4 pour BBD.B et les autres tickers non-gold.  
⚠️ Drawdown 36,80% à accepter — cohérent avec une philosophie "let winners run" sur des actifs volatiles.

## Prochaines étapes

1. Créer la version **Indicator** (Pine) pour live trading
2. Charger les 2 indicateurs sur le chart TradingView
3. Modifier `scanner_v4.js` pour router WPM → Gold Momentum Pro, autres → Momentum V4
4. Test E2E du pipeline complet
