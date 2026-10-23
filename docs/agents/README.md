# Memo Bridge — guide opérationnel pour agents

> **Depuis le 2026-10-23 (décision de Guillaume)** : on travaille dans le dépôt canonique du projet, sur une branche. `projects_list` donne `path_relative`, le dépôt est `~/memolabs/<path_relative>`. GitHub se lit avec `gh`. Workspace, claim et worktree seulement si Guillaume nomme une Issue ou le demande, ou si une autre conversation écrit dans le même dépôt. Point d'entrée court : [`llms.txt`](../../llms.txt) et [`skills/memo-bridge/SKILL.md`](../../skills/memo-bridge/SKILL.md). Le reste de cette page décrit la chaîne des tâches, à utiliser sur demande.

> État documenté : 2026-10-20. Cette page décrit les contrats MCP observés, et non des fonctionnalités futures. Les descriptions des outils exposés par le serveur restent la source de vérité si elles changent.

## Modèle mental

- **Projet** : dépôt enregistré ; `projects_list` donne son identifiant exact et sa disponibilité.
- **Tâche** : GitHub Issue canonique, avec labels `agent:ready` et une priorité `priority:p0|p1|p2`.
- **Workspace** : contexte de conversation et d'exécution, **pas** nécessairement un dossier Git. `task_claim` et `task_next` l'ouvrent implicitement.
- **Worktree** : checkout Git isolé, utilisé seulement par la chaîne des tâches, sur demande ; retiré dès la branche poussée. Son association à un agent n'est pas une identité durable de projet.
- **Lease** : réservation d'une Issue, portée par `claim_id` et `fence`, susceptible d'expirer. Un autre agent ne doit pas écrire dans une tâche déjà réservée.
- **Operator lock** : verrou obligatoire pour les opérations hôte hors projet. Il ne remplace pas un lease sur une Issue.

## Routage par intention

| Besoin | Premier outil | Suite |
|---|---|---|
| Voir projets disponibles | `projects_list` | `project_context` |
| Comprendre les travaux existants | `project_context` | `tasks_list` / `github_pull_requests` |
| Corriger une Issue nommée | `task_claim(issue)` | `worktree_create(issue)` |
| Prendre la prochaine tâche | `task_next(project)` | `worktree_create(issue)` |
| Créer une tâche encore inexistante | `batch_create(project,tasks)` | `task_claim(issue)` |
| Analyser sans modifier | `project_context`, `github_issues` | Aucun worktree si les données suffisent |
| Lire ou modifier code d'une tâche revendiquée | `worktree_list_files`, `worktree_read_file`, `worktree_write_file` | `worktree_diff` |
| Lire un fichier système Mac/VPS hors projet | `operator_read` | Aucun worktree |
| Modifier un fichier système hors projet | `operator_lock` puis `operator_edit` | `operator_unlock` |
| Exécuter une commande hôte | `operator_lock` puis `operator_run` | `operator_unlock` |
| Reprendre une tâche après interruption | `workspace_recover` | Vérifier lease, état et checkpoint |
| Voir les conversations concurrentes | `sessions_overview` | Respecter les verrous et tâches des autres |

## Chemin de livraison par la chaîne des tâches (sur demande)

1. `projects_list` et `project_context` : vérifier nom du projet, tâches et PR existantes.
2. `batch_create` seulement si aucune Issue appropriée n'existe ; autrement `task_claim` ou `task_next`.
3. `worktree_create(issue)` avec l'Issue réellement détenue. La branche par défaut est interdite en écriture.
4. Lire, changer, contrôler les fichiers du worktree. Exécuter tests et validations avec les outils autorisés ; ne pas inventer de commande de test.
5. `worktree_diff`, puis `worktree_commit`, `worktree_push`.
6. `github_create_pr` (l'ouverture d'une PR **n'est pas** un merge, déploiement ou validation CI).
7. `task_complete` après ouverture de PR réussie ; enregistrer un `task_checkpoint` en cas d'interruption. Sur arrêt non terminé, `task_release` avec le vrai motif.

## Erreurs : traitement sûr

- `path_not_allowed` : chemin ou périmètre non autorisé. Vérifier projet enregistré, hôte, worktree relatif et outil adapté. Ne pas contourner via un autre chemin ou un outil d'exécution générique.
- `stale_lease` : arrêter les écritures, récupérer l'état avec `workspace_recover` et vérifier `task_status`; renouveler uniquement un lease encore valide via `task_renew` et utiliser son nouveau `fence`.
- `locked_by_other_session` / `workspace_other_session` / `session_required` : arrêter, regarder `sessions_overview` et reprendre seulement avec une autorisation ou un scope valide.
- `project_not_allowed` : disponibilité du catalogue ≠ capacité d'écrire sur l'hôte. Vérifier `host_capabilities` et permissions ; ne pas prétendre que le projet est accessible.
- Refus d'approbation : ne pas retenter en contournant le contrôle.
- Vérifications CI inconnues : dire « non vérifiées », ne jamais assimiler PR ouverte à déployée.

## Limites connues et évolutions prévues

Aujourd'hui, le flux `task_claim → worktree_create` reste contraint par les outils. La gestion future (Issue #226) doit introduire des workspaces persistants, temporaires et partagés, avec allocation différée, inventaire et nettoyage en mode simulation. **Aucune suppression automatique n'est disponible ou autorisée par cette documentation.**

Pour une tâche de documentation, privilégier les petits fichiers découvrables et les liens plutôt qu'un unique contexte énorme. Voir `skills/memo-bridge/SKILL.md`.
