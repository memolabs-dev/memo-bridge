# Coordinator v1: protocol state

Intent: several AI sessions on several machines coordinate on GitHub Issues without overlapping. Memo Bridge serves the canonical Git-ref lease ledger of memolabs-dev/.github; it never reimplements it. Ownership: Vault `1-Projects/memo-labs-os.md`. Contract: `docs/COORDINATOR.md`.

## Requirements and acceptance

| ID | Requirement | Acceptance | Evidence |
|---|---|---|---|
| R1 | One holder per Issue across processes and machines | 8-process race grants exactly one claim | `tests/coordinator-concurrency.test.mjs` |
| R2 | Stale fences, other workers and expired leases are refused | after takeover and after expiry, every write gets `stale_lease`; other workspace gets `unknown_claim` | `tests/coordinator.test.mjs` |
| R3 | Worker identity and principal are derived server-side | worker = `mb.<host>.<workspace>`; no identity in tool schemas | code + tests |
| R4 | Ledger governance gates are surfaced | `issue_not_ready`, `repo_not_allowed`, `issue_changed`, `project_mismatch` | tests |
| R5 | Checkpoints are a fenced write boundary, Git-verified, read-only | ledger verify before insert; remote / local_only / commit_not_found; refs unchanged | tests |
| R6 | Authorization before validation; refusals journaled | reader and stranger refusals counted in journal | tests |
| R7 | Private local store, survives restart | location guard, 0700/0600, restart test, store contract | tests |
| R8 | Ledger outage fails closed without crashing | `ledger_unavailable`; workspace tools still work | tests |
| R9 | Bundled MCP server exposes 17 tools and a full round trip | smoke | `npm run smoke` |
| R10 | CI runs the real ledger offline on Node 22 and 24, failing if it is missing | `MEMO_BRIDGE_REQUIRE_GOVERNANCE=1` | CI run on the PR |

## Open (P1)
- Independent adversarial review of this change.
- CI green on the PR.

## Deferred (P2)
- Add memolabs-dev/memo-bridge and other public repos to the ledger allowlist (memolabs-dev/.github).
- Private repositories in the ledger (needs a private ledger repository).
- Expose read tools, then write tools, on the hub after root runner isolation.
- Event journal retention.
