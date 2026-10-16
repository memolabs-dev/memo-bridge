# Mergify pour tous les projets Memo Labs

**État au 16 octobre 2026 :** infrastructure d'adoption générique préparée ; **aucune activation automatique hors de `memo-bridge`**. La référence de fonctionnement réel est [PR #141](https://github.com/memolabs-dev/memo-bridge/pull/141) (fusion par `mergify[bot]`), répétée par [PR #142](https://github.com/memolabs-dev/memo-bridge/pull/142). L'ancien workflow `Land` du dépôt `memo-bridge` est désactivé.

## Pour n'importe quel dépôt

L'outil `scripts/mergify-fleet.mjs` est **sans effet sur GitHub** : il lit un instantané, produit un verdict fail-closed, ou génère un fichier `.mergify.yml` **candidat** spécifique aux contrôles du dépôt. Il n'installe pas Mergify, n'ajoute pas de permissions, ne modifie aucun workflow et ne fusionne pas de PR.

```bash
# Voir les blocages identifiés pour les projets déjà audités
node scripts/mergify-fleet.mjs audit docs/mergify-fleet-snapshot.json

# Générer une configuration candidate adaptée aux checks Drop (date dans le futur)
node scripts/mergify-fleet.mjs candidate docs/mergify-fleet-snapshot.json memolabs-dev/drop 2099-01-01T00:00:00Z
```

**Le dernier argument doit être recalculé juste avant la bascule** (UTC futur), et tous les tickets/PR ouverts doivent être vérifiés : un cutoff ancien risquerait de récupérer des PR non prévues. La date lointaine dans l'exemple est volontairement **non opérationnelle** ; elle empêche des fusions imprévues tant qu'elle n'est pas remplacée au moment de la transition.

Le profil est enrichissable : un nouveau projet rejoint `docs/mergify-fleet-snapshot.json` après une vérification **en lecture seule** de son URL GitHub, sa branche par défaut, ses CI (noms exacts et application qui émet les checks), ses politiques de branche, ses éventuels moteurs de fusion et son installation Mergify. Ne jamais inférer les contrôles requis depuis un langage de programmation.

Le générateur applique par défaut : auteur bot limité, même dépôt, PR non draft, date minimale, absence de hold, contrôles GitHub Actions explicitement nommés, tailles limitées, exclusion étendue de chemins sensibles (configurations, secrets, source, build, sécurité, tests, déploiement), une seule PR en file et fusion squash. Les répertoires propres au projet doivent être ajoutés à l'exclusion, sans retirer les règles de base. L'outillage peut produire un YAML sans qu'un dépôt soit prêt : **génération n'est jamais autorisation de déployer**.

## Conditions de passage en production (une seule fois par dépôt)

1. Vérifier que le dépôt est accessible, non archivé, et qu'il a une CI suffisante (tests pertinents, pas seulement un build de façade), avec les statuts GitHub reconnus sur de vrais SHA de PR. Pour des domaines sensibles (clinique, sécurité, infra, production, signature Apple), les validations métier/sécurité s'ajoutent.
2. Vérifier l'installation de l'application Mergify **pour ce dépôt précisément** et les contrôles GitHub. L'application peut nécessiter une autorisation d'administration ponctuelle, pas des interventions sur chaque PR.
3. Inventorier les contrôleurs existants : workflow GitHub `Land`, `auto-merge.yml`, bot maison, merge queue native, configuration distante. **Un seul exécuteur** doit pouvoir fusionner une même cohorte. Ne jamais les laisser en parallèle.
4. Installer le fichier candidat par PR, passer les tests GitHub et les contrôles de configuration Mergify, mais **garder la PR en draft** tant que la bascule n'est pas prête. Éviter de fermer une issue parent inachevée par une PR partielle.
5. Effectuer un cutover autorisé et réversible : désactiver l'ancien moteur, vérifier qu'il n'a plus de runs actifs, vérifier toutes les PR déjà ouvertes et renouveler la date de création **après cet audit**, sortir le fichier de draft et le fusionner en respectant les protections.
6. Lancer un **canari positif** qui n'altère qu'un document : PR non draft par le bot, sans label/revue manuelle, CI verte et fusion par `mergify[bot]`. Vérifier `merged_by`, le SHA et l'absence de Land.
7. Valider des **canaris négatifs** : draft, auteur non fiable, changement protégé, check manquant/en échec, base différente, fork, changements trop gros, hold et SHA périmé. Aucune fusion ne doit passer.
8. Consigner la preuve dans le Vault, l'issue du dépôt et `AGENTS.md`. Les prochaines PR ordinaires bénéficient alors de l'automatisation sans validation humaine systématique. Les changements sensibles passent toujours dans une voie distincte.

