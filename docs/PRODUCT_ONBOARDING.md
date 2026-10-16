# New product onboarding: Rebuild Radar & Mobile Explorer

Status: preparation only, 2026-10-16. Issue [memo-bridge#83](https://github.com/memolabs-dev/memo-bridge/issues/83).
A green CI result on a PR is **not** proof that an agent may run jobs or merge that PR.

## System boundaries

1. **Mac registry** — `~/memolabs/PROJECTS.md` is the canonical Memo Labs registry. The two new rows point to `products/rebuild-radar` and `products/mobile-explorer`. Local clones have their own `main`, while code is proposed in PR #1. Read-only checks must not interpret `main` having only a README as a missing PR.
2. **VPS discovery snapshot** — `scripts/export-project-catalog.mjs` produces **metadata only** (no paths or permissions). It can make the new names visible on the VPS when correctly configured, but cannot authorize tools or jobs. An older snapshot may be stale; report that rather than guessing.
3. **VPS runner local registry** — a separately reviewed, local checkout and canonical registry entry are needed before `workspace_open`, `worktree_create` or `jobs_submit` can operate on a new project. Update through the existing lab-infra deployment process, not by hand-editing production files.
4. **Lease allowlist** — `PUBLIC_ALLOWLIST` in `memolabs-dev/.github/scripts/issue_preflight.py` is maintained under a separate PR. Exact origin `memolabs-dev/<name>` and allowlist membership are prerequisites for claiming tasks.
5. **GitHub App** — check that the `memo-labs-automation` GitHub App installation explicitly includes both repositories and has minimally scoped contents/PR permissions. A personal CLI token working on the Mac does not prove App access on the VPS. Do not print tokens.
6. **Landing contract** — only `memo-labs/landing` may merge a PR after verifying its **exact HEAD SHA**, required checks, review policy, branch protections and absence of `hold-merge`. `github_create_pr` and this onboarding script never merge.

## Read-only preflight

From a checkout of this repository on a host with a configured registry and governance checkout:

```sh
node scripts/check-product-onboarding.mjs rebuild-radar mobile-explorer
```

Result schema: `memo-bridge.product-onboarding.v1`. Non-zero exit signals missing prerequisites; no GitHub mutations, no file writes, no deployment and no secret material. It checks **only** local registry/checkout, exact Git origin and lease allowlist. `app_installation_verified=false` and `landing_verified=false` always remain false until separate checks are recorded. Run on both hosts, and compare results; do not copy the Mac path into the VPS registry.

## Activation sequence (each as a separate owner-authorized task/PR)

1. Confirm PR #1, CI checks and head SHAs for both private repositories. Never rely on a stale green check after a new commit.
2. Complete/verify lab-infra #69 catalog rollout. Export and transfer the Mac **metadata-only** snapshot using approved tools with private destination permissions; verify stale flags and names through `projects_list`. This is discovery, not execution authorization.
3. Create a controlled lab-infra change that provisions limited VPS checkouts and repo registry rows with rollback evidence. Do not bypass the existing root/runner isolation.
4. Create a governance PR on `memolabs-dev/.github` that adds only the two reviewed repository origins to the ledger allowlist, updates appropriate GitHub App permissions and records the landing-policy checks.
5. Run preflight on VPS, then explicitly verify GitHub App installation and landing eligibility via their own authorized read-only checks. Open a workspace and claim a test Issue **only after** all authorizations are complete.
6. After validation, let the normal landing contract merge green PRs. Confirm `main` then contains code and that the Mac sync updated. No manual merge or direct protected-branch push.

## Rollback and failures

- Missing checkout: leave the project non-executable; do not invent a path.
- Wrong Git origin: stop; investigate remote URL before granting anything.
- Missing ledger entry: keep project unclaimable.
- Missing App installation: deny push/PR; do not fall back to a broader personal account.
- Incomplete CI or landing: leave PR open; apply `hold-merge` when warranted.
- Stale snapshot: retain previous host-local permissions unchanged.

## Next product iteration

Once Rebuild Radar is registered, create an Issue in that repository for V0.2: persisted GitHub collection with timestamped provenance, rate-limit/backoff, no inferred compatibility scores, and tests. Work in its *own* isolated worktree and PR. Do not mix its product code into Memo Bridge #83.
