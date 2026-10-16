# Source Engine — single-authority landing preflight (issue #86)

This is a **non-executing** preparatory slice. The existing Memo Source Engine #106 stores queue metadata in Coordinator SQLite v9, **but that SQLite file is not shared between Mac and VPS**. Treating the two local queues as global would risk duplicate workers. This patch provides a host-routing and fresh-read boundary before attaching a landing worker. It does not create a live cross-host service or merge any PR.

## Explicit decisions

1. **The VPS is the sole landing authority**, while the Mac remains an agent/development host. Only a trusted server runtime with server-observed `host: 'vps'` may run the preflight. A tool caller must not set or impersonate that host or the trusted-server mode.
2. **Fail closed on VPS unavailability.** `selectLandingAuthority` returns `authority_unavailable` and must never pick the Mac as a fallback. Requests from any machine are to be routed to this VPS authority by the authenticated hub. Never send tokens or arbitrary shell commands through this route.
3. **One SQLite database**: once #106 is reviewed and installed, the single VPS landing authority must use its Coordinator SQLite database and `BEGIN IMMEDIATE` transactions for local FIFO leases. Multiple server workers on the same VPS can serialize through that database. Running a standalone landing writer on the Mac is forbidden.
4. **Fresh evidence after a lease**, not trust in recorded observations. `preflightAfterLandingLease` requires an active lease with a fence, and it re-fetches PR/target/checks through an authenticated server-side `readGitHub` callback. It rejects a changed PR head, base SHA, base branch, check-run head SHA, repo or PR number. The server injects a trusted `checkPolicy` callback to enforce accepted reviewers, required checks and repository policy.
5. The preflight result explicitly contains `merge_authorized: false`. A separate repository-controlled GitHub landing workflow (#88 / PR #89) must enforce checks and authorization again *at merge time*. This layer neither modifies GitHub nor enables auto-merge.

## What this patch actually adds

- `server/source-engine/landing-authority.mjs`: target-host guard and a read-only, fenced preflight contract.
- `tests/source-landing-authority.test.mjs`: tests for Mac rejection, no fallback, stale SHA, policy rejection, GitHub outage, and a lease that expires during remote I/O.
- No new MCP mutation tool, no token scope change, no workflow file, no deployment and no schema version change.

## Production gates (still outstanding)

- Review and merge [PR #106](https://github.com/memolabs-dev/memo-bridge/pull/106); coordinate its additive SQLite v9 migration with currently running v8 processes. Do not deploy new schema while an older process must continue accessing it.
- Implement a **server-observed**, authenticated hub route to the VPS singleton and prove that a disconnected VPS never triggers Mac-local landing.
- Integrate `preflightAfterLandingLease` with the #106 queue functions and the approved #88 policy, with a test showing two independently connected clients contend for **one** repo lease.
- The [#88 workflow proposal](https://github.com/memolabs-dev/memo-bridge/pull/89) is not yet installed. A maintainer must review/install the protected workflow and configure required checks, authorized acceptance labels, review protection and GitHub auto-merge. Do not bypass `.github/workflows` protections.
- Positive and negative canaries on real test PRs (green/approved, draft, stale SHA, missing checks, untrusted author, hold label); no automatic production deployment.

**No automatic merge is authorized by this code.** It is intentionally small and separately reviewable while #106 and #88 remain draft.
