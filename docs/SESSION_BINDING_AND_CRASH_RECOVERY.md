# Memo Bridge #263 — Signed session binding and crash-safe lease gate
23 October 2026. **Experimental, OFF by default, no production rollout.**

## Problem and corrections

Previously an Ed25519 operator signature bound the principal, host, request ID, arguments, tier and approval, but NOT the remote conversation hash. A different client_session value arriving in unsigned request metadata could be paired with the same signed command. In addition, a lease that expired after a supervisor crash could be automatically claimed despite surviving child processes.

This change implements:
- Signature version 2: domain-separated `memo-bridge-operator-v2`, signed `client_session` (32 lowercase hex characters), existing signed fields unchanged. The verifier checks the actual wire metadata value against the signed session. Swaps, omissions and tampering fail with `session_mismatch` or `signature_invalid`.
- Backward compatibility: v1 signatures are still accepted for **other operations**. A Mac agent with `MEMO_OPERATOR_CHECKOUT_AUTHORITY=enabled` now refuses all tier >0 calls whose signature is unbound (`session_unbound`) before reaching any mutating tool.
- Hub opt-in `MEMO_BRIDGE_OPERATOR_SESSION_BINDING=enabled`: signs Mac T1/T2 operator requests with the wire session hash. Without a valid session hint, v1 may be signed but the protected Mac agent will refuse it. Root-helper T3 remains v1 and will be **refused in protected Mac mode** pending a compatible root-helper protocol update.
- The Mac-side lease uses `requireExplicitRecovery: true`. An expired lease without a successful owner-session release is `checkout_recovery_required`; this applies even to a purported continuation of the same session. A real clean release records a fenced tombstone, allowing another session to take over without deleting audit history.

## Safe rollout order (do not execute automatically)

1. Review/update remote hub and Mac agent together without enabling either flag. Maintain a rollback package and a known-good way to reach the Mac.
2. Check that two **independent authenticated ChatGPT conversations** supply different, stable session hashes through the real OAuth → hub → agent path; avoid logging raw hashes.
3. Enable session binding **on the hub first** only in a disposable canary, without the Mac checkout authority; ensure root helper, T0 operations and old clients behave as expected.
4. Enable the Mac authority only on a controlled test operator with a private state directory **identical** to the supervisor's state directory, then test negative cases on a disposable checkout. Protected Mac T3/root calls are intentionally nonfunctional until separately supported.
5. Verify isolated local Claude Code and OpenCode processes, including real subprocesses that deliberately attempt to modify a different checkout, and explicit crash recovery. Keep installed production flags OFF until signoff.

## Crash recovery: current deliberate stop

If a supervised agent crashes or stops heartbeating before safely releasing the checkout, **do not delete or reset `checkout_leases.json` automatically**. The local Mac authority returns `checkout_recovery_required`. No owner-only audited recovery API is implemented in this change.

Owner must inspect both the process tree and its descendants, worktree/index/branch state, persistent event/audit history and possible background jobs. Stop or isolate all remaining writers before a documented, audited recovery flow can be developed. Until that flow exists, use a **different isolated checkout** rather than attempting a forced takeover of the affected one. The checksum/state document must never be modified by an untrusted agent.

This is fail-closed behavior, not a proof that an arbitrary shell cannot write to disk. Cooperative wrappers cannot police standalone Claude/OpenCode invocations or children that escape their process group.

## Evidence and remaining blockers

Tests cover v1 compatibility, v2 valid signature, metadata swap, missing metadata, tampering, nonce replay, refusal of an expired un-released lease, clean handoff, interprocess lock store, and Mac signed-operator simulation. **This is not two real ChatGPT browser sessions.**

Release blockers: cryptographic v2 real deployment compatibility, authenticated owner recovery, OS-enforced write containment for arbitrary subprocesses, two real OAuth conversations, failover of independent hubs/stores, and external Mac/VPS E2E with rollback. See [#263](https://github.com/memolabs-dev/memo-bridge/issues/263).

**Default unchanged. No production rollout, no merge and no privileges changed.**

## Experimental macOS write sandbox for supervised agents

A new optional `--sandbox-strict` argument to `scripts/with-checkout-lease.mjs` starts the supervised tool through Apple's `/usr/bin/sandbox-exec` with a read/write policy that **denies filesystem writes globally** except the authorized physical Git checkout, a private per-session temporary directory, and required device nodes. It explicitly denies writes to the private checkout-lease state directory. The policy is passed through `-D` path parameters, not injected from model-controlled source.

Mac integration tests exercise a real Node subprocess that attempts to modify a different repository and a symlink from the authorized repository to the other repository. Both writes are denied, while a write inside the chosen Git checkout succeeds. This is real **filesystem write containment** for the tested process and its descendants, not just a cooperative lease check.

Example pilot only (configured state directory must match the installed Mac operator):
```sh
node scripts/with-checkout-lease.mjs --repo /absolute/disposable/checkout \
  --state-dir /absolute/private/memo-operator-state --sandbox-strict -- node --version
```

**Not a production Claude Code/OpenCode profile:** authentication and plugin caches may require writes outside the checkout, which the strict profile intentionally denies. The profile currently permits reads and outbound network, so it **does not protect secrets against exfiltration**. A descendant that deliberately creates a different process group may keep writing **inside its originally authorized checkout** after its supervisor exits; the Seatbelt read/write rules do not fence its file descriptors or revoke its operating-system write permissions. Therefore, concurrent untrusted agents must still use **distinct isolated clones/worktrees**, each with its own sandboxed writable root. Never claim the shared canonical checkout is safe for unsupervised multiwriter workloads.

Both `--sandbox-strict` and session-signing feature flags are off unless explicitly selected; the rollout was not performed.
