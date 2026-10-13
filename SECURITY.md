# Security policy

Memo Bridge is a local, read-only proof of concept. It is not designed for exposure to the public internet.
- No arbitrary command execution, file writes, or admin operations.
- Project metadata is read only from the local canonical register; project IDs and resolved paths are validated.
- The local stdio plugin assumes a trusted OS user. These tools must not be exposed remotely until strong user authentication, per-tool authorization and audit logs are implemented.
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.
