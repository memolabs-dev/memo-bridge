# Security policy

Memo Bridge is a local, read-only proof of concept. It is not designed for exposure to the public internet.
- No arbitrary command execution, file writes, or admin operations.
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.
