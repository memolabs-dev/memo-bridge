# Evidence (2026-10-27, host mac)

EV-01: 93528c8 full suite: 1216 pass, 3 skip, 0 fail; build passes; 124 deployment tests pass.
EV-02: stdio MCP smoke passes (74 tools, fixture round-trip and multiple hosts).
EV-03: 1184eae focused tests: 41 pass, 0 fail. Regression fixes cover transient origin
failure, unavailable enrolled checkout, abandoned/fresh lock, hostile GitHub origin names,
and removing obsolete Mac snapshot entries from a live response.
EV-04: Independent standards/security review of 1184eae: no remaining blocking source finding;
16 focused tests passed. No live policy touched.
EV-05: Independent spec review of 6aa9abe: 33 focused tests passed; all three reproduced source
blockers resolved, including an unrelated unavailable registry entry blocking valid additions.
EV-06: c6681b7 stable local full suite: 1221 pass, 3 skip, 0 fail (1224 tests).
An earlier run overlapped a commit and failed the installer idempotency test because VERSION
changed between its two installs; re-running on a stable revision passed. No test disabled.
GitHub CI is external live evidence: https://github.com/memolabs-dev/memo-bridge/pull/313/checks.
The issue remains open pending production acceptance.

Production installation, actual rollback rehearsal, inventory parity, new-conversation and
negative live smoke remain BLOCKED: operator_preflight path_secret; recorded
blocked_observer ffea47bd-d9b2-413d-8a86-9acbd09acef8. No alternate privileged path used.

Implemented behavior: --all-owner-projects stages the explicit global owner opt-in; the
installed Mac agent reconciles every 5 minutes without blocking runtime startup. Only
verified, registered, available owner checkouts enroll. Existing grants remain unchanged on
inconclusive checks. Writes/session controls are preserved. An online Mac replaces stale
snapshot rows for discovery; an unavailable/refusing Mac retains the offline snapshot.

Rollout prerequisite: an authorized administrator must install the reviewed commit with
--all-owner-projects, keep the preceding runtime plist/release and both policy files for
rollback, and deploy the reviewed hub revision through lab-infra. This is a prerequisite,
not an executed instruction or proof. The protected paths have not been accessed for writes.
