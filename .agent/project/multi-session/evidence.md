# Evidence (2026-10-14, branch feat/multi-session-coordination)

## Runs

- Baseline before any change (origin/main 254c151): `pnpm test` 451/451.
- After: `MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github pnpm test` 472/472
  (new `tests/multi-session.test.mjs` 21/21; `tests/batches.test.mjs` 9/9 after the ledger moved to
  `tests/helpers/memory-ledger.mjs`).
- `pnpm run build` ok (index.mjs, job-runner.mjs). `pnpm run smoke` ok, 52 tools, the stdio
  instructions carry the start sequence and stop codes. `pnpm run smoke:remote` 7/7.
  `pnpm run test:deploy` OK.
- Mutations: 30/30 caught by `tests/multi-session.test.mjs` (script in the session scratchpad,
  one per rule: enforce x5, overview x3, task_next x3, brief, locks x9, hub gate, host x5,
  instructions x3).

## Acceptance

| ID | Test |
|---|---|
| MS-R1 | "sessions_overview lists every conversation...", "is bounded (20 newest...)", "stays under the remote budget..." |
| MS-R2 | "sessions_overview gets the locks per workspace and as a list, with you" |
| MS-R3 | "the decision: enforce is strict...", "enforce refuses another conversation's workspace...", "recover ... only after 30 min", "enforce leaves stdio and warn unchanged"; `tests/remote-session-binding.test.mjs` unchanged and green |
| MS-R4 | "remote.json and the runtime policy accept session_binding enforce" |
| MS-R5, MS-R6 | "lock contention...", "operator_service on a locked unit and operator_run with a cwd..." |
| MS-R7 | "remote writes need workspace_id and a covering lock; 9443 callers..." and "hub: a lock refuses another workspace before anything is signed" |
| MS-R8 | "a restart drops the locks; ... lock_required" |
| MS-R9 | "11 concurrent conversations call task_next: 10 distinct tasks...", "one conversation at a time follows the priority order" |
| MS-R10 | "task_next answers carry a brief" |
| MS-R11 | "the instructions, the skill and the docs carry the start sequence" and the smoke assertion |
| MS-R14 | "host default: the Mac when operator-mac is connected", "host default: vps when the Mac is not connected; root, script and dangerous calls need the host" |

## Self-review (one bounded pass) and what it changed

1. Refused calls counted as activity: another conversation knocking kept a workspace busy and
   blocked the 30 min takeover. Fixed (`lastActivity` keeps `ok` events only), covered by the
   recover test.
2. With the maximum of locks the overview went over the 24 KiB remote budget (26.5 KB measured).
   Fixed: 32 locks in all, details once per workspace, reasons cut to 80 characters in the
   overview (the refusal keeps the full reason); test measures the worst case.
3. Open, not code: the remote rate limits are per principal, so ten conversations share read 60,
   write 20, execute 6 per minute and 8 in flight. lab-infra should raise them.
4. Accepted limits: `already_held` in backlog mode returns the Issue reference without title or
   scope; locks compare paths as text (documented).

## Not verified (needs the owner and a deploy)

- Whether ChatGPT sends `_meta["openai/session"]` and keeps it stable (U-P5-05): read the
  `session_tag` column of `sessions_overview` under `warn` before setting `enforce`.
- Ten real ChatGPT conversations against the deployed hub.
