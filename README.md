# Elo Euroleague

Classement Elo des joueurs d'Euroleague, de 2000-01 à aujourd'hui, mis à jour automatiquement chaque nuit.

## Comment ça marche

- `fetch-euroleague.js` télécharge les matchs et fiches de stats depuis l'API publique officielle de l'Euroleague.
- `compact.js` condense une saison dans `data/history/<saison>.json` (versionné).
- `build-euroleague.js` calcule l'Elo de toute l'histoire et écrit `site/euroleague.json`.
- `update.js` enchaîne les trois pour la saison en cours.
- `fetch-nba-careers.js` récupère sur Wikidata (licence CC0) les joueurs passés par la NBA, pour l'Elo d'arrivée.
- `engine.js` contient le moteur Elo (équipe, fiche de stats, duels si disponibles).
- `.github/workflows/update.yml` lance `update.js` chaque nuit et publie `site/` sur GitHub Pages.

## En local

```bash
node update.js
node serve.js
```

Puis ouvrir http://localhost:4174.
