# GitHub Issue prerequisites for agent tasks (#266)

This is a **versioned, fail-closed** prerequsite gate for the existing Memo Bridge coordinator. GitHub Issues remain the task source and the existing shared lease ledger remains the only claim authority. No second scheduler or task database.

## Structured declaration

In an Issue body, add exactly one versioned comment:

```markdown
<!-- memo-bridge:requires:v1 {"requires":["memolabs-dev/memo-bridge#263","memolabs-dev/memo-bridge#238"]} -->
```

The references must be full `owner/repository#number` keys. A missing comment means no declared prerequisites. Malformed/duplicate comments or references are rejected, rather than treated as an empty list. Plain prose such as "blocked by #123" is not interpreted as machine authority.

## Safety and authority

- `inspectDependencies` walks a bounded graph (20 direct edges, 64 nodes), checks source scopes, rejects missing/private, stale (>5 minutes), malformed, self-referential and cyclic records.
- All prerequisite Issues must be **closed AND independently verified accepted**. Issue bodies, GitHub labels, a green CI check and PR merge do not themselves constitute acceptance.
- The verifier is a trusted callback supplied by the server (`dependencyAcceptance`) and must return `{ verified:true, passed:true, evidence_ref:"..." }` only for validated external evidence. **No such default verifier is installed by this PR**. When one is absent, tasks with prerequisites remain blocked.
- Setting `MEMO_BRIDGE_TASK_DEPENDENCIES=enabled` enables the server-side claim gate. It is **off by default** until the verified receipt provider and rollout checks are approved. `task_claim` is checked both before and after acquiring the ledger lease; if the latter fails, Bridge attempts to release the claim and refuses it. The check also protects claims initiated by `task_next`, which uses the same path.
- Github `issue` reads are restricted to registered, allowed repositories; read or verifier outages **fail closed**. An inaccessible repository's content is not returned.
- The planning layer is advisory, not a permission boundary. Deployments, merges and issue closure remain governed by their existing independent gates.

## Residual race and rollout

The two reads around a claim reduce the race window but are **not an atomic transaction across GitHub and the lease ledger**. If dependencies change after the second read, the task still needs a validation gate at the next write/execution boundary before being treated as ready. Treat rollout as blocked until this is proven in a disposable end-to-end environment with two agents, repository permissions, fresh acceptance receipts and rollback tests.

Do not enable the flag across production agents, or close #266 as fully accepted, solely because CI is green.

## Validation

```sh
node --test tests/task-dependencies.test.mjs tests/task-dependency-claim.test.mjs
pnpm test
```

## Private signed acceptance receipts

The runtime now wires an **independent signer-backed verifier** through `server/task-acceptance-receipts.mjs`, using its existing private `stateDir`. This does not generate secrets or attest any work automatically.

- `<stateDir>/dependency-acceptance.key`: exactly 32 random bytes, regular **0600** owner file (never commit, transmit or log this key).
- `<stateDir>/dependency-acceptance/`: owner-only **0700** directory.
- `<stateDir>/dependency-acceptance/<sha256(normalized_issue_ref)>.json`: **0600** JSON containing `sealAcceptanceReceipt(payload, secret)` issued by an independent authorized verifier **after** review of the referenced PR, deployment/policy and actual E2E evidence. No API or issue comment is allowed to issue a receipt.
- The cryptographic signature binds the full Issue reference, `updated_at`, `closed_at`, SHA-256 of Issue body, independent verifier and producer IDs, verified-at time, PR reference, E2E reference and either a deployment receipt or a verified no-deployment policy reference.
- The gate checks the HMAC, exact issue revision, 30-day evidence age, private file mode and independent verifier identity. A missing, unreadable, forged, stale, edited, symlinked or over-permissive attestation refuses execution.
- Real proof must come from separately authenticated/verifiable product checks. The HMAC only guarantees *who attested*, not that a reference is truthful. An independent verification workflow is essential. This PR does not autonomously mint attestations from PR merges or CI success.

Additional server-side guards refuse `task_renew`, `task_checkpoint`, and `task_complete` when dependencies are later revoked, while allowing `task_release(outcome=cancelled)` for safe cleanup.

## Two-agent trial

`node --test tests/task-dependency-agents-e2e.test.mjs` runs two separate Node worker processes against a disposable fake-GitHub backend and the real Git-ref claim path: without an acceptance receipt both refuse the task; with a correctly signed receipt exactly one is allowed to claim. The test never modifies real Issues or production hosts.

**Still required before real rollout:** run the same flow with two real external sessions over the deployed connector; prove independently generated receipts based on a genuine new-user E2E, host-wide checkout isolation (#263), and a recovery/rollback procedure. No claim of production readiness or automatic closure from simulated checks.
