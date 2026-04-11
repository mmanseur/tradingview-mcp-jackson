---
description: Lance le scanner Momentum V4 multi-TF (Daily + 4h) sur l'univers (Watchlist + TSX 60)
---

Execute le scanner V4 via npm:

```bash
npm run scan
```

Le scanner:
- Parcourt l'univers défini dans `src/scripts/scanner_universe.json` (Watchlist perso + TSX 60, dédupliqué)
- Lit les signaux BRK/PB de l'indicateur `Momentum V4` sur Daily + 4h pour chaque ticker
- Filtre par volume moyen > 100k
- Produit `reports/scan_YYYY-MM-DD.md` trié par score
- Commit automatique sur la branche courante

Après exécution, lis le rapport généré et affiche à l'utilisateur:
1. Le nombre de matchs (setups BRK/PB détectés)
2. Le top 3 setups avec leur score
3. Le statut de la watchlist perso
4. Une recommandation concrète pour les 3 meilleurs setups (entrée, stop, risque/action)
