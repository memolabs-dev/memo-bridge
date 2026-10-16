# Memo Bridge VPS — Git author identity for new projects

**Status: fixed and proven on 2026-10-16.** See [issue #144](https://github.com/memolabs-dev/memo-bridge/issues/144) and [Cuesheet PR #74](https://github.com/memolabs-dev/cuesheet/pull/74). The setup is per **runner service account**, not per project, and works for all repository worktrees executed by that service on the same host.

## Failure and root cause

`worktree_commit` invokes `git var GIT_AUTHOR_IDENT` under the **Memo Bridge runner process's Git environment**. If the user has no valid Git identity it correctly returns `git_identity_missing` before staging or committing. **Do not remove this guard**, forge a commit author, or bypass worktree claims.

The VPS service `memo-bridge-runner.service` runs as `memo-runner`. Its effective process environment had `HOME=/var/lib/memo-runner/state`, **not** the home recorded in `getent passwd memo-runner` (`/var/lib/memo-runner`). The latter directory is intentionally root-owned (`root:root`, mode `755`), so writing `/var/lib/memo-runner/.gitconfig` did **not** fix Git for the service.

The effective Git configuration lives at **`/var/lib/memo-runner/state/.gitconfig`**. On 2026-10-16 the owner-authorized root operator configured the GitHub account owner's own verified profile identity at that path, after checking the systemd service user, directory owner, lack of symlinks, and file ownership. `.gitconfig` is owned by `memo-runner:memo-runner` with mode `600`. No source, GitHub permissions, secrets, workflow, service unit or top-level home ownership was changed.

## How to diagnose any new runner host

1. Identify the runner user with `systemctl show memo-bridge-runner.service -p User --value` and confirm the executing process belongs to that user.
2. Inspect **only the allowlisted environment variable `HOME`** from the service's live process (do not expose all of `/proc/<pid>/environ`, which may contain credentials). The effective `HOME` overrides the account directory in `/etc/passwd`.
3. Confirm that `HOME` points to an expected runner-owned state directory, is not a symlink, and that `$HOME/.gitconfig` is not an unsafe symlink or owned by an unexpected user.
4. Obtain **the actual GitHub owner's Git author name and email** through an authorized account read or owner confirmation; never invent an identity or use a generic bot identity as a substitute for the owner's authorization.
5. As the authorized administrator, configure Git **under the exact service user's effective HOME**, ensuring `.gitconfig` belongs to the service user, mode `0600`. Keep the existing service directory ownership and branch permissions intact. A `runuser`-based setup can be used only through the approved privileged runner path.
6. Verify `GIT_AUTHOR_IDENT` **as the service user in the same HOME**, and then make a real `worktree_commit` through Memo Bridge with a live issue claim. A `git config` printout alone is not sufficient.

Example administrator verification on the VPS, after independently confirming the actual user and effective HOME:

```bash
# Use only through the owner-authorized root operator or approved system administrator.
test "$(systemctl show memo-bridge-runner.service -p User --value)" = memo-runner
test "$(stat -c %U /var/lib/memo-runner/state)" = memo-runner
test ! -L /var/lib/memo-runner/state/.gitconfig
runuser -u memo-runner -- env HOME=/var/lib/memo-runner/state git var GIT_AUTHOR_IDENT >/dev/null
stat -c '%U:%G:%a' /var/lib/memo-runner/state/.gitconfig
```

Expected owner and mode: `memo-runner:memo-runner:600`. These checks never print an email address or token.

## Verified recovery

- Existing Cuesheet task [#73](https://github.com/memolabs-dev/cuesheet/issues/73) had **1085 successful tests, 0 failures, 23 skipped** and a candidate `.mergify.yml` validated by Mergify CLI.
- Before correcting the service user's effective HOME, `worktree_commit` returned `git_identity_missing`, **even after** writing a file under the account's `/etc/passwd` home. This is the regression evidence.
- After correcting the effective HOME, a fresh claimed Cuesheet worktree made commit **`ecee49491376f15f38a56f224cfa489552a8d595`** successfully using Memo Bridge `worktree_commit`.
- Memo Bridge `worktree_push` then pushed it to `agent/73-ocwsgylm`; a draft [Cuesheet PR #74](https://github.com/memolabs-dev/cuesheet/pull/74) was created using Memo Bridge `github_create_pr`. Thus identity, claim, commit, push and PR opening were proven end to end.
- Cuesheet's legacy `.github/workflows/auto-merge.yml` remains **active**; this Git-identity fix does not authorize the Mergify cutover. Its config is purposely **inert (future cutoff 2099)** and PR #74 is **draft**.

## New project onboarding contract

A new repository using this same VPS runner now inherits the corrected runner-level identity automatically. The project must still have a registered origin, real GitHub CI, an isolated claim/worktree, protection rules, its own safe Mergify conditions and exactly **one** merge executor. Different hosts, service users or HOME paths require their **own verified provision**; do not apply the VPS configuration blindly to the Mac or another runner.

## Rollback and incident response

If author attribution is wrong, stop creation of new commits, inspect the actual service HOME, and correct the configuration through the same authorized administrator path. Avoid deleting or changing the runner home tree, and never alter historical commit authors. Changes to Git author identity do not grant GitHub permissions or permission to force merge.
