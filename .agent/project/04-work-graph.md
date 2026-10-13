# Work graph
| ID | P | Status | REQ | Deps | Description | AC |
|---|---|---|---|---|---|---|
| T-01 | P0 | DONE | - | - | Merge PR #7 to main (owner-authorized), main tests green | EV-01 |
| T-02 | P0 | TODO | 001,002,011 | T-01 | store.mjs: location guard, schema, tx, contract API | AC-09, AC-11 |
| T-03 | P0 | TODO | 003,004,005 | T-02 | leases.mjs claim/renew/release/fence | AC-01, AC-03, AC-04 |
| T-04 | P0 | TODO | 006,007 | T-02 | policy.mjs + audit events | AC-06 |
| T-05 | P1 | TODO | 009 | T-02 | checkpoints.mjs git verification | AC-08 |
| T-06 | P0 | TODO | 008,010 | T-03..T-05 | coordinator/index.mjs operations | AC-02, AC-05, AC-07 |
| T-07 | P0 | TODO | 012 | T-06 | tools/coordinator-tools.mjs + index.mjs + bridge_info | AC-10 |
| T-08 | P0 | TODO | all | T-06 | tests: unit, contract, multi-process concurrency, smoke | AC-01..AC-11 |
| T-09 | P1 | TODO | 013 | T-07 | docs COORDINATOR, SECURITY, README, skill, STAR | AC-12 |
| T-10 | P1 | TODO | - | T-08 | runtime check vs real registry | AC-13 |
| T-11 | P1 | TODO | - | T-10 | independent verification + code review | - |
| T-12 | P1 | TODO | - | T-11 | push branch, open PR, CI green | AC-14 |
| T-13 | P2 | TODO | - | - | Follow-up: unify hub/stdio registry when #5 merges | - |
| T-14 | P2 | TODO | - | - | Follow-up: Postgres store adapter when hub becomes central | - |
