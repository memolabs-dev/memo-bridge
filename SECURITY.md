# Security policy

Memo Bridge is a local proof of concept. It is not designed for exposure to the public internet.
- No arbitrary command execution, project file writes, or admin operations.
- Project metadata is read only from the local canonical register; project IDs and resolved paths are validated.
- The local stdio plugin assumes a trusted OS user. These tools must not be exposed remotely until strong user authentication, per-tool authorization and audit logs are implemented.
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.

## Coordinator write exception (v0.2)

The Coordinator (`docs/COORDINATOR.md`) is the only component that writes. This exception was approved by the owner on 2026-10-13.
- **Where it writes:** only to its private SQLite store, a 0700 directory and a 0600 file. The store never sits in a repository or in iCloud.
- **Git access:** it verifies checkpoints with fixed, read-only `git` invocations through `execFile`, with no shell, no fetch and no push. It never writes project files.
- **Identity:** the principal is derived by the server (`local:<OS user>` over stdio) and never comes from tool arguments. Each operation requires a capability, and a workspace can only be used by its principal.
- **Audit:** every write and every refusal is appended to an audit journal. The journal holds identifiers, operation names and result codes, never tool payloads or secrets.
- **Remote exposure:** none in this version. Exposing these tools through the hub requires the OIDC validation of PR #6 and a capability mapping per scope.
