# Prompts dorés : résultats

Protocole : `PROTOCOL.md`. Calcul : `node scripts/golden-prompts.mjs --score <fichier>`.

## Cibles

| Mesure | Cible |
|---|---|
| Négatifs réussis | 9/9 (aucun appel interdit) |
| Précision | 95 % ou plus |
| Rappel (directs et indirects) | 90 % ou plus |
| Chaînes complètes jusqu'à la PR, sans `workspace_open` (C01 à C04, I04, I05) | 4/6 ou plus |
| Questions posées au propriétaire, sur l'ensemble | 3 au plus |

## Passages

Aucun passage enregistré : le premier aura lieu après le prochain déploiement.

| Date | Commit déployé | Précision | Rappel | Directs | Indirects | Chaînes | Négatifs | Questions |
|---|---|---|---|---|---|---|---|---|

## Échecs et révisions

Une ligne par échec (id du prompt, outil appelé, outil attendu) et par description révisée (outil,
changement, date, effet au passage suivant).
