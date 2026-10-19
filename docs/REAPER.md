# Reaper: worktrees go away once their pull request has merged

Autoloop epic C (`.agent/project/autoloop/spec.md`, REQ-C01..C06), Issue #150.

Agents open worktrees for every task, through Memo Bridge or on their own (Claude Code, Codex).
Nothing removed them after the merge: on 2026-10-17 six repositories held 139 worktrees, 60 of
them for pull requests merged days earlier. The reaper removes those, and only those.

## What it removes

For every repository registered in `PROJECTS.md` on this host (`kind = repo`, GitHub origin), it
reads `git worktree list` and removes a worktree when all of this holds:

- its branch has a **merged** pull request whose head SHA is **exactly** the worktree HEAD
  (squash merges included: the PR head is what landed);
- it is not locked, not on a detached HEAD, no process has its cwd inside it (`lsof`);
- Memo Bridge does not hold it: its row's workspace is not active and no job is active on it;
- nothing in it was modified within the grace window (default 6 hours).

Local edits are archived before removal, in
`$MEMOLABS_ROOT/workspace/data/reaper-archive/<date>/<owner_repo-branch>.{diff,status,untracked.tar.gz}`.
If the archive cannot be written, the worktree stays. HEAD is checked again just before acting.

After removal it deletes the local branch when its tip is the merged PR head, marks the Memo
Bridge worktree row `removed`, and runs `git worktree prune`. Entries whose directory already
vanished are pruned. It never touches remote branches (set `delete_branch_on_merge` on the
repository for that), never merges and never deploys.

Unknown is treated as "keep": a failing `gh` call means no PR, a failing `lsof` means every
worktree is in use, an unreadable Memo Bridge store refuses `--apply`.

A worktree whose `.git` file points at a gitdir that no longer exists is kept with the reason
`broken_gitdir`. Moving a repository leaves this behind; `git worktree repair <path>` run from the
repository's new location relinks it, after which the reaper can judge it again.

## Run it

```sh
node scripts/reap-worktrees.mjs                 # dry run: one JSON line per worktree, a summary last
node scripts/reap-worktrees.mjs --apply         # act
node scripts/reap-worktrees.mjs --project drop --grace-hours 24
```

One run at a time: a lock file in the Memo Bridge state directory makes a second run exit with
`{"ok":false,"error":"locked"}` (exit 3). A lock older than two hours is taken over.

It needs `git`, `gh` (authenticated, read-only use: `gh pr list`) and `lsof` on `PATH`.

## Run it every hour

Disabled by default. The templates live in `deploy/reaper/`.

**Mac (launchd).** Copy `deploy/reaper/dev.memolabs.memo-reaper.plist.example` to
`~/Library/LaunchAgents/dev.memolabs.memo-reaper.plist`, replace `__BRIDGE_CHECKOUT__` with the
absolute path of an up-to-date main checkout of memo-bridge, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.memolabs.memo-reaper.plist`.
Logs: `~/Library/Logs/memo-reaper.log`.
Stop: `launchctl bootout gui/$(id -u)/dev.memolabs.memo-reaper`.

**VPS (systemd user units).** Copy `deploy/reaper/memo-reaper.service.example` and
`memo-reaper.timer.example` to `~/.config/systemd/user/memo-reaper.{service,timer}`, set the
checkout path, then `systemctl --user enable --now memo-reaper.timer`.
Stop: `systemctl --user disable --now memo-reaper.timer`.

## Rollback

Unload the timer. A removed worktree is recreated with `git worktree add <path> <branch>` from
the merged commit (the branch head is in the merged PR); local edits are in the archive:
`git apply <name>.diff` and `tar -xzf <name>.untracked.tar.gz`.
