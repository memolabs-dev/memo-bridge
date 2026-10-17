# Memo Labs — Mergify unattended landing (memo-bridge)

**Status: ACTIVE.** Cutover on 2026-10-16; autoloop policy (#151) replaces the pilot rules once its PR lands and its canaries pass.
Source of truth: `.mergify.yml` on `main`.

## Production proof

- [PR #137](https://github.com/memolabs-dev/memo-bridge/pull/137) merged at **2026-10-16 17:47:54 UTC**, after Node 22 / Node 24 CI and Mergify configuration/protection checks passed.
- The former GitHub Actions workflow **`Land`** (`.github/workflows/land.yml`, workflow id `383543538`) was disabled using `gh workflow disable land.yml` with the authenticated repository ADMIN account. Official GitHub API returned **`disabled_manually`**.
- [PR #141](https://github.com/memolabs-dev/memo-bridge/pull/141) was **created by Memo Bridge as a non-draft docs-only PR without labels, reviewer approvals or manual merge**. GitHub Actions `test (22)` and `test (24)` succeeded. Mergify then merged it automatically.
- GitHub's official pull-request API returned `merged_by.login = mergify[bot]`, `merged_at = 2026-10-16T17:52:12Z`, `merge_commit_sha = 594161ca70152a293a63916dc15b084ece81d5a1`.
- No new `Land` workflow run occurred after cutover. Old draft PRs #89, #106 and #135 remained open and unmerged.
- Issue [#138](https://github.com/memolabs-dev/memo-bridge/issues/138) records the cutover, and [#140](https://github.com/memolabs-dev/memo-bridge/issues/140) records the first positive unattended canary.

## What is automatically eligible

**Policy since the autoloop change (Issue #151, owner decision of 2026-10-17):** a green PR from a
trusted author lands without a human. The 2026-10-16 pilot rules (bot author only, created-at
cutoff, size cap, all code paths excluded) are gone: in practice they let only documentation land
and left about twenty green PRs open across the fleet.

PRs land when **all** of the following hold on the exact head:

- Target `main`, non-draft, same repository.
- Author `memo-labs-automation[bot]` or `guillaume-flambard`.
- Not labeled `hold-merge` or `needs-human-review`.
- No sensitive path: `.github/`, `.mergify.yml`, `CODEOWNERS`, the root `AGENTS.md`, `deploy/`,
  `infra/`, environment files. Code under `server/`, `bridge/`, `plugin/`, `scripts/`, `tests/` and the manifests lands
  on green CI like anything else.
- GitHub Actions `test (22)` and `test (24)` succeeded.
- Serialized queue `memo-labs-autoloop` (`batch_size: 1`, `max_parallel_checks: 1`), squash.

A PR that touches a sensitive path is not merged. Mergify posts no comment on it (checked on
#156): the "Mergify Merge Queue" check of the PR lists the unmet `-files` condition, and the
daily stuck-PR report (autoloop T-O1) lists it for the owner.
Labelling such PRs through `pull_request_rules` needs Mergify Workflow Automation, which is not
activated on this organization (Configuration changed check on #154).

Pausing: add `hold-merge` to a PR, or put it back to draft.

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
