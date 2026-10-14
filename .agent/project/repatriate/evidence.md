# Evidence, repatriation part 1 (execution and safety)

Branch `feat/operator-repatriate-exec`, worktree `workspace/worktrees/memo-bridge/repatriate-exec`,
started from `origin/main` 255b3dc, rebased on `origin/main` e57fb0a (part 2, PR #45) at
20:30 CEST. Not pushed, not deployed.

## Automated

- EV-0 baseline (2026-10-14 19:45 CEST, 255b3dc): `pnpm test` 484/484.
- EV-1 (20:34 CEST, after the rebase on e57fb0a):
  `MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github pnpm test`
  -> tests 542, pass 542, fail 0, cancelled 0, skipped 0. New test files: `operator-classify`
  (7), `operator-grants` (5), `operator-userexec` (6), `operator-docker` (4), `operator-readonly`
  (6); updated: approval, root, root-mac, remote, mac-install, multi-session, remote-surface,
  remote-e2e, transfer.
- EV-2: `pnpm run build` emits `plugin/server/dist/index.mjs` and `job-runner.mjs`;
  `pnpm run smoke` -> `{"ok":true,"tools":56,"roundTrip":true,...}` (stdio list unchanged: the
  operator tools are hub tools). `pnpm run test:deploy` -> 124 OK.
- EV-3 `node scripts/remote-toolsize.mjs`: write stage 44 runtime tools, 41 KB; the two new
  operator tools are listed with the other operator tools (registry self-check green).
- EV-4 a full run at 20:08 under load average 39 (other sessions) timed out three runner and
  ledger tests (`coordinator.test.mjs` ledger timeout, `jobs.test.mjs` findings 5 and 7); the
  same three pass alone (5.1 s, 4.0 s, 7.3 s) and in EV-1. They do not touch the changed modules.
- EV-5 mutation checks: `mutations.md` in this directory (one per rule, each restored).

## Field facts used

- Docker on lab: `docker version` -> server 29.9.0, API 1.56, minimum API 1.40 (read-only, 19:44).
  `/var/run/docker.sock` is `root:docker 0660`.
- Docker Engine API v1.56 specification
  (`https://docs.docker.com/reference/api/engine/version/v1.56.yaml`, read 2026-10-14): a
  version prefix locks the API version ("/v1.30/info"); logs of a non-TTY container are
  multiplexed in frames `[STREAM_TYPE, 0, 0, 0, SIZE1..SIZE4]` (big-endian size).
- Lab policy read 19:44: 22 declared containers, root helper socket `/run/memo-operator/root.sock`.
- Mac tools: `node` (nvm and Homebrew), `pnpm` in `~/Library/pnpm/bin`, `gh` and `python3` in
  `/opt/homebrew/bin`, `git`, `ssh`, `rsync`, `make` in `/usr/bin`.
- Live bench findings relayed by the coordinator (19:57 `ps` refused `workspace_required`;
  20:04 note creation refused, then `workspace_open` host mac `host_not_remote_enabled`).

## Not verified here (runtime, owner)

- A real Telegram round trip for `operator_grant` and `/grant`, `/approvals`, `/revoke`.
- `operator_docker` against the real lab socket from inside `memo-operator-root.service`
  (`ProtectSystem=strict`, `RestrictAddressFamilies=AF_UNIX`).
- The implicit workspace on the real runtime: whether project `ops` is allowlisted (else the
  session-derived id is used, journaled `workspace_implicit`).
- ChatGPT refreshing its tool list (the 20:04 bench had a stale list without `operator_lock`).
