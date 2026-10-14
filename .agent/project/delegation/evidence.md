# Evidence: delegation (#47)

Branch `feat/workspace-delegation`, base origin/main 5dc1c7d, macOS 27, Node 24.21.0, pnpm 12.10.1.
Governance checkout: `MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github`.

## Runs (2026-10-14, 22:29 to 22:40 CEST)

- `pnpm test`: tests 592, pass 592, fail 0, skipped 0 (baseline 577 + 15 in tests/delegation.test.mjs).
- `pnpm run build`: `plugin/server/dist/index.mjs` and `job-runner.mjs` emitted.
- `pnpm run smoke`: `{"ok":true,"tools":61,"roundTrip":true,...}` (56 + 5 delegation tools).
- `pnpm run smoke:remote`: 7/7.
- `node scripts/remote-toolsize.mjs`: read 28 tools 20 527 bytes, write 49 tools 49 849 bytes,
  `workspace_delegate` 1 989 bytes; learning_review 1 101 of 1 536.

## Acceptance

| ID | Test in tests/delegation.test.mjs | Result |
|---|---|---|
| AC1 | "AC1: a child refuses task_claim ...", "AC1, AC3: worktree writes ...", "AC1, AC3: a child runs jobs ...", "operator scope ...", "operator calls ..." | pass |
| AC2 | "AC2: two children of one parent work at once ..." | pass |
| AC3 | "AC3: a child of parent A cannot touch parent B's ..." (warn and enforce), worktree and job tests | pass |
| AC4 | "AC4: release, complete, parent close, delegation_end, TTL and the child closing ...", "AC4: a release the coordinator did not see ...", worktree test end, hub test end | pass |
| AC5 | "AC5: the delegation is bound to the first conversation ..." | pass |
| AC6 | "AC6: sessions_overview shows children under their parent ..." | pass |
| AC7 | "AC7: the child reports with handoff fields ..." | pass |
| AC8 | "AC8: a child write renews the parent's lease ..." | pass |
| AC9 | "AC9: instructions, skill and docs ..." | pass |
| AC10 | mutation run below | 29 of 30 caught, 1 equivalent |
| AC11 | runs above | pass |

## Mutation checks (scratchpad script, each mutation applied alone, `node --test tests/delegation.test.mjs`, then restored)

| Mutation | Result |
|---|---|
| M1 child_cannot_claim removed | caught (AC1) |
| M2 live child may name another workspace or widen | caught (AC1, AC3) |
| M3 worktree scope check on the requested path removed | survived: equivalent mutant, the landing-path check (M4) runs before any directory is created and refuses the same writes; kept as defence in depth |
| M4 worktree scope check on the landing path removed | caught (worktree test) |
| M5 child may reach another worktree | caught |
| M6 child not found by its session | caught |
| M7 child may commit | caught |
| M8 read_only child may run a job | caught |
| M9 child job recorded under the child | caught |
| M10 job on another parent's worktree | caught |
| M11 scopes never overlap | caught (AC2, scope rules) |
| M12 no limit of 5 | caught (AC2) |
| M13 release does not end children eagerly | caught (AC4) |
| M14 liveness ignores the claim | caught (AC4 lazy) |
| M15 liveness ignores the TTL | caught (AC4) |
| M16 any conversation may rejoin | caught (AC5) |
| M17 idle takeover of a child | caught (AC5) |
| M18 warn rebinds a child | caught (AC5) |
| M19 remote join without hint | caught (AC5) |
| M20 parent joins its own delegation | caught (AC5) |
| M21 children not nested | caught (AC6) |
| M22 report not bounded or filtered | caught (AC7) |
| M23 no fence chain | caught (AC8) |
| M24 renewal outside the window | caught (AC8) |
| M25 hub scope refusal removed | caught (operator tests) |
| M26 lock family removed | caught (operator scope test) |
| M27 hub gate on explicit workspace removed | caught (hub test) |
| M28 hub gate on implicit workspace removed | caught (hub test) |
| M29 delegation rule missing from remote instructions | caught (AC9) |
| M30 child may name its parent on jobs_submit | caught (jobs test) |
