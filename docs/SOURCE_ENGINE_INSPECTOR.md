# Source Engine — landing inspector contract (issue #118)

This module connects a **single, trusted VPS queue** to the previously merged [#115 authority preflight](SOURCE_ENGINE_AUTHORITY.md). It does not make a GitHub write, merge a PR, enable auto-merge, create a route, or install a new database.

## Contract

`createLandingInspector({ serverHost, mode, allowedRepos, queue, readGitHub, checkPolicy, now })` returns `inspectNext({repo,worker})`. Only the authenticated server may inject `serverHost: 'vps'` and `mode: 'trusted_server'`; they **must not** be passed through from a model, client request, query parameter, or untrusted message.

The caller supplies a trusted `queue.claim({repo,worker})` adapter. When [#106](https://github.com/memolabs-dev/memo-bridge/pull/106) is reviewed and the SQLite v9 migration deployed with a single authority, it can wrap `claimLanding(store, {repo,worker})` against that **one VPS database**. All independent Mac/VPS agent connections must route into the same VPS service, not open their own local queue. A claimed lease is checked for scope, then passed to `preflightAfterLandingLease` for authenticated fresh PR/base/check reads and trusted policy verification.

The return object always contains `merge_authorized: false`. On failure, the lease remains held until the authoritative queue's expiry; there is no implicit retry against another host, fallback write, or attempt to mark an unverified PR landed. Operational policy for safely retrying or blocking leases must be implemented in the centralized worker.

## Test evidence and outstanding work

The two-client contention test uses **two independent inspector instances injected with the same in-memory queue adapter**, demonstrating that the API refuses the second concurrent claim and never grants merge authority. It is **not** proof of a live cross-host deployment or cross-process SQLite arbitration; that requires #106 integration and a real hub/VPS service.

Tests also cover remote snapshot mismatch, expired leases, unavailable GitHub, denied policy, invalid client inputs, and queue errors. They can run on main independently from #106.

Remaining production gates:

1. Review/merge #106 after coordinating schema v9 with all running older processes.
2. Wire the trusted hub route to the **single VPS process**; prove Mac/VPS clients use the same SQLite database even through disconnect/reconnect.
3. Adapt the authenticated GitHub reader, repository protection/acceptance policy, and actual protected workflow from [#88](https://github.com/memolabs-dev/memo-bridge/issues/88) / [PR #89](https://github.com/memolabs-dev/memo-bridge/pull/89). Check the current SHA and branch protections again *inside* the GitHub-controlled merge action.
4. Positive and negative test PRs on a non-production target, verifying exactly-once landing, stale-head prevention, lock expiry recovery and safety under worker crash. Record CI evidence and only then consider automated merging.

No production worker is switched on by this change.
