# Memo Bridge — convergence et recette réelle (audit du 23 octobre 2026)

**Statut : constat et proposition, pas une autorisation de fusion ni de déploiement.**
Source : `main` au SHA `c3d17981`, consultation GitHub des PR, tests exécutés dans un clone séparé sur le Mac. L'agent n'a ni changé le checkout canonique, ni utilisé le compte d'un autre agent.

## 1. Concurrence du mode ChatGPT « simple »

La PR #260 (fusionnée) permet l'édition dans le checkout canonique sans workspace ni worktree. La fonction `createOperatorLocks.acquireImplicit` ne garde un verrou que jusqu'à `release()`, appelé à la fin de **chaque appel** dans `bridge/hub.mjs`. Cette garantie est insuffisante pour la transaction logique `git switch -c → éditer → tester → git commit → git push` : entre deux appels, un autre acteur peut changer le HEAD/index et le premier continue sur le mauvais état.

`tests/canonical-checkout-consistency.test.mjs` est une **reproduction de caractérisation**, quatre tests verts et non un correctif : (1) branche A puis B puis reprise A sur B; (2) la concurrence dans le même appel est correctement refusée; (3) des dépôts distincts restent indépendants; (4) sans identité de session, le hub peut dériver un même workspace du principal et autoriser deux appelants logiques sous la même identité. Ce dernier cas n'établit pas que le connecteur actuel omet réellement l'identité : cela doit être mesuré dans deux vraies conversations. Cette reproduction utilise des chemins et branches simulés; elle ne mutile pas un vrai dépôt.

**Correctif à concevoir dans #263 :** un seul propriétaire de l'état d'un checkout canonique pour toute la transaction, lié à une identité de session prouvée, renouvelable et persistée (fencing atomique; expiration/reprise vérifiées), avec garde au niveau du vrai git top-level canonicalisé et pas seulement du `cwd`. Ne pas considérer la simple existence d'un `workspace_id` implicite comme une preuve d'exclusivité entre les appels. Un deuxième acteur doit être refusé **avant** tout changement d'index, de branche ou de fichiers. Les sessions sans identité stable et les scripts qui changent de répertoire demandent une règle fail-closed. Garder le flow worktree+lease *sur demande* pour plusieurs agents écrivains. L'absence de mécanisme transactionnel ne doit pas être masquée par les tests verts.

Mitigation immédiate **non suffisante comme contrôle de sécurité** : dans un checkout partagé avec du travail non commité ou des fichiers non suivis, ne pas effectuer `git switch`, `git add`, `git commit`, `git reset` ni écriture automatisée avant coordination avec le propriétaire. Relire branche/HEAD/status avant chaque étape et arrêter si la branche change. Préférer un clone jetable isolé pour une recette autorisée lorsque le propriétaire refuse les worktrees, sans modifier le checkout de l'autre agent.

## 2. PR concurrentes — décision de convergence proposée

| PR | État constaté | Décision de revue proposée | Préconditions |
|---|---|---|---|
| [#244](https://github.com/memolabs-dev/memo-bridge/pull/244) | Mergeable, UNSTABLE; tests Node 22 et 24 en échec | Supplanter par #249 une fois ses apports uniques identifiés | Diff exhaustif et preuve que les adaptations sont reprises; **ne pas fusionner** #244 rouge |
| [#248](https://github.com/memolabs-dev/memo-bridge/pull/248) | CONFLICTING, touches inventory + CLI + tests | Réviser/rebaser sur le `main` actuel, plutôt qu'écraser les fonctions de portfolio déjà fusionnées (#239/#242/#246) | Réconciliation sémantique par fichiers et tests CLI/partial-failure/pagination |
| [#249](https://github.com/memolabs-dev/memo-bridge/pull/249) | CONFLICTING, Node 22/24 rouges sur la tête de PR | Candidate unique pour raccorder l'endpoint portfolio aux MCP/registry, après rebase et correction de tests | Contrat de la surface `simple` vs `full`, limites de résultats, indépendance des permissions, tests distants |
| [#258](https://github.com/memolabs-dev/memo-bridge/pull/258) | DRAFT, CONFLICTING, tests CI verts sur son SHA | **À garder en brouillon** jusqu'à revue de sécurité indépendante | Accès aux deux namespaces, matrice `owner_sub`, secrets au HOME, sandbox, journalisation et PR compagnon `memolabs-dev/.github#66` |

Les quatre PR ne doivent pas être fusionnées en masse. Leurs conflits ne sont pas des preuves de mauvaise implémentation; l'échec ou le succès d'une ancienne CI ne garantit pas la validité sur `main` courant. Revoir, puis une intégration à la fois, avec nouvelle CI et recette opérationnelle. L'issue #236 reste ouverte même après un merge partiel.

## 3. Recette E2E en chaîne réelle

Séquence à prouver : connexion ChatGPT distante → Memo Bridge sur le VPS → `operator_*` sur le Mac → dépôt isolé → tests réels → commit → push → PR brouillon → CI GitHub → décision de non-fusion. Distinguer strictement `CI_GREEN`, `MERGED`, `DEPLOYED` et `ACCEPTED_BY_USER`. Les lectures Mac→VPS et la CI principale de `main` sont déjà observées dans l'audit; leur succès ne signifie pas que la même révision a été déployée entièrement.

Journal local de la présente recette :
- Source `main` `c3d17981` et **copie indépendante** sous `workspace/scratch` créée sur le Mac depuis le dépôt GitHub.
- Branche dédiée `fix/263-checkout-concurrency`; aucun changement du HEAD/index de la copie canonique.
- Trois tests Node sans dépendances externes : résultat `3 pass / 0 fail` via `node --test tests/canonical-checkout-consistency.test.mjs`.
- Le commit, le push, la PR et la CI seront consignés dans l'issue #263 quand ils seront effectivement observés. Tant que cette étape manque, ne pas cocher « PR créée » ou « recette terminée ».
- Aucun déploiement, aucune migration d'autorisation, aucun envoi ni merge automatique.

## 4. Ordre de livraison

1. **P0 sécurité** : #263, reproductions puis correctif derrière une PR distincte (sécurité et multi-sessions).
2. **P0 recette** : #208, cycle Mac réel et tests négatifs; sans contournement des locks.
3. **P1 portfolio** : #248 inventaire robuste en CLI, #249 endpoint complet après rebase, trier #244 sur preuves.
4. **P1 accès élargi** : #258 (et PR du ledger) après revue threat-model, test E2E sur les deux namespaces et rollback approuvé.
5. **P1 produit** : [#255](https://github.com/memolabs-dev/memo-bridge/issues/255) / [#256](https://github.com/memolabs-dev/memo-bridge/issues/256) pour l'intégration temps réel Orbit seulement après ces garanties.

Aucun risque prod supplémentaire ne doit être accepté sur la seule foi des suites CI.
