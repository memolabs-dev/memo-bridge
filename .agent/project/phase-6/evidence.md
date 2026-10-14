# Phase 6 evidence ledger

Lot 1 (TODO-P6-01 to 07), branch `feat/phase-6-operator`, 2026-10-14, macOS (Darwin 27),
Node 22+, pnpm 12.10.1. Every command ran from the worktree root. No deployment, no VPS access.

| ID | AC / TODO | Method | Command | Result |
|---|---|---|---|---|
| EV-P6-01 | baseline | automated | `pnpm test` before any change | 379 tests, 379 pass |
| EV-P6-02 | all Lot 1 | automated | `pnpm test` after Lot 1 | 412 tests, 412 pass, 0 fail (33 new operator tests) |
| EV-P6-03 | all Lot 1 | automated | `pnpm run test:operator` | 33 tests, 33 pass |
| EV-P6-04 | build | automated | `pnpm run build` | bundle built (dist/index.mjs, job-runner.mjs) |
| EV-P6-05 | regression | automated | `pnpm run smoke` | `{"ok":true,"tools":51,"roundTrip":true,...}`: stdio tool list unchanged (DEV-P6-10) |
| EV-P6-06 | TODO-P6-01 | automated | `tests/operator-policy.test.mjs` (4 tests) | unknown keys and bad values refused; owner, group/other write, agent-writable, writable directory, symlink, missing file each refused with its code |
| EV-P6-07 | TODO-P6-02, AC-P6-06 (paths) | automated | `tests/operator-paths.test.mjs` "resolve: realpath first" | `..` and a symlink out of a root give `path_not_allowed`; a symlink into `.ssh` gives `path_secret` on its canonical path |
| EV-P6-08 | AC-P6-13 | automated | `tests/operator-paths.test.mjs` "AC-P6-13" | a write path in a registered checkout (catalog PROJECTS.md) on `main` answers `use_dev_flow`, also through a symlink and on a detached HEAD; a feature branch is allowed |
| EV-P6-09 | AC-P6-02 (partial) | automated | `tests/operator-paths.test.mjs` "AC-P6-02 (git part)", `tests/operator-tools.test.mjs` "AC-P6-02" | `.git/config`, `.git/HEAD`, hooks refused (`git_internal`); undeclared or injected unit and container names refused before any process starts (recorded argv list empty); declared ones fill exactly one argv slot; `since` limited to journalctl time forms; `runArgv(['/bin/echo','a;id','$(id)'])` prints the bytes, `runArgv(['a;id'])` is a missing file, not a shell line. Validator presets: no validator exists in Lot 1 (edit is Lot 2) |
| EV-P6-10 | AC-P6-03 | automated | `tests/operator-signing.test.mjs` (3 tests), `tests/operator-agent.test.mjs` "AC-P6-03 end to end" | replayed, changed args, edited envelope fields, other request id or principal, expired, exp too far, unknown key, forged key id, missing signature: each refused with its own code; the test op ran exactly once |
| EV-P6-11 | AC-P6-04 | automated | `tests/operator-agent.test.mjs` "AC-P6-04", "live AC-P6-04" | with the FROZEN file the T1 test op answers `frozen`, T0 still reads, removal takes effect on the next call; hub flag and hub freeze file seen by `operator_freeze_status`; `hubFreezeDenial` refuses T1 to T3 when frozen. Telegram `/freeze` is Lot 2 |
| EV-P6-12 | AC-P6-06 | automated | `tests/operator-tools.test.mjs` "AC-P6-06" (2 tests), `operator-agent.test.mjs` "live" | canaries in `.ssh`, `.env`, `*.pem` never appear in list, read or search output, directly or through a symlink; GitHub, AWS and JWT tokens in a read file come back `[REDACTED:<kind>]`; every redactor family checked |
| EV-P6-13 | AC-P6-07 | automated | `tests/operator-agent.test.mjs` "AC-P6-07", "live: the hub signs" | each call appends one chained line (prev = previous hash); editing line 3 makes `operator_audit_verify` report line 3 `hash_mismatch`; recomputing its hash moves the break to line 4 `prev_mismatch`; a removed or torn line is reported; reopened chain continues; file mode 0600; the hub `operator_call` lines and the host lines share args hash and request id. "memo-operator cannot write the log" is Lot 2 (DEV-P6-06) |
| EV-P6-14 | AC-P6-11 | automated | `tests/operator-agent.test.mjs` "AC-P6-11" | 5 counted refusals inside 5 min freeze above T0; refusals older than the window do not count; the marker survives a restart; only removing it unfreezes; `not_found` and `path_not_allowed` never count |
| EV-P6-15 | AC-P6-12 (bounding) | automated | `tests/operator-tools.test.mjs` "AC-P6-12" | a 5 MiB string and a 50 000 line array come back under 128 KiB with `_truncation.omitted` (`/untrusted_content/content`, `/lines`); a 5 MB journal through `operator_logs` is bounded. Background runs after a restart are Lot 2 (TODO-P6-09) |
| EV-P6-16 | R-P6-11 | automated | `tests/operator-agent.test.mjs` "rate limits per tier" | T1 over its per-minute limit answers `rate_limited`, the window slides, T0 is not limited on the host |
| EV-P6-17 | TODO-P6-05 | automated | `tests/operator-remote.test.mjs` (3 tests) | under the default ceiling no operator tool is listed or advertised; with `operator:read` in the ceiling and the token, the 9 T0 tools are listed, each call goes to `requestOperator(<args.host>)` with the forwarder's request id, never to `requestAgent`; `path_secret` journaled as `denied`; without the operator key: `operator_disabled` |
| EV-P6-18 | TODO-P6-05 | automated | `tests/operator-agent.test.mjs` "live" (3 tests) | real hub on loopback TLS and a real `operator-vps` agent: signed reads work, secrets refused, 9443 lists the T0 tools for `hub:owner` only; `requestAgent` refuses operator ops for every identity; an operator identity serves nothing else |
| EV-P6-19 | TODO-P6-05 | runtime | `node bridge/operator-agent-cli.mjs` with a temporary read-only Mac policy, then with the policy chmod 666 | first: `operator_ready` (9 ops, chain head genesis) then reconnect attempts to a closed port; second: exits with `policy_writable_by_others` before connecting |
| EV-P6-20 | mutation checks | automated | `node <scratchpad>/mutate.mjs` (27 mutations, one rule each, file restored after each) | 27 of 27 killed: args hash, replay, expiry, unknown key, signature check, canonical denylist, realpath before roots, repository guard, .git internals, redaction, bound, declared units, walk denylist, untrusted wrapper, FROZEN, auto-freeze, rate limit, local max tier, signature first, chain hash, policy unknown keys, policy owner, policy agent-writable, hub refusal of unsigned operator ops, opt-in ceiling, hub freeze, path_secret counted |
| EV-P6-21 | regression | automated | existing tests updated on purpose: `oidc-verifier`, `policy-remote`, `public-listener`, `remote-surface` | the default ceiling now excludes `operator:*` (DEV-P6-03); a closed gate keeps `operator:read` when the ceiling holds it; `remoteToolNames` with every capability adds the T0 operator tools |
| EV-P6-22 | U-P6-01 | inspection | `docs/HUB_SECURITY.md` lines 99 to 130, coordinator's hub journal note | Mac transport exists (launchd SSH tunnel 127.0.0.1:9444 to lab 9443); recorded as F-P6-01 |

