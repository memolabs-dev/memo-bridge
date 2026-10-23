# Mac shared checkout authority — pilot for Memo Bridge #263

**2026-10-23. Experimental, opt-in, not deployed. No production safety claim.**

## Purpose

Two AI agents writing the same Git checkout must not silently exchange active branches, staging indexes or edited files. The remote Memo Bridge hub already has an optional per-session lease, but the owner also runs Claude Code and OpenCode directly on the Mac. Their local calls never pass through the VPS hub.

This pilot introduces a **single cooperative lease store on the Mac**, shared by two clients:

- The signed Mac operator agent: after verifying the hub's signature, policy, approval and schema, the agent optionally checks a checkout lease **before** calling a mutating tool. It uses the transport's session hash, not an argument chosen by the model.
- A local process supervisor: `scripts/with-checkout-lease.mjs` holds the same lease for the lifetime of a command such as `claude` or `opencode`, renews it every 15 s and tries to stop the supervised process if the lease cannot be renewed.

Both use the *same* private state directory and `checkout_leases.json` (shared with `bridge/checkout-leases.mjs`) plus the atomic `.checkout_leases.lock` transaction marker. The checkout is the canonical Git top-level, not the caller's string pathname: nested directories, symlinks and distinct worktree roots are resolved to their actual path. Moving/copying across two different Git repositories is refused until an atomic multi-checkout operation exists.

## Explicit opt-in (do **not** enable during initial review)

On the Mac operator service, only after a real user/session compatibility test:

`MEMO_OPERATOR_CHECKOUT_AUTHORITY=enabled`

This must use the private directory already used by `MEMO_OPERATOR_STATE` (or the validated policy `state_dir`). The default is **off**. On the VPS the existing `MEMO_BRIDGE_CHECKOUT_LEASES=enabled` remains a separate, optional hub-side control. An active Mac control may refuse a request after the hub already granted its own lease; that is a safe refusal, but the remote reservation can then remain until expiry.

A supervised local agent is launched in a new session with an explicit absolute checkout and matching state directory, e.g.:

```sh
node scripts/with-checkout-lease.mjs \
  --repo "$HOME/memolabs/os/core/bridge" \
  --state-dir "$HOME/.memo-operator/state" \
  -- claude

node scripts/with-checkout-lease.mjs \
  --repo "$HOME/memolabs/os/core/bridge" \
  --state-dir "$HOME/.memo-operator/state" \
  -- opencode
```

**The example state directory is illustrative.** Never guess or create a second directory; use exactly the configured `MEMO_OPERATOR_STATE` of the installed Mac operator. Launch these from a checkout containing the branch the owner chose. Never modify the existing launchd service or enable the flag merely because CI passes.

## Behavior and negative cases

- A local supervisor owns checkout A; a different local supervisor targeting A refuses to run its child at all. An operator write from remote session B to A returns `locked_by_other_session` **before** the underlying tool is invoked. Repo B remains independent.
- An existing file symlinked across checkout boundaries is resolved to the physical target; for new files the parent is resolved. Ambiguous `git -C`/external Git roots and arbitrary scripts without a defensible scope are refused by the pilot.
- A supervisor heartbeat renews the lease. Normal exit writes a tombstone that fences its previous session, then another writer can acquire the checkout. A crash leaves the lease until expiry; after takeover the previous identity remains fenced.
- A missing/invalid remote session hash refuses protected Git writes rather than treating all owner conversations as one principal. Read-only commands can proceed.
- A corrupted lock state, failed save or orphaned transaction marker fails closed. No automatic stealing or silent resetting of unknown work.

## Remaining security boundaries (release blockers)

This is **cooperative protection**, not an operating-system security boundary. Claude Code or OpenCode run as the same macOS user, can launch unsupervised tools, reach other directories, or bypass the wrapper entirely. The wrapper does not isolate their filesystem permissions. A generic Node/Python/shell child can modify another checkout even when its starting `cwd` is protected. Enforced multiwriter isolation requires separate authorized worktrees or OS-level sandbox rules, plus a common host-side mediation layer for *all* writers.

A session hash in protocol metadata is not bound into the signed Ed25519 argument digest. Only the authenticated operator transport supplies this metadata, but the identity binding should be strengthened in the signing contract before production. The same-UID wrapper identity is randomly minted but not OS-cryptographically protected against another process owned by the user. Unrelated local agents that do not use the wrapper remain a known bypass.

Remote uploads that complete without a path are currently **refused** under the pilot, even outside Git; mixed-repository moves are refused. Background child jobs, TTL expiry with a still-running child, forced termination, forked subprocesses and crash recovery need further validation. The pilot does not implement owner-only targeted recovery or status commands and must not change installed service settings. The code in PR #265 (hub leases) and this PR (Mac authority) is not production-ready.

## Evidence and acceptance gates

- Automated temp-repository tests in `tests/mac-checkout-authority.test.mjs` verify real Git roots, symlinks, signed agent validation, local-vs-remote denial, independent process contention and zero index/file mutation by a refused writer.
- Separate two-process tests on the existing hub lease suite verify durable transaction serialization.
- **Still required:** one real remote ChatGPT session and one independently opened ChatGPT session with observed distinct hashes; concurrent live Claude Code/OpenCode invocations against a disposable clone; no files/index/branch changed for a refused writer; external code-writing sandbox tests; owner-visible recovery and rollback. Until then, both opt-in flags remain OFF.

The goal is to keep the single-agent path simple while never claiming that these cooperative locks can police an arbitrary shell or an unsupervised agent.
