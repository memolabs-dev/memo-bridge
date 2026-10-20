# Worktree lifecycle policy (phase 1)

Memo Bridge separates **projects**, **tasks**, **workspaces** and Git **worktrees**. Existing reaper rules already check a merged PR matching HEAD, leases, activity, processes, locks, dirty edits and grace period; this phase adds an explicit **opt-in lifecycle classification** for the maintenance CLI. Unknown worktrees are **kept**, never interpreted as temporary because they are old. No host changes happen without `--apply`.

Save a policy JSON file outside a checkout (e.g. in Memo Labs workspace data, with access controlled by the operator):

```json
{"version":1,"entries":[
  {"project":"memolabs-dev/memo-bridge","branch":"agent/226-example","mode":"ephemeral"},
  {"project":"memolabs-dev/memo-bridge","branch":"main","mode":"persistent"},
  {"project":"memolabs-dev/memo-bridge","branch":"shared/docs","mode":"shared"}
]}
```

Note: policy `project` uses the GitHub origin slug, not the local catalog alias. A branch explicitly classified `ephemeral` is **not** deleted on classification alone: all existing safety checks must still pass. `persistent` and `shared` always stay. Absent/invalid/ambiguous policy entries stay. A wildcard (`branch":"*"`) can be used, but prefer exact branches and review wildcards carefully.

```sh
node scripts/reap-worktrees.mjs --policy-file /absolute/path/to/worktrees.json
# Only after inspecting the report and confirming intent:
node scripts/reap-worktrees.mjs --policy-file /absolute/path/to/worktrees.json --apply
```

The CLI now fails closed without a matching policy. The lower-level `reapRepository` API retains legacy behavior when no `policy` argument is supplied, to preserve compatibility for existing consumers; always supply policy in new automated callers. The policy is not yet a durable server-side workspace manager or scheduler. The inventory/agent-independent workspace API, periodic status and explicit cleanup approvals are future work, and should not be claimed deployed.
