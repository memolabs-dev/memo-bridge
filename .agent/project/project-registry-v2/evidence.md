# Project Registry v2 — evidence (#67, follow-up #9)

2026-10-16 (Paris), isolated VPS worktree agent/67-project-registry-v2, base 67da39af.

## Implementation
- Metadata-only, versioned Mac PROJECTS.md snapshot. Strict allowlist of fields, 256 KiB input limit, 500 project max, duplicate rejection, timestamp/staleness and safe no-path projection.
- Local catalog remains authoritative for repository/worktree resolution. Only projects_list imports snapshot; unknown projects remain unavailable to the Coordinator.
- Opt-in exposure to the authenticated OIDC owner with MEMO_BRIDGE_CATALOG_DISCOVERY=enabled, filtered as before for other remote principals. Snapshot path configured by the operator only.
- Atomic 0600 exporter; manual authenticated transfer described in docs/CATALOG.md. No production deployment or scheduled transfer in this increment.

## Tests
- VPS job job__xrYvndXghjdzwOm: first pass failed in the newly introduced test fixture syntax; corrected.
- VPS job job_VMI-6Dvcgizo6H86: second pass failed on a test-only search expectation (product-4 matches product-40..49); assertion corrected to product-67.
- VPS job job_psWJ-cVGGSxnuUqv: **succeeded, exit 0**, 608 tests, 575 pass, 33 skipped, 0 fail, npm test, full suite.
- VPS job job_t5cEct6r-uOvc3RW: **succeeded, exit 0**, npm run build, esbuild output produced.
- No production flags changed, no permissions widened, no forced merges.

## Follow-up
Operator-approved transfer and periodic sync Mac → VPS (including backups/observability) in separate change. Clarify aliases uni vs uni-protocol and owner acceptance before deployment.
