# Global owner project enrollment (#312)

Owner instruction 2026-10-27: all owner projects are authorized, public and private.
Scope: registered, available Mac owner checkouts in memolabs-dev and guillaume-flambard;
existing explicit external registrations count. Metadata snapshots do not grant execution.

DISCOVER: install --from-registry excludes public repositories; project_create only enrolls
its private memolabs-dev/name; remote policy reload already follows atomic file replacement.
MODEL: local registry + verified origin + GitHub visibility -> enrollment -> private ledger
policy then remote project policy -> runtime gate -> hub routing. VPS snapshot is separate.
SPECIFY: explicit --all-owner-projects opts into public and private enrollment and periodic
Mac reconciliation. Preserve legacy behavior without opt-in. Keep owner authentication,
write/session gates, locks, bounds and unverified/archived repository refusals.

Acceptance / finite work graph:
- T1 P1: shared enrollment, installer opt-in and positive/negative tests.
- T2 P1: trusted owner-only, Mac-only recurring reconciliation; preserve policy controls;
  abort on incomplete GitHub verification; serialize and detect changed policies.
- T3 P1: live Mac catalog preference for owner listings, retain offline snapshot behavior.
- T4 P1: local regression checks and CI on exact PR revision, independent security review.
- T5 P0: authorized production installation with recoverable rollback; real Mac/VPS smoke,
  all-project inventory comparison, new conversation, negative access test.

Verification: temporary HOME fixtures; no tests may edit live owner policy. Run focused tests,
then full suite/build/smoke and CI. Production tests only after authorized deployment.
Risks: HIGH unresolved deployment permission (preflight path_secret); HIGH until security
review of recurring enrollment; catalog source and authorization must remain separate.
Rollback: disable new opt-in via previous reviewed release and restore the exact preceding
private/remote policies and runtime plist using trusted administration; do not use probe-only
rollback as proof of runtime availability. Record exact deployed revision before changing it.

Current status: VERIFYING. T1/T2/T3 source changes implemented and locally verified.
T4: independent standards/security and spec reviews found reproduced defects, now fixed;
CI on final revision pending. T5 remains BLOCKED by protected configuration preflight.
No production change or live smoke is claimed. The code PR does not close #312.
