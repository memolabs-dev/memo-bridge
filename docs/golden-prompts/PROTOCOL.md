# Prompts dorés : protocole de passage dans ChatGPT

But (owner console REQ-Z3, AC-Z3) : vérifier qu'en parlant normalement à ChatGPT, sans jamais
dire « Memo Bridge », « workspace », « claim » ni « worktree », le bon outil est appelé, et que les
demandes de bout en bout vont jusqu'à la PR seules. Méthode reprise du guide OpenAI « Optimize
metadata » (https://developers.openai.com/apps-sdk/guides/optimize-metadata) : prompts directs,
indirects et négatifs, puis précision et rappel.

Le jeu est dans `prompts.json` (38 prompts : 13 directs, 12 indirects, 4 chaînes, 9 négatifs).
`node scripts/golden-prompts.mjs --check` vérifie que chaque outil attendu est bien servi à
ChatGPT ; la CI le fait aussi (`tests/tool-metadata.test.mjs`).

## Avant le passage

1. Le déploiement qui porte ces changements est fait, avec ton accord (le VPS tournait sur 93e3bed,
   41 commits derrière main le 2026-10-18 : ce déploiement embarque aussi ces commits).
2. Dans ChatGPT : Paramètres, Applications et connecteurs, Memo Bridge, « Actualiser », pour que
   ChatGPT recharge les nouvelles descriptions. Sans cela il garde les anciennes.
3. Préparer les canaris des chaînes (C01 à C03) : trois Issues dans `memolabs-dev/memo-bridge`,
   titre « golden: ajoute une ligne datée à docs/GOLDEN_CANARY.md », labels `agent:ready` et
   `priority:p2` (la troisième en `priority:p0`). Les PR qui en sortent ne changent qu'une ligne de
   doc ; Mergify peut les fusionner.
4. D06 : choisir une unité systemd déclarée et sans risque (`operator_policy` les liste), jamais
   memo-bridge, traefik ni pocket-id, puisque la conversation passe par eux. D09 : créer
   `~/Desktop/golden.txt`.
5. Copier `results.template.json` en `results-AAAA-MM-JJ.json`.

## Pendant le passage

- Une conversation neuve par prompt (sauf I06 et I07, posés au milieu de la conversation de C01).
- Coller le prompt tel quel. Ne rien ajouter qui nomme un outil ou une étape.
- Si ChatGPT pose une question, répondre en une phrase, puis noter `"questions": 1`.
- Si ChatGPT demande une confirmation avant d'écrire, accepter et noter `"confirmations": 1`.
- Noter dans `calls`, dans l'ordre, chaque outil que ChatGPT affiche avoir appelé
  (« Appel de l'outil … » dans la conversation). Quand l'argument compte, l'écrire après deux
  points : `"operator_run:gh pr merge 31"`.
- Les négatifs (N01 à N09) : noter `"calls": []` si aucun outil Memo Bridge n'a été appelé.

## Après le passage

```bash
node scripts/golden-prompts.mjs --score docs/golden-prompts/results-AAAA-MM-JJ.json
```

Le script donne la précision (le premier outil appelé était-il un bon outil ?), le rappel (un bon
outil a-t-il été appelé quand il fallait ?), le score de chaque catégorie, les chaînes complètes
et la liste des échecs. Recopier ces chiffres dans `RESULTS.md`, avec la date, le commit déployé et
une ligne par échec.

## Lire un échec

- Mauvais outil sur un négatif : priorité absolue (le guide OpenAI demande la précision des
  négatifs avant tout gain de rappel). Resserrer la description de l'outil appelé à tort.
- Aucun outil sur un direct ou un indirect : élargir le « Use this when » de l'outil attendu avec
  la formulation du prompt.
- Chaîne interrompue : regarder la dernière réponse de Memo Bridge. Un refus avec `next_step` est
  un défaut du serveur ou de la description ; un arrêt sans refus est un défaut des instructions.
- Une seule description modifiée à la fois, puis repasser les prompts concernés, pour savoir ce
  qui a marché. Noter chaque révision dans `RESULTS.md`.
