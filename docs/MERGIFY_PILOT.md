# Memo Labs — Mergify unattended landing (memo-bridge)

**Status: ACTIVE AND VERIFIED.** One-time cutover completed on 2026-10-16.
Source of truth: `.mergify.yml` on `main`.

## Production proof

- [PR #137](https://github.com/memolabs-dev/memo-bridge/pull/137) merged at **2026-10-16 17:47:54 UTC**, after Node 22 / Node 24 CI and Mergify configuration/protection checks passed.
- The former GitHub Actions workflow **`Land`** (`.github/workflows/land.yml`, workflow id `383543538`) was disabled using `gh workflow disable land.yml` with the authenticated repository ADMIN account. Official GitHub API returned **`disabled_manually`**.
- [PR #141](https://github.com/memolabs-dev/memo-bridge/pull/141) was **created by Memo Bridge as a non-draft docs-only PR without labels, reviewer approvals or manual merge**. GitHub Actions `test (22)` and `test (24)` succeeded. Mergify then merged it automatically.
- GitHub's official pull-request API returned `merged_by.login = mergify[bot]`, `merged_at = 2026-10-16T17:52:12Z`, `merge_commit_sha = 594161ca70152a293a63916dc15b084ece81d5a1`.
- No new `Land` workflow run occurred after cutover. Old draft PRs #89, #106 and #135 remained open and unmerged.
- Issue [#138](https://github.com/memolabs-dev/memo-bridge/issues/138) records the cutover, and [#140](https://github.com/memolabs-dev/memo-bridge/issues/140) records the first positive unattended canary.

## What is automatically eligible

The new policy uses `merge_protections_settings.auto_merge_conditions`, the named `memo-labs-safe-auto` queue and identical conditions on both queue entry and landing.

PRs must satisfy **all** of the following:

- Created at or after **2026-10-16 17:30 UTC**, targeting `main`, non-draft, same-repository, author exactly `memo-labs-automation[bot]`.
- Not labeled `hold-merge` or `needs-human-review`.
- Small: no more than 8 files, 400 added and 150 deleted lines.
- No sensitive paths: `.github/`, `.mergify.yml`, `server/`, `bridge/`, `plugin/`, `deploy/`, `scripts/`, `tests/`, `infra/`, `config/`, environment files, `AGENTS.md`, CODEOWNERS, Dockerfiles, package manifests and lockfiles.
- Exact PR head must pass **both** GitHub Actions check runs `test (22)` and `test (24)`.
- Serialized queue (`batch_size: 1`, `max_parallel_checks: 1`), squash merge. The GitHub PR-only ruleset still applies.

**No label or human approval is required for this limited, objective low-risk lane.** Higher-risk changes, migrations, CI/auth/security, workflow edits and deployment are **not** eligible and still need the applicable separate review/authorization.

## Operator runbook

1. Agents continue Issue → claim → isolated worktree → code → test → pushed branch → non-draft PR. They **never** merge PRs directly.
2. For normal low-risk agent PRs, do not attach `mergify:pilot`, `landing:approved`, or issue GitHub native auto-merge commands. Simply let the validated CI and Mergify queue run.
3. If CI fails, task owner inspects failures, fixes under its own reservation and pushes a new commit. Mergify must only consider current evidence.
4. For a PR requiring human review, use draft mode and/or `hold-merge`/separate security review. Do not remove safety controls merely to force a merge.
5. Verify the merge actor through GitHub's API when auditing. A Mergify `Merge Queue: neutral` check *before* CI success is not an indication of a failed policy; read the check's condition summary after CI.
6. If the old `Land` workflow is re-enabled accidentally, immediately stop new eligible canaries and correct the dual-controller configuration. **Only one merge executor** may be active for this cohort.

### Rollback

Keep CI and repository ruleset intact. Disable the affected Mergify automation / revert its `auto_merge_conditions` through a reviewed change **before** enabling legacy `Land`. Do not allow both to act simultaneously. Retain Mergify and GitHub audit logs.

## Memo Labs scope

This live result applies **only** to `memolabs-dev/memo-bridge`. Other projects (Drop, Cuesheet, Kollio, Emargo, UNI, lab-infra, etc.) keep their current safe landing implementation until their own Mergify GitHub App installation, checks, sensitive paths and exclusive-controller tests are validated. [Issue #139](https://github.com/memolabs-dev/memo-bridge/issues/139) tracks this matrix.

Global human-readable rule is recorded in the Vault note `~/Vault/4-Tools/Memo Labs Automatic Landing.md` and shared `~/memolabs/AGENTS.md`.

## Vendor references

- https://docs.mergify.com/merge-protections/auto-merge/
- https://docs.mergify.com/configuration/conditions/
- https://github.com/memolabs-dev/.github/blob/main/docs/landing-contract.md
