---
description: Analyse IA complète du portefeuille IBKR — raisonnement multi-couches sur positions réelles
---

Tu es un analyste quantitatif senior spécialisé swing trading TSX. Capital total : ~9 000 CAD, objectif +50%/an, courtier IBKR.

## Étape 1 — Lire les positions IBKR réelles

Ouvre le panneau trading et lis les positions ouvertes :
```
ui_open_panel("trading")
```

Note pour chaque position : ticker, quantité, prix moyen, P&L latent, valeur de marché.

Si aucune position → analyser uniquement les setups de la watchlist.

## Étape 2 — Collecter les données techniques par position

Pour chaque position (et les tickers watchlist sans position) :

1. `chart_set_symbol` → switcher sur le ticker
2. `chart_set_timeframe("D")` → Daily
3. `chart_get_state` → récupérer les entity IDs des indicateurs actifs
4. `data_get_study_values(study_filter="Momentum")` → BRK, PB, ADD, EXIT, SELL, WEAK, EMA Fast/Mid/Slow (V4)
   - Pour WPM/AEM : `data_get_study_values(study_filter="Gold")` → Donchian Hi/Lo, Chandelier, ADX, IsGoldPro
5. `data_get_ohlcv(summary=true)` → prix actuel, OHLC, volume, dernières barres
6. `chart_set_timeframe("240")` → 4h
7. `data_get_study_values(study_filter="Momentum")` → mêmes champs sur 4h
   - Pour WPM/AEM : `data_get_study_values(study_filter="Gold")` sur 4h

Watchlist à couvrir si pas de position IBKR :
- BBD.B.TO, WPM.TO, CLS.TO, AEM.TO, CGG.TO, VNP.TO, SHOP.TO

## Étape 3 — Raisonnement IA multi-couches

Pour chaque position/ticker, raisonne sur **4 couches** :

### Couche 1 — Signal technique brut
- Quel signal domine : BRK / PB / ADD / EXIT / SELL / WEAK / neutre ?
- Alignement EMAs Daily et 4h concordants ou divergents ?
- Pour Gold Pro (WPM/AEM) : Donchian 55j + Chandelier trailing + ADX

### Couche 2 — Contexte de la position (si position ouverte)
- P&L latent : +X% → proche du target ? Protéger avec stop trail ?
- Prix actuel vs prix moyen : extension ou retour à la moyenne ?
- Durée de la position (si connue) : combien de temps en position ?

### Couche 3 — Sizing et risque concret
Calcule pour chaque recommandation d'entrée ou d'ajout :
- Stop loss en $ par action (prix - stop)
- Risque total acceptable : 3% de 9 000 CAD = 270 CAD max
- Nombre d'actions exact = 270 / (prix - stop)
- Valeur totale de la position proposée
- Concentration : cette position représente X% du portefeuille

### Couche 4 — Synthèse portfolio global
- Corrélations : plusieurs positions gold (WPM/AEM/CGG) = risque concentré ?
- Cash disponible estimé : 9 000 CAD - valeur des positions ouvertes
- Quelle est LA priorité numéro 1 aujourd'hui ?
- Y a-t-il des actions contradictoires (acheter X, vendre Y) qui s'annulent ?

## Étape 4 — Envoi par email (pas de fichier permanent)

Génère le rapport markdown suivant (en mémoire) :

```
# Analyse IA Portefeuille — [DATE]

## Résumé Exécutif
[2-3 phrases : état global, signal dominant, priorité du jour]

## Positions IBKR

### [TICKER] — [HOLD/AJOUTER/VENDRE] 🔴/🟡/🟢
- Prix : X.XX$ | Moy : X.XX$ | P&L : +X.X%
- Signal D/4h : BRK|PB|EXIT|HOLD | Variante : V4/GoldPro
- Recommandation : [action] | Stop : X.XX$ | Target : X.XX$
- Sizing : N actions × X.XX$ = XXX$ (X% capital) — risque X$/270$ max
- Pourquoi : [2 phrases]

## Watchlist — Setups actifs
[Tickers avec BRK/PB — entrée + sizing complet]

## Portfolio Global
- Investi : X XXX$ / 9 000$ | Cash : ~X XXX$ | Corrélations : [alertes]
- Priorité #1 : [UNE action]

## Risques
[2-3 points concrets]
```

Ensuite, écris le rapport dans un fichier temporaire, envoie-le par email, puis supprime le fichier :
```bash
# Déterminer sujet et preview selon le contenu
DATE=$(date +%Y-%m-%d)
TMPFILE="D:/Claude/tradingview-mcp-jackson/reports/.tmp_scan_${DATE}.md"

# Écrire le contenu dans le fichier temporaire (remplacer [CONTENT] par le markdown généré)
cat > "$TMPFILE" << 'ENDDOC'
[CONTENU DU RAPPORT ICI]
ENDDOC

# Envoyer par email
node D:/Claude/tradingview-mcp-jackson/src/scripts/mail_report.js \
  "[Scan IA] ${DATE} — portefeuille IBKR" \
  "Analyse IA quotidienne — positions IBKR + setups TSX" \
  "$TMPFILE"

# Supprimer le fichier temporaire
rm "$TMPFILE"
```

Ne pas créer de rapport permanent. Ne pas faire de commit git.

## Règles importantes
- Ne jamais inventer des prix — lire uniquement les données MCP
- Si un indicateur est absent du chart → le noter clairement, ne pas halluciner
- Le sizing doit TOUJOURS être calculé (pas juste "acheter")
- Expliquer le POURQUOI de chaque recommandation, pas juste le QUOI
- Si signal Daily et 4h contradictoires → signaler le conflit et attendre confirmation