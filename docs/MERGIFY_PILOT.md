# Memo Labs — Mergify low-risk auto-merge migration

**State: PROPOSED; must remain DRAFT until the competing GitHub `Land` workflow is disabled or proven non-overlapping. No production activation yet.**

## Context

The first Mergify pilot (`memo-bridge` PR #133) worked with two manual labels and an approving review. This is NOT the desired agent workflow. The replacement policy in issue #136 allows **new low-risk bot PRs** to enter Mergify automatically without labels or human approvals.

Source of truth is `.mergify.yml`, with `merge_protections_settings.auto_merge_conditions`, serialized `queue_rules`, and the same `merge_conditions` at landing time.

## Eligible cohort (after activation)

- PR created at/after **2026-10-16T17:30:00Z**; no old/open PR is ever picked retrospectively.
- Base `main`, non-draft, same repository, author `memo-labs-automation[bot]`.
- Neither `hold-merge` nor `needs-human-review`; only up to 8 files, 400 additions and 150 deletions.
- Sensitive paths excluded: `.github/`, `.mergify.yml`, `server/`, `bridge/`, `plugin/`, `deploy/`, `scripts/`, `tests/`, `infra/`, `config/`, environment files, `AGENTS.md`, CODEOWNERS, Dockerfiles, package and lockfiles.
- Required current GitHub Actions checks `test (22)` and `test (24)` must both be **success**.
- Exactly one queued change at a time; squash merge. No direct merge by the agent.
- CI failed, pending, missing, stale or policy uncertain → do not merge. Protected/security/infra/migration changes remain in an explicit stronger review lane.

## CRITICAL: existing landing executor still active

Verified on 2026-10-16: `memolabs-dev/memo-bridge/.github/workflows/land.yml` triggers on completion of `CI` via `workflow_run` and invokes `memolabs-dev/.github/.github/workflows/land.yml@main`. Its governance contract `memolabs-dev/.github/docs/landing-contract.md` merges trusted same-repo PRs with green CI and no `hold-merge`.

**This overlaps Mergify's intended cohort.** A new `.mergify.yml` alone cannot safely switch off `Land`. Keep the policy-change PR as **draft** and do not deploy `auto_merge_conditions` until the active legacy `Land` workflow is disabled or modified via a separately reviewed repository-admin workflow change. Do not use `hold-merge` as a workaround: it is a genuine global human stop signal and must block BOTH engines.

One-time cutover procedure:
1. Review and disable the conflicting `Land` workflow for `memo-bridge` through the approved repo-admin route, while keeping normal CI enabled.
2. Confirm no `Land` workflow runs can merge newly eligible PRs, including race with in-flight runs.
3. Merge and deploy this Mergify configuration only after receiving evidence that Mergify Merge Queue and Merge Protections are enabled for `memo-bridge`.
4. Create one harmless **new** docs-only positive canary after the cutoff; prove CI green → Mergify queue → exactly one squash merge **without labels or human interaction**.
5. Negative canaries (draft, hold-merge, fork, protected file, failure, oversized diff, stale SHA, untrusted author) must not merge. Check GitHub/Mergify audit events.
6. Fail closed and roll back if any legacy executor merges in the same cohort.

The repo's `Land` workflow is under `.github/workflows/` and is protected against agent modification by Memo Bridge. **Do not bypass this boundary.**

## Across Memo Labs

The owner chose: Memo Bridge/Source Engine for task orchestration; Mergify as the sole merge executor **for each repository AFTER independent verification**. The other projects (Drop, Cuesheet, UNI, Kollio, CDKF, Emargo, lab-infra, lab-hub, etc.) remain on their existing landing contracts until their CI, paths, deployment and Mergify permissions are checked. A shared global policy is recorded in `~/memolabs/AGENTS.md` and Vault `4-Tools/Memo Labs Automatic Landing.md`; this is not an automatic change to other repos.

## References

- https://docs.mergify.com/merge-protections/auto-merge/
- https://docs.mergify.com/configuration/conditions/
- https://github.com/memolabs-dev/.github/blob/main/docs/landing-contract.md
- https://github.com/memolabs-dev/memo-bridge/issues/136

## Rollback

Keep CI, branch protections and audit history. Disable Mergify auto-merge or revert `auto_merge_conditions` using a reviewed change. Do not re-enable `Land` until Mergify is disabled for that cohort.

### Activation-cutoff caveat

The literal `created-at` cutoff protects PRs older than 2026-10-16T17:30:00Z. If the one-time cutover happens **after** that date, PRs created since then could be pending and would be auto-queued once the configuration is merged. Therefore, before undrafting, the release coordinator **must update the cutoff to a time later than the actual activation, inspect all currently open PRs, and prove none matches**. Re-run Mergify configuration validation and CI on that exact commit. Never treat the initial timestamp as a permanent proof that no pre-existing PR can merge.
