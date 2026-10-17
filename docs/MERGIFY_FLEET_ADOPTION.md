# Mergify across the fleet: one template, one canary pair per repository

Autoloop T-M3 (`.agent/project/autoloop/spec.md`, REQ-M01, M06, M07, M08), Issue #149.
memo-bridge adopted the policy first (#154, canaries #155 and #156). This page is how every
other repository adopts it, and the state of each one.

## The policy

A pull request lands without a human when, on its exact head: it targets the default branch, is
not a draft, does not come from a fork, its author is `memo-labs-automation[bot]` or
`guillaume-flambard`, it carries neither `hold-merge` nor `needs-human-review`, it touches no
sensitive path, and every required CI check of the repository is green. Squash, one at a time.

Sensitive paths (REQ-M04): `.github/`, `.mergify.yml`, `CODEOWNERS`, the root `AGENTS.md`,
`deploy/`, `ansible/`, `infra/`, `stacks/`, any `migrations/` directory, root `.env*`, plus a
per-repository list. A sensitive PR stays open with green CI. Mergify posts no comment on it:
the reason is in the "Mergify Merge Queue" check of the PR, which lists the unmet `-files`
condition. Labelling and commenting such PRs is T-M2b.

## The template

Copy it as `.mergify.yml`. Only two things change per repository: the `check-success` lines
(one per required check, named as GitHub shows them) and, when needed, extra paths appended to
the `-files` pattern. Keep `merge_method: squash` unless the repository only allows another one.

```yaml
# Memo Labs autoloop merge policy: memolabs-dev/memo-bridge docs/MERGIFY_FLEET_ADOPTION.md.
# A green PR from a trusted author lands without a human. Sensitive paths wait for the owner;
# the "Mergify Merge Queue" check on the PR names the condition that blocks it.
shared:
  land_conditions: &land_conditions
    - base = main
    - -draft
    - -from-fork
    - or:
        - author = memo-labs-automation[bot]
        - author = guillaume-flambard
    - label != hold-merge
    - label != needs-human-review
    - "-files ~= ^(\\.github/|\\.mergify\\.yml$|CODEOWNERS$|AGENTS\\.md$|deploy/|ansible/|infra/|stacks/|\\.env)|(^|/)migrations/"
    - "check-success = @github-actions/<required check>"

merge_queue:
  max_parallel_checks: 1

merge_protections_settings:
  auto_merge_conditions: *land_conditions

queue_rules:
  - name: memo-labs-autoloop
    batch_size: 1
    merge_method: squash
    queue_conditions: *land_conditions
    merge_conditions: *land_conditions
```

## Adopting a repository

1. Read the repository's `AGENTS.md` and `CONTRIBUTING.md`. If they say a human merges, the
   adoption PR changes that sentence too, or the repository is not adopted.
2. List its merge engines: `gh api repos/<r>/actions/workflows`, the `merge_queue` rule in
   `gh api repos/<r>/rules/branches/main`, and any bot that runs `gh pr merge`. Write down the
   required checks from the same rules call or from `branches/main/protection`.
3. Open one PR that adds `.mergify.yml` and removes the legacy engine in the same change
   (workflow file deleted, so both switch at the merge commit). When the legacy engine is a
   `pull_request_target` auto-merge workflow, open the PR as a draft, add `hold-merge`, then mark
   it ready: the base branch's copy of the workflow would otherwise arm auto-merge on the
   adoption PR itself. The PR touches `.mergify.yml`, so the owner merges it.
4. A ruleset `merge_queue` rule blocks every Mergify merge. It is removed, or Mergify is added as
   an `exempt` bypass actor on that ruleset, before adoption. Both are owner settings.
   Source: https://docs.mergify.com/merge-queue/github-rulesets.md
5. Positive canary: a small real code change, no sensitive path. Pass when
   `gh pr view <n> --json mergedBy` says `mergify`.
6. Negative canary: a small real change under a sensitive path. Pass when CI is green and the PR
   is still open with the `-files` condition unmet in the Mergify Merge Queue check. The owner
   then merges or closes it.
7. Set `delete_branch_on_merge` on the repository (T-C3, owner setting) and record the result in
   the table below.

## Rollback (REQ-M08)

Remove `.mergify.yml` (or add `hold-merge` to the open PRs while it is being removed) and only
then restore the legacy engine. Never two engines on the same repository at once.

## State of the fleet

Checked on 2026-10-17 with the calls of step 2.

| Repository | Visibility | Required checks | Legacy engine | Status |
|---|---|---|---|---|
| memolabs-dev/memo-bridge | public | `test (22)`, `test (24)` | `Land` workflow, disabled | ADOPTED: #154, canaries #155 (merged by Mergify) and #156 (held) |
| memolabs-dev/cuesheet | public | `Core and integration tests` | `auto-merge.yml`, disabled | pilot rules (bot only, size caps, code excluded); adoption PR replaces them |
| memolabs-dev/problem-intelligence-engine | public | `test (22)`, `test (24)` | none, the owner merges | adoption PR adds the template; AGENTS.md says the bot may arm GitHub auto-merge |
| memolabs-dev/uni-protocol | public | `UNI required checks` | `auto-merge.yml` (native auto-merge, no sensitive-path rule), active | adoption PR adds the template and deletes the workflow |
| memolabs-dev/drop | public | `test`, `test-windows`, `test-macos` | ruleset `merge_queue` rule, merge commits only | NOT ADOPTED: needs the owner to drop the `merge_queue` rule or exempt Mergify, and to change CONTRIBUTING ("The maintainer reviews and merges", security review on protocol, relay, node, runner, capabilities, requester-mcp). Extra sensitive paths then: `apps/desktop/src-tauri/tauri.conf.json`, `*.entitlements`, `apps/desktop/updater.pub`; `merge_method: merge` |
| memolabs-dev/lab-hub | public | `build` | none | NOTHING TO ADOPT: publish target of the private site, one commit, no pull request ever |
| private memolabs-dev repos | private | - | emargo `auto-merge.yml` | BLOCKED on U-02 (Mergify Free on private repos, emargo canary) |
| guillaume-flambard/* | mostly private | - | lab-infra `private-green-merge` | BLOCKED on U-01 (Mergify not installed on the personal account) |

## Annexe : le document du 16 octobre 2026, conservé tel quel

Sa politique par défaut (bot seul, date minimale, plafonds de taille, code exclu) est remplacée
par celle de cette page depuis la décision du 17 octobre (#151, #154). Le générateur
`scripts/mergify-fleet.mjs candidate` produit encore ces règles du pilote : ne pas l'utiliser
pour une adoption tant qu'il n'a pas été aligné sur le modèle ci-dessus. L'audit des 11 dépôts,
les conditions de passage et la liste des canaris négatifs restent valables comme contrôles.

### Mergify pour tous les projets Memo Labs

**État au 16 octobre 2026 :** infrastructure d'adoption générique préparée ; **aucune activation automatique hors de `memo-bridge`**. La référence de fonctionnement réel est [PR #141](https://github.com/memolabs-dev/memo-bridge/pull/141) (fusion par `mergify[bot]`), répétée par [PR #142](https://github.com/memolabs-dev/memo-bridge/pull/142). L'ancien workflow `Land` du dépôt `memo-bridge` est désactivé.

#### Pour n'importe quel dépôt

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

#### Conditions de passage en production (une seule fois par dépôt)

1. Vérifier que le dépôt est accessible, non archivé, et qu'il a une CI suffisante (tests pertinents, pas seulement un build de façade), avec les statuts GitHub reconnus sur de vrais SHA de PR. Pour des domaines sensibles (clinique, sécurité, infra, production, signature Apple), les validations métier/sécurité s'ajoutent.
2. Vérifier l'installation de l'application Mergify **pour ce dépôt précisément** et les contrôles GitHub. L'application peut nécessiter une autorisation d'administration ponctuelle, pas des interventions sur chaque PR.
3. Inventorier les contrôleurs existants : workflow GitHub `Land`, `auto-merge.yml`, bot maison, merge queue native, configuration distante. **Un seul exécuteur** doit pouvoir fusionner une même cohorte. Ne jamais les laisser en parallèle.
4. Installer le fichier candidat par PR, passer les tests GitHub et les contrôles de configuration Mergify, mais **garder la PR en draft** tant que la bascule n'est pas prête. Éviter de fermer une issue parent inachevée par une PR partielle.
5. Effectuer un cutover autorisé et réversible : désactiver l'ancien moteur, vérifier qu'il n'a plus de runs actifs, vérifier toutes les PR déjà ouvertes et renouveler la date de création **après cet audit**, sortir le fichier de draft et le fusionner en respectant les protections.
6. Lancer un **canari positif** qui n'altère qu'un document : PR non draft par le bot, sans label/revue manuelle, CI verte et fusion par `mergify[bot]`. Vérifier `merged_by`, le SHA et l'absence de Land.
7. Valider des **canaris négatifs** : draft, auteur non fiable, changement protégé, check manquant/en échec, base différente, fork, changements trop gros, hold et SHA périmé. Aucune fusion ne doit passer.
8. Consigner la preuve dans le Vault, l'issue du dépôt et `AGENTS.md`. Les prochaines PR ordinaires bénéficient alors de l'automatisation sans validation humaine systématique. Les changements sensibles passent toujours dans une voie distincte.

Si l'un des points manque : **BLOCKED**, aucune activation. Une seule approbation de bascule peut être nécessaire ; cela ne réintroduit pas des clics pour chaque PR de tous les jours.

#### Audit initial de 11 dépôts

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

#### Points volontairement non réalisés ici

- Aucun autre dépôt n'a reçu `.mergify.yml`, ni de modification de son workflow.
- Aucun accès Mergify à des dépôts supplémentaires n'a été accordé.
- Aucun contrôleur existant hors `memo-bridge` n'a été désactivé.
- Aucune des PR ouvertes des autres projets n'a été fusionnée.
- Les fichiers sources, scripts, permissions et autres fichiers sensibles ne passent **pas** automatiquement dans la file low-risk de référence. Leur extension nécessite un contrat propre au projet.

Références : [Mergify Auto-Merge](https://docs.mergify.com/merge-protections/auto-merge/) ; [conditions](https://docs.mergify.com/configuration/conditions/) ; [contrat d'origine](https://github.com/memolabs-dev/.github/blob/main/docs/landing-contract.md) ; [issue Memo Bridge #139](https://github.com/memolabs-dev/memo-bridge/issues/139).
