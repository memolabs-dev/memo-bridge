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

## Not verified in Lot 1 (owned by later lots)

- AC-P6-01 (`operator_run`), AC-P6-05 (approval), AC-P6-09 (root helper), AC-P6-10 (owner,
  ChatGPT), AC-P6-08 (owner, ChatGPT): no tool in Lot 1.
- AC-P6-04 Telegram part, AC-P6-07 "memo-operator cannot write the log", AC-P6-12 background
  part: Lot 2.
