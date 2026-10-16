# Mergify pilot for memolabs-dev/memo-bridge

Status: **canary only — not enabled for normal PRs**.

## Intent
Mergify's free tier covers private teams of up to five active human contributors; bots do not count as active contributors. Test the managed GitHub merge queue rather than inventing another production merge worker. The GitHub App installation is an independent action performed by the repository administrator through the Mergify dashboard; committing this file alone does **not** install or authorize it.

## Install the GitHub App (repository owner action)
1. Open https://dashboard.mergify.com/home while logged in.
2. Select the GitHub organization `memolabs-dev`; use **Configure repositories** (or **Integrations → GitHub → Repositories**).
3. Click **Add Repository** if `memo-bridge` is missing. GitHub asks for App authorization; choose **Only select repositories**, then select `memolabs-dev/memo-bridge` (not all private repositories).
4. In the product grid for that repository, enable **Merge Queue** and **Workflow Automation**, then **Save Changes**. Do not configure an organization-wide default without reviewing it.
5. Confirm Mergify sees the repository. Check the validation of `.mergify.yml` once merged to `main`; Mergify reads its configuration from the default branch, not an unmerged feature branch.

See https://docs.mergify.com/integrations/github/ and https://docs.mergify.com/configuration/file-format/.

## Canary policy (from .mergify.yml)
Only a pull request satisfying **all** conditions enters the named `memo-labs-canary` queue:

- Target branch is `main`, PR is not draft, author is exactly `memo-labs-automation[bot]`.
- PR has **both** labels `mergify:pilot` AND `landing:approved`; `hold-merge` is absent.
- At least **one genuine approved review**. GitHub itself must also continue enforcing any native ruleset/branch protection; Mergify's rules do not prevent privileged users from manually bypassing unprotected branches.
- GitHub Actions check runs `test (22)` and `test (24)` are successful. The source app is explicitly constrained to `@github-actions`.
- Queue size = **one PR**, max parallel checks = **one**, squash merge only. Conditions are checked for queue entry AND again before merge.

This opt-in policy intentionally does **not** automatically merge existing PRs, even those with green CI. Do not add the canary labels to PR #89 (protected workflow proposal), #106 (SQLite v9 migration), or unrelated drafts.

## One controlled end-to-end test
1. Ensure the repository's existing landing automation and Mergify cannot both act on the **same test PR**. Use a fresh, non-critical PR whose single-purpose changes have been reviewed; do not use an in-flight migration or production deployment.
2. Confirm `test (22)` and `test (24)` pass on the PR and that it targets `main`.
3. Have an authorized independent reviewer approve it after checking its intended changes.
4. Apply `mergify:pilot` and `landing:approved` only to that reviewed PR. Observe Mergify queue entry, fresh CI on the integration branch and exactly one squash merge. Confirm GitHub audit events and main CI.
5. Negative canaries: draft, `hold-merge`, one missing required check, stale commits, no approval, missing pilot label, untrusted author. None may merge. Stop on any unexpected merge or status.

A label is an authorization signal **only insofar as its setters are restricted**. Do not let arbitrary contributors apply `landing:approved` or change `.mergify.yml`; ensure independent code-owner review on authorization/CI files if available. The current free GitHub tier for private repositories may lack mandatory branch protection. Mergify's voluntary queue rules alone cannot block direct privileged merges.

## Rollback
Remove the two pilot labels from queued PRs and dequeue them in the Mergify dashboard. Disable **Merge Queue** and **Workflow Automation** for just `memo-bridge` and save; use GitHub App installation settings to revoke the repository permission if appropriate. Do not change other repositories, workflows, tokens, or the repository default branch.

## Follow-up
After one successful positive canary and the negative tests, replace the temporary `mergify:pilot` opt-in with a narrowly verified automatic acceptance policy. Keep Memo Source Engine for issue/worktree/audit orchestration, not for a second competing GitHub merge executor. Coordinate this with #88 and #129.
