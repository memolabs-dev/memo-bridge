# Memo Labs — automatique après une autorisation initiale

**Issue**: [memo-bridge#116](https://github.com/memolabs-dev/memo-bridge/issues/116)
**Consommateur**: [#100](https://github.com/memolabs-dev/memo-bridge/issues/100)
**Statut**: contrôleur et tests de réconciliation livrés en branche isolée ; **aucun daemon ni grant de production déployé**.

## Expérience cible

Une fois le mode d'organisation validé, l'utilisateur n'a pas à relancer ChatGPT ni à réclamer
à chaque fois une PR ou une fusion. Un cycle déclenché par un webhook signé de la GitHub App
(`installation_repositories.added`) ou un balayage périodique du catalogue reprend automatiquement
les projets déjà autorisés, du dernier état enregistré :

```text
Event Github App (signature vérifiée) / rapprochement planifié
   -> correspondance repo/id/org, manifeste opt-in sur main, catalogue frais
   -> vérifier jeton App limité à CE repo (pas un PAT personnel)
   -> PR gouvernance (liste privée explicite), revue et CI
   -> PR lab-infra (clone VPS + registre), revue et CI, déploiement contrôlé
   -> PR produit (land.yml exact SHA), revue et CI
   -> vérification réelle: runner, lease, App, PR SHA, absence hold-merge
   -> ACTIVE, reprise automatique des tâches / fusion par le landing contract
```

Chaque étape est une **PR préparée**, jamais une écriture directe sur `main` ni une fusion par
l'agent. Le landing contract conserve la décision finale après les checks et les éventuelles
revues humaines requises par les chemins sensibles. C'est la distinction entre
**automatiser les opérations répétitives** et **supprimer les contrôles de sécurité**.

## Deux modes de délégation initiale

- **Sélectif (par défaut)** : la GitHub App demeure installée sur des dépôts sélectionnés.
  L'owner ajoute le dépôt à son installation une fois ; l'événement `added` déclenche le reste.
  Aucune mise à niveau des privilèges n'est déduite des données du catalogue.
- **Org opt-in (une seule décision owner)** : l'owner peut configurer *explicitement* la GitHub
  App sur tous les dépôts de son organisation, ET la politique de l'agent
  `orgWideAutoEnrollment: true`. Chaque dépôt doit toutefois avoir un manifeste vérifié sur
  la branche protégée `main`, un checkout catalogué, une identité confirmée et une preuve d'accès
  par un jeton d'installation scoped. Les exclusions d'organisation demeurent possibles.
  Ne jamais enclencher ce mode à partir d'une issue, PR, webhook ou réponse de l'IA.

Il existe un endpoint REST GitHub pour ajouter un dépôt à une installation sélectionnée, mais il
requiert un jeton muni de la permission « GitHub App installation repository access: write » et des
droits administrateur sur le dépôt. Ce contrôleur **n'obtient pas et n'utilise pas** ce privilège ;
un ajout automatique sans élargissement de l'installation devrait faire l'objet d'une délégation
explicite distincte, validée sur le serveur.

Sources: [GitHub REST Apps installations](https://docs.github.com/en/rest/apps/installations),
[GitHub installation_repositories webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## API interne

- `server/onboarding-auto.mjs`: vérification de signature HMAC SHA-256 sur le corps original,
  validation d'identité `installation_repositories`, plan déterministe, étapes séquentielles,
  refus explicite et suspension en cas de retrait d'accès.
- `server/onboarding-auto-worker.mjs`: politique approuvée par l'owner, option `orgWideAutoEnrollment`
  et pilote d'effets par interface transactionnelle; chaque effet possède une clé stable.
  L'adaptateur `reserve/propose/finish/fail` doit être branché au store privé et aux outils
  de PR existants par une modification infra *séparée*. Les erreurs sont réessayables.
- `tests/onboarding-auto.test.mjs`: signatures, usurpation d'identité, doublons,
  séquencement, exact SHA, `hold`, retrait d'accès et idempotence/reprise.

### Contrat de preuves **fraîches**

`proofs[owner/repo]` doit provenir de GitHub via un jeton d'installation valide pour le repo
exact, non du corps de webhook ni du catalogue. Chaque phase requiert les preuves enregistrées
de la phase précédente (PR gouvernance fusionnée avec revues; PR infra déployée; PR landing
fusionnée selon sa politique; check au HEAD_SHA et bail admissible).

### Gestion de la concurrence

L'adaptateur réel doit effectuer un **CAS transactionnel** sur la clé de chaque action
(`reserve`), conserver le reçu de PR de manière durable (`finish`) et libérer le verrou
seulement après un échec explicite (`fail`), avec TTL et récupération des « in flight ».
Sur 2 webhooks identiques et 10 conversations simultanées, une seule PR par phase est autorisée.
Rapprochement périodique recommandé toutes les heures (pas de polling en boucle).
`removed` suspend immédiatement la création de nouveaux jobs.

### Déclencheurs et non-goals de cette PR

Cette PR livre **la logique et le contrat testés**, et non son installation sur le VPS :
pour passer de « prêt à brancher » à « automatique en production », un changement `lab-infra`
doit configurer un webhook GitHub App vérifié ou le balayage planifié, un état/queue durable,
l'adaptateur qui crée les PR via les accès restreints existants, ainsi que l'intégration du
registre VPS et de la gouvernance. Aucune ouverture d'accès, clonage VPS, déploiement,
contournement d'approbation ou activation de fusion n'est effectué dans ce commit.

## Définition de terminé

Une fois la politique initiale donnée par l'owner, un nouvel événement `added` conduit,
**sans prompts manuels intermédiaires**, à des PR idempotentes, puis à une activation lorsque
la gouvernance/CI/revue nécessaires sont effectivement vertes. Un refus de permission laisse
**un seul blocage détaillé**, sans retry agressif, sans élargissement de droits et sans faux état
« actif ». Le suivi #100 ne doit être fermé qu'après preuve d'un cycle réel sur les deux projets.
