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

Le passage intégral des 41 prompts n'a pas encore eu lieu ; la table ci-dessus l'attend.

### Passage partiel du 18 octobre 2026

Déploiement du moment : VPS au commit `46ea7b9`, `main` du dépôt à `0facbf0`, qui embarque les
correctifs #186, #187 et #184. Quatre prompts sur 41, choisis pour valider les cinq contrôles de
fiabilité demandés au propriétaire plutôt que la qualité des descriptions d'outils : les colonnes
de précision et de rappel restent donc vides.

| Prompt | Contrôle visé | Constat | Trace machine |
|---|---|---|---|
| C03 | chaîne jusqu'à la PR, sans intervention | tâche prise, arbre isolé, tests 786 réussis et 0 échec, PR #193 fusionnée par Mergify, issue #192 fermée | revendication et travail `released` avec issue le 18/10 à 20:19 |
| D13 | commande lecture seule en branche par défaut | premier appel sort en `128`, Git signale l'absence de dépôt ; second en `0` | `read_only: true` et `approval_id: null` sur les deux appels |
| D15 | écriture autorisée sur le Mac | ligne ajoutée, ancien contenu conservé dans une sauvegarde | `operator_edit`, `mode: append`, `diff: true`, `approval_id: null` |
| D16 | écriture autorisée sur le VPS | fichier créé dans `/tmp`, contenu vérifié | `operator_edit`, `mode: write`, `create: true`, `approval_id: null`, verrou pris puis libéré |

Les lectures et explorations qui ont précédé chacun de ces quatre prompts complètent les cinq
contrôles : inspecter les deux hôtes, lire et modifier un fichier autorisé sur chacun, faire tourner
les tests d'un projet enregistré, atteindre la PR sans intervention, et reprendre après une erreur.

| Date | Commit déployé | Précision | Rappel | Directs | Indirects | Chaînes | Négatifs | Questions |
|---|---|---|---|---|---|---|---|---|

## Échecs et révisions

Une ligne par échec (id du prompt, outil appelé, outil attendu) et par description révisée (outil,
changement, date, effet au passage suivant).

| Date | Prompt | Constat | Attendu | Décision | Suivi |
|---|---|---|---|---|---|
| 18/10 | C03 | `task_next` a choisi #69, tâche déjà livrée, plutôt que le canari #192 posé le jour même | la tâche libre la plus prioritaire dont le travail n'est pas déjà fusionné | `agent:ready` retiré à #69, `agent:working` ajouté à #82, canari #194 posé | #196 |
| 18/10 | C03 | le pivot vers #192 a laissé le bail de #69 en `claimed` jusqu'à expiration | un seul bail vivant par workspace, rendu au changement de cible | `task_claim` doit rendre le bail qu'il abandonne | #195 |

Aucune description d'outil n'a été révisée : aucun prompt négatif n'a été passé à ce jour.
