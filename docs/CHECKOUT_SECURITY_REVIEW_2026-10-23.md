# Memo Bridge — revue de sécurité des checkouts concurrents

Date : 23 octobre 2026
Périmètre : PR [#265](https://github.com/memolabs-dev/memo-bridge/pull/265) et PR empilée [#268](https://github.com/memolabs-dev/memo-bridge/pull/268), vérification indépendante dans une copie Git isolée sur Mac.
Verdict : **NO-GO pour activation production**. Cette PR corrige un bug du lanceur supervisé ; elle ne transforme pas des verrous coopératifs en isolation système.

## Défaut reproduit : libération prématurée du checkout

Avant correctif, `scripts/with-checkout-lease.mjs` libérait la réservation sur l'événement `exit` du processus principal. Or le processus pouvait avoir engendré un descendant dans le **même groupe de processus** encore capable d'écrire dans le dépôt.

Scénario reproductible sur dépôt Git temporaire, sans toucher à un projet Memo Labs :
1. Le lanceur A réserve le dépôt et exécute un programme qui engendre un descendant puis se termine.
2. Le descendant attend 850 ms avant d'écrire `GRANDCHILD_DONE`.
3. Pendant cette attente, le lanceur B essaye d'écrire `UNAUTHORIZED_CONTENDER` dans le même dépôt.
4. **Avant correctif** : B sort avec code 0 au lieu du refus attendu 73. Test : 6/7 réussis, 1 échec attendu, `actual: 0, expected: 73`.
5. **Après correctif** : le lanceur A conserve et renouvelle sa réservation jusqu'à disparition des processus de son groupe ; B est refusé, n'écrit aucun fichier, A ne libère qu'après le descendant. Tests ciblés : 8/8 réussis (dont arrêt du groupe sur SIGTERM).

Le correctif utilise l'identifiant du groupe macOS issu de `spawn({detached:true})`, une vérification de présence du groupe et une attente jusqu'à l'arrêt du groupe de processus (sans timeout qui libérerait abusivement la réservation). L'utilisateur peut signaler le groupe entier même si le processus principal est déjà terminé ; un second test provoque SIGTERM à ce moment précis et vérifie que le descendant n'écrit pas et que la réservation est libérée après son arrêt.

**Limite non corrigée :** un descendant qui s'extrait volontairement dans un **nouveau groupe** ou un shell lancé hors du superviseur échappe à cette garantie. Un crash du superviseur peut aussi interrompre le renouvellement d'un processus encore actif ; l'expiration du lease doit alors être traitée par une récupération supervisée et/ou par une isolation système. Cette PR ne doit PAS être considérée comme une protection robuste contre un agent hostile ou non coopératif.

## Matrice de preuves

| Scénario | Résultat | Type de preuve |
|---|---|---|
| Refus d'un deuxième writer local dans le même checkout | PASS | Processus Node distincts, dépôt Git temporaire |
| Refus d'un appel opérateur signé lorsque le lanceur local est propriétaire | PASS | Signature Ed25519 et simulation du contexte transport |
| Sous-dossiers, symlinks, dépôts indépendants, Git douteux | PASS | Tests d'intégration |
| Persistance interprocessus du state partagé | PASS | Tests de #265 (deux processus Node) |
| Descendant encore actif dans le même process group | PASS avec correctif | Régression avant/après documentée |
| Descendant détaché dans un groupe différent | **NON PROTÉGÉ** | Limite connue du modèle coopératif |
| Deux vraies conversations ChatGPT OAuth indépendantes | **NON VÉRIFIÉ** | Une conversation ne peut pas créer la seconde |
| Identité `client_session` cryptographiquement liée à la signature opérateur | **NON IMPLÉMENTÉ** | La signature existante porte sur l'op et les arguments, pas sur cette métadonnée |
| Claude Code et OpenCode lancés hors du superviseur | **NON PROTÉGÉS** | Accès même UID au système de fichiers |
| Deux autorités d'état sur machines distinctes | **NON PROTÉGÉ** | Pas de broker global |
| Reprise owner-only auditée après crash | **NON IMPLÉMENTÉ** | Pas de commande de révocation authentifiée |
| Recette externe du Mac et du VPS avec rollback | **NON VÉRIFIÉ** | Ne pas activer les flags sans cette preuve |

## Conditions de sortie du NO-GO

1. Une autorité Mac avec identité de session authentifiée et **liée au contrat de signature** pour les écritures distantes.
2. Isolation OS des racines d'écriture ou worktrees distincts imposés aux agents non supervisés et à leurs sous-processus ; preuve de refus avant mutation.
3. Mécanisme sûr de crash/TTL : un agent toujours vivant ne doit pas perdre sa réservation au profit d'un autre.
4. `status/heartbeat/release/owner-recovery` contrôlés, journalisés et testés après redémarrage.
5. Recette d'au moins deux sessions distantes indépendantes (hashes différents), ainsi que Claude Code et OpenCode locaux, sur clones jetables et profils propres.
6. Vérification de l'absence de modification de branche, index et fichiers pour tout writer refusé ; CI Node 22/24 et observations hôte séparées.

Les flags `MEMO_BRIDGE_CHECKOUT_LEASES` et `MEMO_OPERATOR_CHECKOUT_AUTHORITY` doivent rester **désactivés** tant que ces points ne sont pas prouvés. Aucun droit, secret, service ou déploiement de production n'a été modifié pendant cette revue.

Source de l'issue : [#263](https://github.com/memolabs-dev/memo-bridge/issues/263).
