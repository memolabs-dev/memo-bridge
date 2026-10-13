# Evidence

EV-01 T-01: PR #7 merged (bf600f8). On main: npm test 7/7 PASS, build PASS, smoke PASS (7 tools).
EV-02 AC-01: `tests/coordinator-concurrency.test.mjs` "eight processes race": exactly 1 ok, 7 lease_held, 1 ok event and 7 denied events. PASS. The verifier's race script was replayed at 32 and 48 processes without schema pre-creation, 4 runs: 1 winner each time, all opens ok.
EV-03 AC-02: "ten processes get ten isolated workspaces". 10 distinct ids; renew, release and complete from another workspace return stale_lease. PASS.
EV-04 AC-03: "after takeover": old token refused on renew, release, complete and checkpoint; the new token is refused from the old workspace; denied events are journaled. PASS.
EV-05 AC-04: "expired lease cannot write". The same workspace's old token is still refused after a re-claim; a mutation dropping the generation check is now killed. PASS.
EV-06 AC-05: "state survives a restart". Close and reopen; the generation goes to 2; a completed task stays task_closed. PASS.
EV-07 AC-06: missing capability (including on malformed arguments) and foreign workspace both return forbidden and are journaled; events are scoped to the caller's principal without the audit capability. PASS.
EV-08 AC-07: 23 invalid-input cases rejected, including newline, bidi override, trailing-dash owner, HEAD and refs/ branches; project_mismatch is enforced. PASS.
EV-09 AC-08: temporary git repository with a bare origin. Pushed commit gives remote, unpushed gives local_only, missing SHA gives commit_not_found, an uppercase SHA is accepted. HEAD, status and for-each-ref are unchanged afterwards. PASS.
EV-10 AC-09: synced paths (case-insensitive, CloudStorage), relative path, .git, bare repository, symlink into a repository and a shared 0755 directory are refused. The store is 0700/0600. PASS.
EV-11 AC-10: `npm run smoke` on the bundled build: 20 tools, full round trip, lease_held seen by a second workspace, schema bounds enforced at the MCP boundary. PASS.
EV-12 AC-11: store contract tests: round trip, compare-and-set, rollback with no partial write, in-process serialization, readers not blocked by a writer, WAL/busy_timeout/foreign_keys/schema version. PASS on Node 24.21. Node 22 is covered by the CI matrix.
EV-13 AC-12: COORDINATOR.md, SECURITY.md, README, plugin.json, package.json and the skill were updated after the verifier's findings (inspection).
EV-14 AC-13: runtime check of the bundled server against the real ~/projects/PROJECTS.md with a temporary state dir. Principal local:memo, claim ok, checkpoint of origin/main bf600f8 gives durability remote, unknown project gives unknown_project. PASS.
EV-15 Mutation testing: removing the lease_held check fails AC-01 and AC-03; removing the generation check fails AC-04; BEGIN DEFERRED for writes fails AC-01.
EV-16 Independent verifier: 9 findings (2 medium, 1 low-medium, 6 low). All fixed with regression tests (28 tests total). No fencing defect was found.
EV-17 AC-14: see the PR CI run (recorded in 09-closure.md).
