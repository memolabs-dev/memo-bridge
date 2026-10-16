# Project Registry v2 — bounded pilot (#67, follow-up #9)

## Contract

The Mac `$MEMOLABS_ROOT/PROJECTS.md` is the authoritative source for project metadata. A VPS may consume a versioned, validated, read-only snapshot with no repository files, absolute paths, credentials, or Vault notes. The local workspace allowlist and GitHub lease/issue allowlist remain separate; importing metadata never grants permission to claim tasks or start jobs. Unknown or stale metadata must be marked, never treated as a live project checkout.

## Acceptance

- [ ] Strict JSON snapshot validation, stable IDs, duplicate detection and bounded payload.
- [ ] All discovered names are for visibility only, with locally absent projects marked unavailable.
- [ ] Host-local projects retain live `available`/path semantics; no forced merge of remote paths.
- [ ] Import cannot widen coordinator/runner permissions.
- [ ] Tests cover offline/missing snapshot, duplicates, invalid inputs, path leakage and parsing of Mac register.
- [ ] Full test suite and build pass, PR opened, no production deployment.
