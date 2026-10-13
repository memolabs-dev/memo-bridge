---
name: memo-bridge-operations
description: Observe Memo Labs hosts and projects, and coordinate parallel AI work sessions (workspaces, task claims, checkpoints) through Memo Bridge MCP tools, without depending on the Sentinel X commercial hub.
---

# Memo Bridge

Use `bridge_info` to discover the current capabilities, then `list_hosts` to find which machines respond. Use `host_status` only with the exact IDs `mac` or `vps`. Use `projects_list` to find canonical project names.

## Coordinating work

When you work on a project alongside other sessions:

1. Open your own workspace once: `workspace_open({project, client_type, client_label})`. Reuse its `workspace_id` for the whole conversation.
2. Pick an open task with `tasks_list({project, status: "open"})`, or register one with `task_create`.
3. Claim it before working: `task_claim`. If it returns `lease_held`, someone else is on it; choose another task.
4. Keep the `fencing_token` and pass it to `task_renew`, `task_checkpoint`, `task_complete` and `task_release`. If any returns `stale_lease`, stop writing: your reservation was lost.
5. After pushing, record `task_checkpoint` with the branch and the full commit SHA. Only `durability: "remote"` can be resumed from another machine; report `local_only` to the user.
6. Finish with `task_complete` (or `task_release`) and `workspace_close`.

Leases are cooperative: they do not stop edits made outside Memo Bridge. Always check Git state before sensitive operations.

## Limits

Memo Bridge runs locally on the Mac and uses the configured SSH alias `lab` for the VPS. It has no shell-execution, project-file-write or deployment tools. The Coordinator store is local to the machine running Memo Bridge.

If the VPS is unreachable, report it as offline; do not change SSH, firewall, routing, services, or credentials.
