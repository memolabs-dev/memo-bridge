# Documentation de projet destinée aux agents

Un projet doit fournir un **index bref** (AGENTS.md) et trois références consultées à la demande. Ne pas injecter tout le dépôt dans le prompt. Les fichiers de ce répertoire sont des modèles : remplacer tous les `TODO` après vérification effective du dépôt, jamais par déduction.

## Convention

- `AGENTS.md` : finalité, périmètre, commandes de découverte, navigation dans la documentation, interdits.
- `docs/architecture.md` : entrypoints, frontières, flux de données, dépendances et ADR.
- `docs/operations.md` : commandes de lancement, variables, environnements, secrets, publication et reprise.
- `docs/testing.md` : tests rapides, complets, CI et critères de livraison.

## Rollout

Priorité 1 : Memo Bridge ; priorité 2 : Cuesheet, UNI, Drop, World Kernel ; priorité 3 : CDKF. Le catalogue consulté le 20/10/2026 contient 74 projets, **mais seulement une partie est accessible** : CDKF apparaît `metadata_only`, donc il ne faut ni supposer l'accès à son code ni lui appliquer ces modèles à l'aveugle. Chaque adoption réclame la vérification des commandes et du point d'entrée du vrai dépôt.

## Critères de revue

1. Un agent peut choisir un parcours en moins d'une page de contexte initial.
2. Aucune commande inventée ; les commandes inconnues sont notées `TODO: verify`.
3. Les opérations dangereuses, les secrets et la validation de production sont clairement bornés.
4. Les parcours Claude Code, Codex, ChatGPT et OpenCode se fondent sur les mêmes invariants indépendants du fournisseur.
5. L'index n'est pas une duplication exhaustive des docs.
