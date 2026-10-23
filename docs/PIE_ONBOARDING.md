# PIE onboarding into owner-only Memo Bridge (issue #82)

Status: **prepared, not deployed** (2026-10-16). This document describes an authorized configuration change; it is not an instruction to bypass the remote project policy.

## Why PIE is unavailable to ChatGPT today

- The canonical Mac registry already contains `problem-intelligence-engine | research/problem-intelligence` (project of type `repo`).
- GitHub origin: `memolabs-dev/problem-intelligence-engine`.
- The owner-only remote MCP runtime presently advertises only `memo-bridge`, `cuesheet` and `uni-protocol`.
- A real `workspace_open({project:"problem-intelligence-engine"})` from ChatGPT on 2026-10-16 returned `project_not_allowed`. This is **correct, fail-closed behavior**: the runtime uses the `projects` array in operator-managed `remote.json`, not the entire Mac catalogue.
- The linked GitHub connector returned HTTP 403 `Resource not accessible by integration` when asked to create a branch or issue in PIE. Do not use another identity or direct commits to circumvent the project restriction.

## Authorized scope expansion (in lab-infra, not this repository)

Change `guillaume-flambard/lab-infra:ansible/group_vars/lab.yml` by PR. Preserve every existing entry and append **only** `memolabs-dev/problem-intelligence-engine` to both lists:

```yaml
memo_runner_pilot_repos:
  - memolabs-dev/memo-bridge
  - memolabs-dev/cuesheet
  - memolabs-dev/uni-protocol
  - memolabs-dev/problem-intelligence-engine

memo_bridge_remote_projects:
  - memolabs-dev/memo-bridge
  - memolabs-dev/cuesheet
  - memolabs-dev/uni-protocol
  - memolabs-dev/problem-intelligence-engine
```

(The current values in lab.yml are compact YAML lists; the multiline form above is intentionally semantically equivalent.)

`ansible/roles/memo-bridge/templates/remote.json.j2` renders `projects` from `memo_bridge_remote_projects`. Lab-infra intentionally rejects a remote project outside `memo_runner_pilot_repos`. The hub and VPS runner load the policy at startup from `/etc/memo-bridge/remote.json`; an authorized lab-infra deployment restarts both.

Before enabling writes, separately verify the `memo-labs-automation` GitHub App is installed on this repo with the required minimal permissions, its owner/repo origin is in the shared lease-ledger allowlist, and the VPS pilot checkout is provisioned by the existing lab-infra role. A remote-list entry by itself does not grant those capabilities. Do not widen to all repositories or change OIDC owner, mTLS, session binding, write gate, protected paths, root approvals or the current three pilot entries.

## Controlled rollout and proof

1. Open an issue/branch/PR **in lab-infra**, limited to the two allowlists and any minimal pilot-checkout/ledger configuration that its existing role requires. Run the repository's normal validation/CI; review the Ansible diff before an approved deployment. Avoid directly editing live `remote.json`.
2. Confirm the GitHub App installation and the Git ref lease ledger authorize exactly the PIE repo. If either is missing, fail closed and record the blocker instead of broadening an allowlist.
3. Deploy using lab-infra's established release/Ansible workflow. Confirm that both hub and VPS runner restarted with the *same* policy and that existing pilot projects still work.
4. From a fresh ChatGPT conversation, verify `projects_list(search:"problem")` returns PIE; `workspace_open(project:"problem-intelligence-engine",host:"vps")` succeeds; `tasks_list(project:"problem-intelligence-engine")` is scoped to PIE; and an unrelated non-allowed project remains rejected.
5. On a **new PIE GitHub Issue** labeled `agent:ready` with a priority, test a fully scoped `task_claim`, `worktree_create`, CI-safe test recipe, commit/push and PR. Confirm non-held tasks/foreign worktrees and default-branch writes stay denied. Release the claim and close the workspace. Never close the independent-human-validation P0 issue merely because tooling works.
6. Save the issue, PR, CI run, deployment version and read-only checks as durable evidence. Do not claim success without a green end-to-end result.

## What PIE P0 still requires

See `memolabs-dev/problem-intelligence-engine#3` and `docs/HOLDOUT_ANNOTATION_PROTOCOL.md` in PIE: the sampler/annotation/adjudication tooling exists, but the current frozen 150-pair candidate pool contains only two high-similarity candidates and has **no independently verified human annotations**. Add genuinely new cross-community hard cases without contaminating the frozen holdout; collect two independent human reviews and human adjudication. Do not synthesize human labels or treat similarity as evidence of a true recurring problem.

The PIE adjudication CLI also needs a regression check: `finalizeAdjudication` validates pair IDs and digests but currently does not reject edits to `queue.items[*].left/right` source snapshots before finalization. Fix through a PIE-scoped PR **after** authorized onboarding; preserve the original human benchmark gate.

## Rollback

Use a reviewed lab-infra rollback removing **only** the PIE entry from both lists; deploy to restore the previous exact scope. Keep audit records and release claims through the normal mechanism. Revoking project access is not a substitute for cleaning up a task already held.
