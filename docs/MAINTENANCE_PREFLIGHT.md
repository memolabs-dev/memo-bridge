# Operator write preflight and controlled maintenance

Issue: memolabs-dev/memo-bridge#222. Intent: avoid preventable permission errors **before** a write is attempted. This does not make the agent an administrator and does not weaken host policy.

## Workflow

Call `operator_preflight {host, path, intent: "edit"}` before editing a machine file whose ownership is not already known. It is a T0 read-only operation. It checks the **host agent's** canonical read/write roots, built-in secret denylist, symlinks, registered default branches and the presence of an approved administrative route.

| Route | Meaning and next step |
| --- | --- |
| `operator_edit` | Ordinary write root. Use workspace + lock, `operator_edit` with dry-run/diff/validator, then apply. OS permissions are still checked at write time. |
| `project_worktree` | Checked-out code on its default branch: claim the Issue, create an isolated worktree, test and PR. |
| `reviewed_root_maintenance` | An **exact, independently reviewed** root-managed file; requires versioned source patch, single-use owner approval, root helper, global lock, rollback and verification. **This status does not authorize any mutation.** |
| `owner_policy_review` | No permitted writing workflow. Stop; only the owner may review host policy or commission a new narrowly scoped operation. |
| `stop` / `invalid_path` | Protected, missing, invalid or unsafe path. Do not work around the refusal. |

`operator_preflight` does not mask a genuine policy prohibition. A returned route does not guarantee the subsequent action will succeed or that a write is approved.

## CDKF backup on the VPS

The known file `/usr/local/bin/lab-backup` is **outside ordinary operator write roots** and must not be exposed by adding the entire `/usr/local/bin` directory to the write allowlist.

Its administrative route requires a separate, audited maintenance transaction. The transaction is not implemented by the preflight itself. It must:
1. Reconcile the source of truth for the backup script in `lab-infra`; review the exact change (`cdkf-db` in `pg_containers()`) and policy governing off-site dumps.
2. Obtain an explicit one-time owner approval and acquire the host-wide operator lock.
3. Deploy a validated patch atomically, preserve the original file and record rollback evidence; never log credentials or dump contents.
4. Check local PostgreSQL dump/roles under restrictive permissions and prove restoration in a disposable container, with counts only.
5. Verify the next scheduled run and only then close CDKF issue #67.

The preflight code's reviewed-root list contains **only** the path above and it is informational. It cannot expand the agent's write roots, mint an approval, or invoke `operator_script` itself.

## Rollout validation

The hub, remote tool registry and VPS operator agent must all run a version that knows `operator_preflight`. Deploy via the established Memo Bridge CI and release path; do not change the live agent directly. Run the operator unit tests, complete suite and smoke the T0 request over the actual client connection before assuming the route is usable in chat.
