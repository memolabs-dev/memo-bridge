# Optional cross-call checkout leases — design pilot for #263

**Status 2026-10-23: prototype, no production rollout, not a security boundary.**

PR for #263 adds an opt-in checkout lease to the **remote operator path through one Memo Bridge hub**. It complements rather than replaces the existing per-call implicit locks. With one ChatGPT session editing a repository, it does not require a task, coordinator workspace or Git worktree. A second session reaching that same repository through the hub is refused until its owner lease expires or ownership is explicitly recovered. Different repositories remain independent.

## Activate only in a controlled canary

Hub environment: `MEMO_BRIDGE_CHECKOUT_LEASES=enabled`. Unset (the default) means **no change of behavior**, and is the required production setting until the real ChatGPT session metadata has been observed and the separate E2E is approved. This flag requires a **durable, private hub state directory**; startup fails if the hub was launched without one.

Owner rollout prerequisites: confirm that the OAuth remote transport delivers `_meta["openai/session"]` and that the bridge produces distinct 32-character hashes for two different chats, without logging the raw value. If the hint is absent, a mutating operator call to a detected Git checkout returns `session_required`, never silently sharing a principal-scoped lease. First prove this with two disposable clones and a real external ChatGPT session; do not enable the flag blindly.

## Mechanics and invariants

- Before signing a mutating operator call, the hub discovers the real repository root through a **signed read-only `operator_snapshot` on the target host**, using the directory containing the target file or the command's `cwd`. It validates that the resolved directory is inside that Git root. File writes in different subdirectories of the same repository are protected by one lease.
- `checkout_leases.json` persists under the hub's private state directory, atomically via `hub-state.mjs`. A corrupt or unreadable document or failed persistence causes a refusal (`checkout_lease_state_unavailable`), not an empty table. A lease lasts 30 minutes and is renewed when the owning session issues a new mutating command.
- A different session gets `locked_by_other_session` until expiry. If it takes the expired lease, the previous holder's session hash is permanently *fenced* for that checkout; its next call returns `checkout_lease_revoked`, even after another hub restart. There is no hidden automatic recovery.
- Ambiguous mutating `git -C`, `--git-dir` or `--work-tree` usage is refused (`checkout_target_ambiguous`) rather than being scoped to a misleading `cwd`. An operation with no known directory gets `checkout_scope_unknown`. Read-only calls remain unaffected.
- A reservation can be acquired even when subsequent approval or host execution fails; it expires if unused. This is intentionally conservative. A takeover after expiry is observable through the new session's lease receipt.

## Security and correctness limits

This **does not** protect writes made by Claude Code, OpenCode, a terminal or any local stdio agent that bypasses the hub. Nor can a process started inside a checkout be proved unable to write into *another* repository from a script, `node`, `python`, `ssh`, `gh --repo`, nested commands or tools outside Memo Bridge. This needs real OS-level process isolation / a common host-side lease, and explicit cooperation by all writers, not more regex checks. The signed snapshot also costs extra time for each mutating tool call. The guard is not a general Git transaction, nor a default-branch safeguard.

The lease store's revival across restart does not protect against two simultaneously running **separate hub processes** sharing one state directory: that requires OS-level inter-process locking and its own test. The true Git checkout may change after the snapshot; verification at operation time or a host-side compare-and-swap is the next layer. The in-flight call may outlive lease expiry in extreme timeouts. For those reasons: **do not call #263 complete** based on this pilot.

Do not manually edit or delete the live state file while the hub is running. Emergency recovery requires the owner to stop the hub, preserve and inspect the state file, deliberately reset the affected checkout lease or restore from backup, and restart only after examining other agents' work. The prototype does not yet expose a targeted owner-only reset API; such an API should be added with audited revocation and fencing semantics before rollout.

## Required validation before production

1. Test two independent real ChatGPT conversations, plus an absent `openai/session` hint, and prove distinct session hashes without exposing raw IDs.
2. Test Mac + VPS signed snapshot, path symlinks, subdirectories, checkout deletion, missing folder, and no-repository commands.
3. Test two concurrent host processes and a stale in-flight operation crossing a lease expiry.
4. Integrate local stdio writers with the same host-side authority; prevent bypass via scripts or require an explicitly isolated runner.
5. Add auditable owner recovery and a user-visible lease/status API, with explicit opt-in takeover.
6. Re-run full CI and external Mac canary (#208). Only then evaluate turning on the flag; default remains **off**.

Source of truth and tests: `bridge/checkout-leases.mjs`, `bridge/hub.mjs`, `tests/checkout-leases.test.mjs`. Separate previous diagnostic PR: [#264](https://github.com/memolabs-dev/memo-bridge/pull/264).
