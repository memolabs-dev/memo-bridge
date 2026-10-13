# Acceptance

AC-01 REQ-003 8 processes claim same task concurrently -> exactly 1 ok, 7 lease_held. automated
AC-02 REQ-006 10 processes open workspaces -> 10 distinct ids; ws B cannot renew/complete ws A lease. automated
AC-03 REQ-004 lease of A expires, B claims -> A renew/checkpoint/complete/release => stale_lease. automated
AC-04 REQ-004 A's lease expired, nobody reclaimed -> A write => stale_lease. automated
AC-05 REQ-010 close + reopen store -> tasks/workspaces/events intact; generation monotonic; completed not claimable. automated
AC-06 REQ-006/007 principal without write capability -> forbidden + denied event; foreign principal on workspace -> forbidden + event. automated
AC-07 REQ-008/005 unknown project, bad issue_ref, bad sha, ttl out of range -> rejected. automated
AC-08 REQ-009 temp git repo: pushed commit -> remote; unpushed -> local_only; missing sha -> commit_not_found. automated
AC-09 REQ-001 state dir in iCloud path / inside git repo -> refused; perms 0700/0600. automated
AC-10 REQ-012 bundled server lists 20 tools and runs open->create->claim->checkpoint->complete. automated (smoke)
AC-11 REQ-011 store contract tests parameterized by factory pass. automated
AC-12 REQ-013 docs updated & accurate. inspection
AC-13 runtime: bundled server vs real PROJECTS.md, checkpoint on pushed branch => remote. runtime
AC-14 CI green on PR. runtime
