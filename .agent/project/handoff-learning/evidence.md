# Evidence: handoff (#39) and learning review (#38)

Run on 2026-10-14 (Europe/Paris), branch `feat/handoff-and-learning-review`, with
`MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github`.

- EV-1 `pnpm test`: tests 557, pass 557, fail 0, skipped 0 (542 before this branch plus 15 new:
  `tests/handoff.test.mjs` 5, `tests/learning-review.test.mjs` 10).
- EV-2 `pnpm run build`: `plugin/server/dist/index.mjs` and `job-runner.mjs` emitted.
- EV-3 `pnpm run smoke`: `{"ok":true,"tools":56,"roundTrip":true,...}` (stdio bundle with the hook).
- EV-4 `pnpm run remote:toolsize`: read 27 tools 19178 bytes, write 44 tools 42746 bytes,
  `learning_review block 1101 bytes (bound 1536)`.
- EV-5 mutation checks, one per rule, each caught by the new tests (18/18):
  M1 handoff secret filter, M2 injection filter, M3 total bound, M4 item bound, M5 ledger verify
  before a handoff, M6 recover returns handoffs, M7 brief carries the handoff, M8 v6 migration of
  a v5 store; L1 end of task needs a call since the last write, L2 reset on memory_save, L3 reset
  on emission, L4 0 disables the call counter, L5 turn gap, L6 conversation binding fallback,
  L7 block is fixed text, L8 block byte bound, L9 hook never fails a call, L10 counters per
  workspace.

| AC | Status | Evidence |
|---|---|---|
| AC1 to AC5 | verified | handoff.test, EV-1, EV-5 M1 to M8 |
| AC6 to AC10 | verified | learning-review.test, EV-1, EV-5 L1 to L10 |
| AC11 | verified | learning-review.test AC11, inspection |
| AC12 | pending | real ChatGPT resume after context loss: owner, after deploy |
