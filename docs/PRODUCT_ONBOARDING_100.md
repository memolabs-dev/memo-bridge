# Controlled private-repository activation: Rebuild Radar & Mobile Explorer

Owner issue: [memo-bridge#100](https://github.com/memolabs-dev/memo-bridge/issues/100). Date: 2026-10-16.
**This runbook is a staging plan and a read-only verification contract, not an authorization to execute.**

## Verified baseline

| Layer | Rebuild Radar | Mobile Explorer | Evidence |
|---|---|---|---|
| Mac canonical registry | `products/rebuild-radar` | `products/mobile-explorer` | `~/memolabs/PROJECTS.md` Mac read |
| GitHub origin | `memolabs-dev/rebuild-radar` | `memolabs-dev/mobile-explorer` | `gh repo view` (Mac, owner) |
| Repository visibility | **private** | **private** | `gh repo view` |
| Initial code PR | #1, OPEN | #1, OPEN | `gh pr view` |
| Exact PR head SHA | `698954cb29fe6567345f4363ad123b2de590e1ce` | `9bc3618c5397b8d64d1b142e33d140bc1c963f41` | `gh pr view`; subject to change |
| CI at that SHA | `validate` SUCCESS | `swift-build` SUCCESS | GitHub Actions checks |
| Per-repo `land.yml` | **absent** | **absent** | `.github/workflows` in each code worktree |
| VPS `projects_list` | absent | absent | returns only `memo-bridge`, `cuesheet`, `uni-protocol` |
| GitHub App | org installation exists, **selected** repos | same | `gh api orgs/memolabs-dev/installations` |
| Installation access to either repo | **not verified** | **not verified** | Mac `gh` session lacks `read:user` for installation repo list; its personal ADMIN rights are not App rights |
| Lease eligibility for private repos | **denied by policy** | **denied by policy** | `memolabs-dev/.github/scripts/issue_preflight.py`: `PUBLIC_ALLOWLIST` and `private is False` guard |

Successful product CI proves **neither** executable VPS registration **nor** authorized automatic merge. The two repos remain private.

## Read-only checks

```sh
# Can run on Mac with a suitable owner-authorized gh session; never writes to GitHub:
node scripts/check-product-github.mjs rebuild-radar mobile-explorer

# On Mac and separately inside provisioned VPS runner, local registry + ledger preflight:
node scripts/check-product-onboarding.mjs rebuild-radar mobile-explorer
```

The first script reads fixed GitHub repo metadata, PR #1, check runs at that **exact head SHA**, per-repo workflow presence, and org App installation *selection mode*. It intentionally does **not** infer the App's selected repository list from a personal account's repo permissions or from the mere existence of the installation. The second script also fails closed when either repo is absent in the local runner registry or ledger. Do not treat their output as a bearer credential or executable grant.

## Ordered implementation: changes must land through their own scoped review

1. **Governance `memolabs-dev/.github`**: add **only** these two explicitly named private repos to a dedicated reviewed `PRIVATE_ALLOWLIST` in `scripts/issue_preflight.py`. Keep the public pilot allowlist separate and unchanged. Update `checked_repo()` to accept the exact union; `assess()` must require `private is True` for private entries and `private is False` for public entries, `archived is False` for both, plus exact repository identity. Tests: public path unchanged; private correct metadata allowed for issue eligibility; private in public list refused, public in private list refused; archived/renamed/unauthorized rejected. Review `scripts/issue_lease.py` dependency on `checked_repo` and keep all hold/release race guards. A private repo does not become an unrestricted execution target.
2. **GitHub App org installation**: since `memo-labs-automation` is installed in `repository_selection=selected`, an org owner must explicitly grant the *two new repos* to that installation. Verify repository-scoped installation token access **without logging the token**, scoped to the single target repository, with minimum Contents/PR/Issues rights already needed by runner. Do not grant `all repositories`, enlarge the App's scopes, replace the credential with a personal PAT, or mutate the installation through this read-only preflight.
3. **VPS checkout through `lab-infra`**: create a dedicated reviewed infra PR extending the runner's canonical `PROJECTS.md` with each repo at a **unique runner-owned path** under the existing runner root. Provision the checkouts as `memo-runner` under existing path, group and systemd isolation. Ensure no secrets are copied into checked-out files, no ownership changes on other repos, no cwd/command allowlist broadening and no override of runner resource ceilings. Record explicit rollback (disable new entries and remove only the dedicated checkouts after claims/jobs end). Avoid writing directly to production or using root except through the existing approved infra rollout.
4. **Per-repo landing**: in separately claimed worktrees/PRs, add `.github/workflows/land.yml` calling the trusted reusable organization workflow in `memolabs-dev/.github`, with the exact required CI workflow names `Verify` / `Verify SwiftUI`, and the required check names `validate` / `swift-build`. Follow the established **workflow_run → exact tested head SHA → policy decision** contract and review `hold-merge`, actor, path risk and branch protection before enabling. No workflow from an unreviewed PR may be allowed to alter landing policy. Where a bootstrap merge is required, first review the landing workflow via the normal protected-branch mechanism rather than bypassing it.
5. **Verify**: new `projects_list` entries `available=true` on VPS **with correct names, origins, and host paths**; preflight succeeds on both hosts; fresh PR #1 CI verifies the current SHA, GitHub App token for each repo can perform only intended operations; landing accepts eligible PRs and rejects failing/pending/wrong-SHA/held PRs. Record GitHub Actions run URLs, SHA and runner audit receipt, **then** close #100. Without these proofs keep #100 open.

## Invariants & rollback

- Mac metadata snapshots are discovery, not authorization. No snapshot-only project starts a workspace or a job.
- The root protected branch is never pushed or merged by a ChatGPT agent.
- GitHub App repo selection is validated separately from the owner's personal CLI.
- CI success never overrides reviewer and `hold-merge` requirements. Never merge a PR with a check from another SHA.
- For any failure, keep the affected project unclaimable and its PR open. Revoke the two new App selections and lease allowlist entries only through their own approved governance changes, without affecting existing pilot repos.

## Evidence to attach to #100 before completion

`governance PR + tests`, `lab-infra PR + safe rollout/rollback`, `App selection verification`, `VPS project preflight`, `per-repo landing PR/CI exact SHA`, `runner task claim and read-only smoke receipt`, `merged product PR #1 receipts`.

### Follow-on product work

Once both protected landing paths are operational, create a **separate scoped Rebuild Radar V0.2 Issue** (persistent GitHub ingestion, timestamps, rate limits, evidence provenance, validation). Never attach this product change to the coordinator authorization issue.