Si l'un des points manque : **BLOCKED**, aucune activation. Une seule approbation de bascule peut être nécessaire ; cela ne réintroduit pas des clics pour chaque PR de tous les jours.

## Audit initial de 11 dépôts

Source : consultation en lecture seule de GitHub (API de l'utilisateur connecté), le 16 octobre 2026. Ce tableau reflète **une photographie**, pas un état garanti en temps réel. Le catalogue Memo Bridge contient **72 projets**, dont plusieurs clones ou projets sans dépôt vérifié dans cette organisation ; il ne faut pas confondre 72 entrées et 72 dépôts déjà prêts.

| Dépôt | CI observée sur une PR | Contrôleur historique observé | Décision actuelle |
|---|---|---|---|
| `memo-bridge` | `test (22)`, `test (24)` | `Land` désactivé | **ACTIF, canaris #141/#142 fusionnés par Mergify** |
| `drop` | `test`, `test-macos`, `test-windows`, CodeQL | à auditer, règles signature/tag | **BLOCKED** : moteur et signature Apple à vérifier |
| `cuesheet` | `Core and integration tests` | `auto-merge.yml` actif | **BLOCKED** : double fusion interdite |
| `uni-protocol` | `UNI required checks`, `lint`, matrices OS | `auto-merge.yml` actif | **BLOCKED** : contrôles multiples + vieux moteur |
| `emargo` | `Lint · Types · Tests` | `auto-merge.yml` actif | **BLOCKED** : isoler ancien moteur |
| `clinical-data-knowledge-foundation` | `build` | non déterminé | **BLOCKED** : une compilation ne valide pas les référentiels cliniques |
| `lab-hub` | aucune preuve de CI sur PR consultée | non déterminé | **BLOCKED** : CI à établir |
| `rebuild-radar` | `validate` | non déterminé | **BLOCKED** : application Mergify, permissions et contrôleur non établis |
| `mobile-explorer` | `swift-build` | non déterminé | **BLOCKED** : idem ; validation Swift à détailler |
| `kollio-mac` | inconnue | aucun dépôt sous `memolabs-dev/kollio-mac` trouvé | **BLOCKED** : confirmer propriétaire et URL |
| `lab-infra` | inconnue | aucun dépôt sous `memolabs-dev/lab-infra` trouvé | **BLOCKED** : confirmer propriétaire et URL |

**Priorité suggérée :** vérifier un petit dépôt doté de CI claire et sans ancien moteur, puis `emargo`, `cuesheet`, `uni-protocol` (migration contrôlée). Garder **Drop en dernier** à cause de ses politiques de release/signature, et **CDKF/infra** sous validation renforcée.

## Points volontairement non réalisés ici

- Aucun autre dépôt n'a reçu `.mergify.yml`, ni de modification de son workflow.
- Aucun accès Mergify à des dépôts supplémentaires n'a été accordé.
- Aucun contrôleur existant hors `memo-bridge` n'a été désactivé.
- Aucune des PR ouvertes des autres projets n'a été fusionnée.
- Les fichiers sources, scripts, permissions et autres fichiers sensibles ne passent **pas** automatiquement dans la file low-risk de référence. Leur extension nécessite un contrat propre au projet.

Références : [Mergify Auto-Merge](https://docs.mergify.com/merge-protections/auto-merge/) ; [conditions](https://docs.mergify.com/configuration/conditions/) ; [contrat d'origine](https://github.com/memolabs-dev/.github/blob/main/docs/landing-contract.md) ; [issue Memo Bridge #139](https://github.com/memolabs-dev/memo-bridge/issues/139).
