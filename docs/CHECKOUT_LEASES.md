# Optional cross-call checkout leases — design pilot for #263

**Status 2026-10-23: prototype, no production rollout, not a security boundary.**

PR for #263 adds an opt-in checkout lease to the **remote operator path through Memo Bridge hub processes sharing one private durable state directory**. It complements rather than replaces the existing per-call implicit locks. With one ChatGPT session editing a repository, it does not require a task, coordinator workspace or Git worktree. A second session reaching that same repository through the hub is refused. Expiry requires recovery; it never grants ownership. Different repositories remain independent.

## Activate only in a controlled canary

Hub environment: `MEMO_BRIDGE_CHECKOUT_LEASES=enabled`. Unset (the default) means **no change of behavior**, and is the required production setting until the real ChatGPT session metadata has been observed and the separate E2E is approved. This flag requires a **durable, private hub state directory**; startup fails if the hub was launched without one.

Owner rollout prerequisites: confirm that the OAuth remote transport delivers `_meta["openai/session"]` and that the bridge produces distinct 32-character hashes for two different chats, without logging the raw value. If the hint is absent, a mutating operator call to a detected Git checkout returns `session_required`, never silently sharing a principal-scoped lease. First prove this with two disposable clones and a real external ChatGPT session; do not enable the flag blindly.

## Mechanics and invariants

- Before signing a mutating operator call, the hub discovers the real repository root through a **signed read-only `operator_snapshot` on the target host**, using the directory containing the target file or the command's `cwd`. It validates that the resolved directory is inside that Git root. File writes in different subdirectories of the same repository are protected by one lease.
- `checkout_leases.json` persists under the hub's private state directory, atomically via `hub-state.mjs`. An exclusive `.checkout_leases.lock` filesystem marker serializes the full read → decision → save across hub processes using that same directory. A contested lock is refused as `checkout_lease_busy`; a crash marker is deliberately *not* stolen automatically and requires owner review. A corrupt or unreadable document or failed persistence causes a refusal (`checkout_lease_state_unavailable`), not an empty table. A lease lasts 30 minutes and is renewed when the owning session issues a new mutating command.
- A different session gets `locked_by_other_session` until expiry. After expiry every session, including the old owner, gets `checkout_recovery_required` across restart. An in-flight operation or orphan can outlive TTL. This rule applies on both hub and host and cannot be opted out of.
- Ambiguous mutating `git -C`, `--git-dir` or `--work-tree` usage is refused (`checkout_target_ambiguous`) rather than being scoped to a misleading `cwd`. An operation with no known directory gets `checkout_scope_unknown`. Read-only calls remain unaffected.
- A reservation can be acquired even when subsequent approval or host execution fails; unused reservations also require recovery after expiry. This is intentionally conservative.

## Security and correctness limits

This **does not** protect writes made by Claude Code, OpenCode, a terminal or any local stdio agent that bypasses the hub. Nor can a process started inside a checkout be proved unable to write into *another* repository from a script, `node`, `python`, `ssh`, `gh --repo`, nested commands or tools outside Memo Bridge. This needs real OS-level process isolation / a common host-side lease, and explicit cooperation by all writers, not more regex checks. The signed snapshot also costs extra time for each mutating tool call. The guard is not a general Git transaction, nor a default-branch safeguard.

Two hub processes sharing **one private state directory** now coordinate through an exclusive create/unlink marker and a fresh read while holding it; tests exercise both stale caches and contested exclusive access. Hubs using **different directories or hosts** still do not share an authority, and external shell/stdio agents can bypass it. The true Git checkout may change after the snapshot; verification at operation time or a host-side compare-and-swap is the next layer. The in-flight call may outlive lease expiry in extreme timeouts. For those reasons: **do not call #263 complete** based on this pilot.

Do not manually edit or delete the live state file. Stopping the hub does not stop orphaned writers. The prototype has no targeted owner-only recovery API; keep rollout disabled until one can prove quiescence and preserve audited revocation history. Use an isolated checkout when recovery cannot be proved.

## Required validation before production

1. Test two independent real ChatGPT conversations, plus an absent `openai/session` hint, and prove distinct session hashes without exposing raw IDs.
2. Test Mac + VPS signed snapshot, path symlinks, subdirectories, checkout deletion, missing folder, and no-repository commands.
3. Extend the cross-process unit test into a real multi-host canary, and verify a stale in-flight operation crossing a lease expiry. An orphaned lock marker requires an explicit owner recovery procedure and must never be automatically stolen.
4. Integrate local stdio writers with the same host-side authority; prevent bypass via scripts or require an explicitly isolated runner.
5. Add auditable owner recovery and a user-visible lease/status API, with explicit opt-in takeover.
6. Re-run full CI and external Mac canary (#208). Only then evaluate turning on the flag; default remains **off**.

Source of truth and tests: `bridge/checkout-leases.mjs`, `bridge/hub.mjs`, `tests/checkout-leases.test.mjs`. Separate previous diagnostic PR: [#264](https://github.com/memolabs-dev/memo-bridge/pull/264).
## Local-agent integration contract (Claude Code / OpenCode)

This pilot protects only requests routed through the remote hub. Before sharing a canonical checkout with local agents, implement one Mac-side authority for all supervised writers:

1. Identity: bind each remote operation to a verified session hash and each local agent to an identity issued by a trusted OS runner. Caller-supplied environment variables or plain MCP arguments do not prove identity.
2. Location: resolve canonical realpaths and actual Git top-level, including linked worktrees, nested repos, symlinks, case-sensitive volumes and git -C. Separate worktree index ownership from shared Git metadata.
3. Enforcement: route remote operator calls, local stdio write tools, CI runners and jobs through the same broker. Generic terminals and unsandboxed Node/Python child processes can bypass cooperative locks; for guaranteed multiwriter mode isolate writable roots with OS-enforced sandboxing or refuse the operation.
4. Lease: persist ownership, heartbeat and fencing token. Never steal a lease while an existing supervised process could still write. After crash/disconnect flag recovery for an authorized owner. Provide audited status/acquire/renew/release/owner-revoke, without leaking private repository details.
5. Acceptance: drive one remote ChatGPT and two local independent agent principals against a disposable checkout. Prove refusal before mutation, recovery after crash, and concurrency on unrelated repositories. Record an unsupervised shell as a known bypass, never as a passing security test.

The ordinary solo workflow should remain simple. Multiwriter mode must stay explicitly isolated until a common host-side authority and external acceptance tests exist. This is follow-on work for #263, not implemented in this PR.
