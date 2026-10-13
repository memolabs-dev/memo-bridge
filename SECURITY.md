# Security policy

Memo Bridge is a local proof of concept. It is not designed for exposure to the public internet.
- No arbitrary command execution, project file writes, merges, or admin operations.
- Project metadata is read only from the local canonical register; project IDs and resolved paths are validated.
- The local stdio plugin assumes a trusted OS user. These tools must not be exposed remotely until strong user authentication, per-tool authorization and audit logs are implemented.
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.

## Coordinator writes (v0.3)

The Coordinator (`docs/COORDINATOR.md`) is the only component that writes. The owner approved this on 2026-10-13. It writes in exactly two places:

- **Its private SQLite store.** A 0700 directory and a 0600 file. Opening is refused for relative paths, Git repositories (bare ones included), iCloud (`Mobile Documents`), `~/Library/CloudStorage`, and any existing directory readable by others. A folder that a third-party tool syncs silently cannot be detected, so do not point `MEMO_BRIDGE_STATE_DIR` there.
- **Lease refs in `memolabs-dev/.github`** (`refs/heads/star-lease-v1/*`). They are written only by running the canonical `scripts/issue_lease.py`, with fixed arguments and no shell, under the operator's `gh` login.
  - The ledger stores no Issue titles or bodies, only a digest.
  - It never closes Issues and never deploys.

Further rules:
- **Identity.** The principal is derived by the server (`local:<OS user>` over stdio), and the ledger worker is derived from the workspace. Neither ever comes from tool arguments. Every operation requires a capability. Authorization runs before validation, so every refusal is journaled.
- **Checkpoints.** They use fixed, read-only `git` invocations: no fetch, no push.
- **Audit journal.** It holds identifiers, operation names and result codes, never tool payloads or secrets.
- **No remote exposure.** These tools are not on the hub. Exposing them requires the OIDC validation of `bridge/oidc.mjs`, a capability mapping per scope, and isolation of the root CI runners on the VPS.
