# Risks
R-01 node:sqlite is RC (1.2) not stable. L:low I:med. Mitigation: isolated in store.mjs, contract tests. OPEN(low)
R-02 Locks are cooperative; edits outside Bridge not prevented. Mitigation: git verification at checkpoint; documented. ACCEPTED(med, by design)
R-03 Multi-process writers on one SQLite file. Mitigation: WAL + BEGIN IMMEDIATE + busy timeout; multi-process test AC-01/02. OPEN until AC-01 passes
R-04 Clock skew: expiry uses local wall clock; single host only. Low. Documented.
R-05 Write tools reachable by any local process that can spawn the plugin (trusted OS user model). Accepted per SECURITY.md; hub requires OIDC.
R-06 State dir default under ~/Library may be backed up by Time Machine (fine), not iCloud. Low.
