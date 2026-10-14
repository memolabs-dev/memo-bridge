# Evidence (2026-10-14, local, MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github)

- `pnpm test`: 556 tests, 556 pass (origin/main d3852a7: 542; +5 `tests/operator-read-tail.test.mjs`, +9 `tests/operator-notifications.test.mjs`).
- `pnpm run build`: pass. `pnpm run smoke`: `{"ok":true,"tools":56,"roundTrip":true,...}`.
- Mutation checks (each applied alone, the named test file run, then reverted): 24/24 caught.
  - notify: N1 notify signed to the host; N2 message to another chat; N3 watch kept (double notice);
    N4 ack does not mark; N5 inbox unbounded; N6 inbox shared across principals; N7 Telegram
    failure not journaled; N8 no-bot path broken; N9 tail not redacted; N10 jobs_submit notify
    forwarded; N11 sessions_overview without inbox; N12 inbox tools without capability check;
    N13 watch never expires; N14 permanent errors never end; N15 Telegram tail unbounded;
    N16 foreground notify silently ignored; N17 no poll backoff.
  - tail: T1 final newline counted as separator; T2 tail_lines ignored; T3 window unbounded (whole
    file); T4 tail bypasses the path policy; T5 offset and tail_lines not exclusive; T6 schema bound
    lifted; T7 partial first line kept.
- Hub end to end (real operator agent, real background job store and supervisor, fake runtime,
  fake Telegram client): `operator_run date +%s` background notify -> one message to the owner
  chat, inbox entry, host journal without `notify`, polls signed for the starter, ack then check 0.