## Lot 2 (TODO-P6-08 to 11), branch `feat/phase-6-lot2`, 2026-10-14

Commands run with `MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github`
(F-P6-02: `~/projects` was moved by another session during Lot 2).

| ID | AC / TODO | Method | Command | Result |
|---|---|---|---|---|
| EV-P6-23 | regression, all Lot 2 | automated | `pnpm test` | 440 tests, 440 pass (413 after the rebase on origin/main, plus 27 new operator tests) |
| EV-P6-24 | environment | automated | `pnpm test` without the variable | 423 pass, 17 fail, all coordinator tests reading `issue_preflight.py` under the missing `~/projects/memolabs-org-gh` (F-P6-02); none in operator code |
| EV-P6-25 | build, smoke | automated | `pnpm run build`, `pnpm run smoke` | build ok; smoke `{"ok":true,"tools":51,"roundTrip":true,...}` (stdio unchanged, DEV-P6-10) |
| EV-P6-26 | AC-P6-01 | automated | `tests/operator-exec.test.mjs` "AC-P6-01" | `operator_run argv ["echo","a;id"]` prints `a;id`; `$(id)`, `|`, backticks and newlines come back as bytes; `"echo a; id"` as a program is `program_not_found` |
| EV-P6-27 | AC-P6-02 (full) | automated | `tests/operator-write.test.mjs` "AC-P6-02" (2 tests), `operator-tools.test.mjs` | validator names outside the 9 presets refused by the schema; `json` runs in process; process presets get a fixed argv whose only variable slot is the agent's own temporary file; a failing or missing validator leaves the file untouched; `.git/config` refused for edit and chmod (`git_internal`) |
| EV-P6-28 | AC-P6-13 (write tools) | automated | `tests/operator-write.test.mjs`, `operator-exec.test.mjs` | edit and delete in a default-branch checkout, and `operator_run` with that cwd, answer `use_dev_flow`; a write tier without `repositories` refuses to load |
| EV-P6-29 | TODO-P6-08 | automated | `tests/operator-write.test.mjs` (8 tests) | edit modes, dry run and diff write nothing; backup before replace with the old content; mode kept; no temp file left; uploads check chunk size and SHA-256, back up the replaced file; copy leaves secrets behind and keeps symlinks as links; move and delete back up first; a failed backup refuses the delete; write roots protected; chmod refuses special bits |
| EV-P6-30 | AC-P6-12 (background) | automated | `tests/operator-exec.test.mjs` "AC-P6-12 (background)" | `job.json` is on disk before the answer; a new store and tool set (simulated restart) read the stored result (exit 0, output); a dead supervisor gives `lost`; a timeout gives `timed_out` |
| EV-P6-31 | AC-P6-09 (executor part) | automated | `tests/operator-root.test.mjs` "AC-P6-09 (executor)", "operator_script" | the executor receives `systemd-run --quiet --collect --wait --pipe --unit=memo-op-<hex> ... --property=RuntimeMaxSec=20s --property=MemoryMax=2G --property=TasksMax=512 --working-directory=/ --setenv=LANG=C -- id -u`; scripts run as `/bin/bash <0700 file> <args>`, file removed after. Real systemd on lab: runtime-pending |
| EV-P6-32 | R-P6-04, R-P6-05 (helper) | automated | `tests/operator-root.test.mjs` "the helper checks..." | unsigned, tampered args, wrong tier, replay: refused by the helper's own verifier; five such refusals auto-freeze the helper; dangerous mode refuses a script or rm without a signed approval id; FROZEN refuses; only admitted calls reach the executor; every call in the helper journal |
| EV-P6-33 | AC-P6-07 (helper ownership) | automated | `tests/operator-root.test.mjs` "over the socket" | over a real Unix socket the agent forwards T3 and appends its journal lines through the helper; the agent's chain object has no file; rewrite, truncate and unknown verbs are `invalid_request`; malformed lines refused; chain verifies; journal file 0600. Root ownership on lab: runtime-pending |
| EV-P6-34 | AC-P6-05 | automated | `tests/operator-approval.test.mjs` "AC-P6-05" (2 tests) | real hub and agent: `rm` answers `pending_approval`, one Telegram message with Approve, Deny and 15 min buttons (callback_data within 64 bytes); asking again reuses it; `confirm:true` opens a separate approval; a stranger's button press is ignored; after the owner approves another file's rm is still pending; the exact call runs once, then asks again; deny holds; no bot gives `approval_unavailable`; a hub set to `off` with a host in `dangerous` gives `approval_required` from the host; `as_root` without `operator:root` is `forbidden` |
| EV-P6-35 | AC-P6-04 (Telegram), AC-P6-11 (owner unfreeze) | automated | `tests/operator-approval.test.mjs` "AC-P6-04 (Telegram)" | `/freeze` from a stranger is ignored; from the owner chat it refuses T2 at the hub while T0 answers; the owner's `/unfreeze` clears the hub flag and the host's auto-freeze marker through the signed internal op; internal ops are `unsupported_op` through `requestOperator` |
| EV-P6-36 | AC-P6-07 (anchoring) | automated | `tests/operator-approval.test.mjs` "AC-P6-07 (anchoring)" | the hub anchors the head; growth is accepted; a host journal rewritten as a new consistent chain is reported `operator_chain_tampered` and freezes the hub |
| EV-P6-37 | TODO-P6-11 (Telegram client) | automated | `tests/operator-approval.test.mjs` "Telegram client" | errors carry method and status, never the token; requests go to `https://api.telegram.org/bot<token>/<method>` by POST; the `telegram-bot` credential is read like the other systemd credentials (missing, invalid, valid) |
| EV-P6-38 | R-P6-11 | automated | `tests/operator-exec.test.mjs` "rate limits per tier" | T2 and T3 have their own per-minute budgets; tiers counted apart; defaults 120, 60, 20 |
| EV-P6-39 | remote listing | automated | `tests/operator-remote.test.mjs` "Lot 2", `tests/remote-surface.test.mjs` | operator write, exec and root tools are listed only with remote_writes enabled, the ceiling and the scope; exec without root lists `operator_run` but not `operator_script` |
| EV-P6-40 | mutation checks Lot 2 | automated | `node <scratchpad>/mutate2.mjs` (32 mutations) | 31 killed by their own test file; L30 (registry write-gate filter) survives `operator-remote.test.mjs` because the principal already loses write capabilities upstream (layer 2), and is killed by `tests/remote-surface.test.mjs` (re-run separately) |
| EV-P6-41 | CLIs | runtime | `operator-agent-cli.mjs` with a read-only Mac policy at max_tier exec; `operator-root-cli.mjs` as the user | agent ready with 24 ops (22 tools, 2 internal); the root helper refuses to start unless uid 0 |
| EV-P6-42 | docs read | inspection | systemd-run(1), systemd.service(5), systemd.resource-control(5), systemd.exec(5) on man7.org (262~devel), Telegram Bot API | quotes in `bridge/operator-root-helper.mjs` and `bridge/operator-telegram.mjs` headers; lab runs systemd 257 (U-P6-03 still open for the runtime check) |

## Runtime checks pending (need lab or the owner)

- AC-P6-09: a real `systemd-run` on lab: `id -u` prints 0, the unit is gone after the call,
  RuntimeMaxSec and MemoryMax applied (`systemctl show` during a run).
- AC-P6-07: `/var/log/memo-operator/audit.jsonl` owned by root 0600, `memo-operator` cannot
  write it (`sudo -u memo-operator sh -c 'echo x >> ...'` fails).
- AC-P6-04 and AC-P6-05 with the real bot (O-P6-2), polkit for `operator_service` (TODO-P6-12).

## Not verified in Lot 1 (owned by later lots)

- AC-P6-01 (`operator_run`), AC-P6-05 (approval), AC-P6-09 (root helper), AC-P6-10 (owner,
  ChatGPT), AC-P6-08 (owner, ChatGPT): no tool in Lot 1.
- AC-P6-04 Telegram part, AC-P6-07 "memo-operator cannot write the log", AC-P6-12 background
  part: Lot 2.
