# Onboarding automatique : politique d'autorisation, sans clics répétés

Issue: [memo-bridge#124](https://github.com/memolabs-dev/memo-bridge/issues/124)
Consommateur: [#100](https://github.com/memolabs-dev/memo-bridge/issues/100)
État: contrôle de politique + tests, non déployé.

## Ce que veut dire automatique

Une fois une délégation durable configurée dans l'infrastructure de l'organisation, les nouveaux dépôts peuvent être intégrés sans intervention répétitive. L'automate observe les événements de la GitHub App et son catalogue local, vérifie l'identité réelle de chaque dépôt, son manifeste d'inscription sur la branche protégée, les permissions effectives du jeton d'installation limité au dépôt, puis propose et suit des PR de gouvernance, de runner et de landing.

**Il ne peut pas se donner lui-même accès à un dépôt.** GitHub exige une autorisation d'administration spécifique pour modifier les dépôts sélectionnés dans une installation. L'utilisateur a clairement demandé l'automatisation du workflow, et non la suppression des contrôles de GitHub. Si l'App n'a pas accès au dépôt, l'automate conserve un unique état bloqué et ne cherche pas d'identifiants de remplacement.

## Politique durable *hors du dépôt Git*

`server/onboarding-policy.mjs` charge exclusivement un fichier privé administré par le service, jamais un JSON reçu dans un webhook, une issue ou un dépôt utilisateur. Le fichier doit être régulier, non-symlink, situé dans un répertoire de confiance et protégé en mode `0600`. Taille maximale: 16 Kio. Le numéro d'installation est épinglé, ainsi que l'organisation `memolabs-dev`.

### Mode sélectionné (moindre privilège)

Exemple de politique **non secrète**, à provisionner par une PR d'infrastructure approuvée :

```json
{
  "schema": "memo-bridge.owner-enrollment.v1",
  "org": "memolabs-dev",
  "installationId": 170927025,
  "enabled": true,
  "mode": "selected",
  "approvedFor": "memolabs-dev",
  "enrolledRepositories": [
    "memolabs-dev/rebuild-radar",
    "memolabs-dev/mobile-explorer"
  ],
  "excludedRepositories": []
}
```

Ce mode n'ajoute **pas** les deux dépôts à l'App et ne contourne pas les permissions. Il autorise seulement le coordinateur à les traiter *après* preuve indépendante que GitHub les a réellement accordés.

### Mode organisation (zéro ajout manuel après la délégation initiale)

Une variante explicite modifie `mode` à `organization`, ajoute `orgWideAutoEnrollment: true` et peut laisser `enrolledRepositories` vide. **Elle n'étend jamais les droits de la GitHub App à elle seule.** Pour qu'elle fonctionne sur chaque nouveau dépôt, l'installation GitHub doit déjà disposer de ce périmètre via une décision d'administration séparée. Chaque dépôt doit aussi être dans le catalogue, avoir un manifeste opt-in valide sur la branche protégée, et être reconnu par un jeton App au périmètre exact; `excludedRepositories` permet des exclusions explicites.

Le passage à ce mode doit être relu comme un élargissement de confiance, pas activé implicitement par une demande dans une issue.

## Contrat d'exécution

- `loadTrustedEnrollmentPolicy` valide le fichier local avant de produire un objet figé et son empreinte `policy_revision`.
- `reconcileWithHostPolicy` transmet uniquement cet objet au moteur d'onboarding déjà fusionné (#121).
- Une permission manquante produit `blocked`, jamais `active` ; les retraits d'installation suspendent l'exécution.
- Les actions de proposition de PR restent contrôlées par l'adaptateur durable de la PR #126, toujours en brouillon à ce jour.
- La CI et la revue humaine requises par la politique du dépôt restent à respecter avant le landing.

## Limites constatées le 16 octobre 2026

GitHub renvoie `repository_selection=selected` pour `memo-labs-automation`. Le compte Mac authentifié dispose d'ADMIN sur les deux dépôts privés, mais la tentative de modifier directement la sélection de l'installation via les outils disponibles a été **refusée avant exécution par un contrôle de sécurité**. Aucun droit n'a été accordé. La politique de ce PR ne contourne pas ce refus et aucune installation de production n'est faite ici.

## Preuves manquantes pour clore #124 puis #100

1. Délégation d'administration GitHub pour les dépôts exacts ou périmètre organisationnel explicitement approuvé, vérifiée par un jeton de l'App.
2. Politique propriétaire chargée depuis le répertoire privé du service VPS (jamais depuis le dépôt).
3. Flux webhook ou balayage périodique authentifié sur le VPS, et stockage SQLite privé avec receipts idempotents.
4. PRs de gouvernance et lab-infra revues, checkouts VPS, registres et permissions GitHub App vérifiées indépendamment.
5. Deux cycles réels: `rebuild-radar` et `mobile-explorer` deviennent `available=true` ; CI exacte + landing pour les PR initiales.

Ne jamais conclure « automatique en production » sur la seule réussite des tests unitaires.
