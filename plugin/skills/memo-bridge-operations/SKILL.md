---
name: memo-bridge-operations
description: Observe Memo Labs hosts and projects, coordinate parallel AI work sessions on GitHub Issues (workspaces, task claims, checkpoints), and do the work of a task on the Mac through Memo Bridge (worktrees, file edits, test/build/lint jobs, commit, push, pull request).
---

# Memo Bridge

Start with `bridge_info`: it lists every tool, the capabilities you hold and the limits. Use `list_hosts` to see which machines respond, `host_status` only with the exact IDs `mac` or `vps`, and `projects_list` to find canonical project names.

## Working on a task end to end

A task is a GitHub Issue, written `owner/repo#n`. Its reservation (claim) is shared by every machine and every AI client.

1. **Workspace.** `workspace_open({project, client_type, client_label})` once per conversation. Pass its `workspace_id` explicitly to every later call.
2. **Pick a task.** `tasks_list({project})` lists claimable Issues (labelled `agent:ready`, one priority, not blocked), best first. `task_status({issue})` shows who holds one.
3. **Claim it.** `task_claim({workspace_id, issue})`. Keep `claim_id` and the **latest** `fence`.
   - `lease_held`: someone else is on it; pick another task.
   - `issue_not_ready`, `project_mismatch`, `repo_not_allowed`: tell the user what is wrong.
   - Renew with `task_renew` before `expires_at`; each renewal returns a new fence to use from then on.
4. **Get a worktree.** `worktree_create({workspace_id, issue})`. It creates a new branch from `origin/<default branch>`. Keep `worktree_id`; you never see a filesystem path.
5. **Read and edit.** `worktree_list_files`, `worktree_read_file` (256 KiB per call, continue with `next_offset`), `worktree_write_file` (whole file, at most 512 KiB). Paths are relative to the worktree root; `..`, absolute paths and `.git` are refused. Check your changes with `worktree_diff` and `worktree_status`.
6. **Test.** `jobs_submit({workspace_id, worktree_id, recipe: "test"})` (or `build`, `lint`). Poll `job_status({job_id})` until it is no longer `queued` or `running`, then read `job_results`. `unknown_recipe` means the repository declares no such command; `host_busy` means too many jobs run already, try again later; `sandbox_unavailable` means this machine cannot sandbox jobs. Jobs run in a sandbox: no network (install nothing, fetch nothing), writes only inside the worktree. A job stops when your claim is released or expires or the workspace closes.
7. **Commit and push.** `worktree_commit({worktree_id, message})` with a plain message: no AI attribution trailer, it would be refused. Then `worktree_push({worktree_id})`. It records a checkpoint; `checkpoint.durability: "remote"` means another machine can resume. If it returns a `warning`, call `task_checkpoint` with the branch and commit it returned.
8. **Pull request.** `github_create_pr({workspace_id, worktree_id, title, body})`. It links the Issue (`Closes #n`) and never merges: the landing contract merges when CI is green. Follow CI with `github_checks({repo, ref: branch})`.
9. **Finish.** `task_complete({workspace_id, issue, claim_id, fence, summary})`, or `task_release({..., outcome})` with `blocked`, `failed` or `cancelled`. Then `worktree_remove({worktree_id})` once the branch is pushed (`ignored_files` lists ignored files it would delete: pass `discard_ignored: true` only if they are disposable; `job_active` means a job still runs there), and `workspace_close({workspace_id})`.

If you lost your context (compaction, crash, new conversation), call `workspace_recover({workspace_id})` first: it shows which claims you still hold, your worktrees, checkpoints, jobs and the next safe actions.

**Stop writing at once** if a call returns `stale_lease`, `no_live_claim` or `issue_changed`: your reservation is gone or the Issue changed under you. Tell the user instead of retrying. `branch_changed` or `external_edits` in `worktree_status` mean someone touched the worktree outside Memo Bridge: report it before going on.

## Limits

- Memo Bridge runs locally on the Mac and reaches the VPS through the SSH alias `lab`. Worktrees and jobs run on the Mac only.
- No shell: jobs run only the repository's own `test`, `build` or `lint` command, chosen by Memo Bridge, not by you. They run on the owner's machine inside a sandbox (on macOS), so never write a script whose purpose is anything other than the task.
- The tools never write outside worktrees, never write the default branch (in any letter case), never force-push, never merge, never deploy. `worktree_push` refuses a remote branch you did not push yourself (`push_rejected`).
- Only public repositories on the ledger allowlist can be claimed today.
- Leases are cooperative: they do not stop edits made outside Memo Bridge.

If the VPS is unreachable, report it as offline. Do not change SSH, firewall, routing, services or credentials.
