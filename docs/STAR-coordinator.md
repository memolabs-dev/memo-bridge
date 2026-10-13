# STAR: Coordinator core (2026-10-13)

**Situation.** `main` had read-only host probes and, after PR #7 was merged with the owner's approval, the canonical project catalogue. It had no persistence, tasks, leases or audit. PR #5 and #6 (hub, OIDC) are open and were left untouched. Cuesheet deliberately has no leases, and infrastructure-guardian uses JSON with flock and no fencing. Nothing existing could be reused for leases.

**Task.** Issue #8 asks for a durable, single-machine Coordinator inside Memo Bridge: workspaces, task leases with fencing tokens, checkpoints and an audit journal, exposed as MCP tools. Its acceptance criteria are listed in `.agent/project/03-acceptance.md`.

**Action.**
- `server/coordinator/` contains:
  - `store.mjs`: the engine-isolated contract, on `node:sqlite` with WAL and `BEGIN IMMEDIATE`, in a private location.
  - `leases.mjs`
  - `policy.mjs`
  - `checkpoints.mjs`: read-only Git verification.
  - `index.mjs`
- `server/tools/coordinator-tools.mjs` is the shared registry, ready for the hub.
- Tests added:
  - multi-process claim race
  - workspace isolation
  - fencing after takeover and after expiry
  - restart
  - authorization and audit
  - input validation
  - Git checkpoints
  - store contract
  - location guard
  - extended MCP smoke

**Result.** The evidence is in `.agent/project/07-evidence.md`.

**Next.**
- Merge #5/#6 after a security review, registering `registerCoordinatorTools` in the hub with an OIDC principal.
- Then reconcile issue #9.
- A Postgres adapter is planned for when the hub owns the store.
