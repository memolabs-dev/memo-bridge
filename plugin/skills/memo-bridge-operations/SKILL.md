---
name: memo-bridge-operations
description: Observe Memo Labs hosts and projects, and coordinate parallel AI work sessions on GitHub Issues (workspaces, Issue claims, checkpoints) through Memo Bridge MCP tools.
---

# Memo Bridge

Use `bridge_info` to discover the current capabilities, then `list_hosts` to find which machines respond. Use `host_status` only with the exact IDs `mac` or `vps`. Use `projects_list` to find canonical project names.

## Coordinating work

Work items are GitHub Issues. A reservation is shared by every machine and every AI client.

1. Open your own workspace once, with `workspace_open({project, client_type, client_label})`. Reuse its `workspace_id` for the whole conversation.
2. Pick an open Issue of that project labelled `agent:ready` with one priority label. Check `issue_status({issue})` first.
3. Claim it with `issue_claim({workspace_id, issue})` before working.
   - `lease_held`: someone else is on it. Choose another Issue.
   - `issue_not_ready`: tell the user what is missing.
4. Keep `claim_id` and the **latest** `fence`. Renew with `issue_heartbeat` before `expires_at`. Every heartbeat returns a new fence.
5. Work on your own branch. After pushing, record `issue_checkpoint` with the branch and the full commit SHA. Only `durability: "remote"` can be resumed from another machine, so report `local_only` to the user.
6. Finish with `issue_release({..., outcome})`, then `workspace_close`.

If any call returns `stale_lease` or `issue_changed`, stop writing at once: your reservation is gone, or the Issue changed under you.

Leases are cooperative: they do not stop edits made outside Memo Bridge. Never merge. Pull requests land through the Memo Labs landing contract when CI is green.

## Limits

- Memo Bridge runs locally on the Mac and reaches the VPS through the SSH alias `lab`.
- It has no shell-execution, project-file-write, merge or deployment tools.
- Only the public repositories on the ledger allowlist can be claimed today.

If the VPS is unreachable, report it as offline. Do not change SSH, firewall, routing, services or credentials.
