# Backtest Momentum V4 — TSX:BBD.B
> Généré le 2026-04-12 à 00:30:19 ET

## Paramètres

| Paramètre | Valeur |
|---|---|
| Ticker | TSX:BBD.B |
| Période | 2025-01-30 → 2026-04-10 |
| Timeframe | Daily |
| Capital initial | 10 000 CAD |
| Risque/trade | 3% |
| Barres analysées | 300 |

## Données historiques

| Métrique | Valeur |
|---|---|
| Premier close | 87.21 |
| Dernier close | 258.02 |
| Rendement buy & hold | +195.86% |
| High période | 283.99 |
| Low période | 71.79 |

## Signaux V4 Actuels

| Signal | Valeur |
|---|---|
| BRK (Breakout) | 0 |
| PB (Pullback Buy) | 0 |
| ADD (Pyramiding) | 0 |
| EXIT | 0 |
| SELL | 0 |
| WEAK | 0 |

## Indicateurs Techniques Actuels

| Indicateur | Valeur |
|---|---|
| EMA Fast (8) | 253.11 |
| EMA Mid (21) | 250.05 |
| EMA Slow (50) | 248.96 |
| Donchian Hi (55j) | null |
| Donchian Lo (55j) | null |
| Chandelier Stop | null |
| ADX | null |

## Notes

> **Pour un backtest complet avec exécution des trades**, il est recommandé d'utiliser:
> 1. Le **Strategy Tester** intégré de TradingView avec le code Pine V4
> 2. Ou le mode **Replay** pour simuler manuellement les entrées/sorties
>
> Ce rapport analyse les données historiques et les signaux actuels de la stratégie.

## Règles de la Stratégie V4

### Entrées
- **BRK**: Cassure du Donchian High 55j → Entrée breakout
- **PB**: Pullback sur EMA Fast après tendance haussière → Entrée conservatrice
- **ADD**: Pyramiding sur cassure Donchian 20j (max 2 ajouts)

### Sorties
- **EXIT**: Prix sous Donchian Low 55j OU Chandelier Stop
- **SELL**: Signal de vente (tendance cassée)
- **WEAK**: Prix sous EMA Fast (alerte affaiblissement)

### Gestion de risque
- Risque max: 3% du capital par trade
- Stop-loss: EMA Slow ou Chandelier (le plus serré)
- Position sizing basé sur la distance au stop

_Backtest généré le 2026-04-12 · Momentum V4_