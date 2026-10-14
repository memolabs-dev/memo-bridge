# Closure, repatriation part 1

Status: READY_FOR_MANUAL_ACCEPTANCE (not pushed, not deployed, no PR).

## What is done (work graph)

| ID | Todo | State | Evidence |
|---|---|---|---|
| RP-01 | Spec | done | `spec.md` |
| RP-02 | Classifier: hard and grantable, gh, git, ssh, scp, rsync, docker | done | `tests/operator-classify.test.mjs`, M01 to M07 |
| RP-03 | Standing approvals in the hub, `operator_grant`, policy and overview listing | done | `tests/operator-grants.test.mjs`, M08 to M12, M16 |
| RP-04 | Telegram `/grant`, `/approvals`, `/revoke`, request buttons | done | same, M17 |
| RP-05 | Agent and helper `approval_scope` | done | M13, M14, M15 |
| RP-06 | Process groups for every user run, supervisor cleanup | done | `tests/operator-userexec.test.mjs`, M18 to M21 |
| RP-07 | `operator_script` as user on both hosts, tiers, locks, env, `run_path` | done | same, M22 to M24, M40 |
| RP-08 | Mac policy: whole home, denylist, `run_path` | done | `tests/operator-mac-install.test.mjs`, M37, M38, M43 |
| RP-09 | `operator_docker` through the root helper | done | `tests/operator-docker.test.mjs`, M25 to M27 |
| RP-12 | Read-only fast path; implicit workspace and per-call lock (bench 19:57, 20:04) | done | `tests/operator-readonly.test.mjs`, M28 to M36 |
| RP-13 | After part 2: transfer destinations under implicit locks; `restart_stack` uses `operator_docker` | done | `tests/operator-transfer.test.mjs`, `tests/operator-snapshot-help.test.mjs`, M41, M42 |
| RP-10 | Docs: OPERATOR.md, instructions, skill, SECURITY.md | done | M39, RR-14 test |
| RP-11 | Full suite, build, smoke, mutation checks | done | `evidence.md`, `mutations.md` |

No P0 or P1 open in code. Open items are runtime and owner steps below.

## Owner and lab-infra steps (not done here)

lab-infra (role `memo-operator`, `memo-bridge`):
1. Deploy the release (hub, agent, root helper share the app dir).
2. Root helper unit: `operator_docker` connects to `/var/run/docker.sock` from
   `memo-operator-root.service` (`User=root`, `RestrictAddressFamilies=AF_UNIX` already allows
   it). `ProtectSystem=strict` makes `/run` read-only for the service; connecting to a socket on a
   read-only mount should work (no inode write), to be confirmed by one `operator_docker ps`. If it
   answers `docker_unavailable`, add `ReadWritePaths=-/run/docker.sock` (or `/var/run/docker.sock`).
3. Hub: optional `MEMO_BRIDGE_OPERATOR_AUTO_PROJECT` (default `ops`) naming a project the
   remote allowlist accepts; without it, conversations get a session-derived coordination id
   (works, but no runtime workspace row).
4. Optional policy keys on lab: `run_path` (none needed), `run_env_allow`.
5. Telegram: no new credential. Optional BotFather command list: `/grant`, `/approvals`,
   `/revoke`, `/freeze`, `/unfreeze`, `/status`.
6. ChatGPT connector: refresh the tool list (new `operator_grant`, `operator_docker`, changed
   `operator_script`).

Mac (after the merge, from a checkout of main, `pnpm install` done):
1. `deploy/mac/install-operator-agent.sh --install` rebuilds the bundle, rewrites the policy
   (whole home writable, new denylist, `run_path`; the old file is kept as
   `policy.json.<ts>.bak`) and reloads the LaunchAgent.
2. The Mac root helper is installed on this Mac (`/Library/Application Support/MemoBridge/
   operator-root/policy.json` exists): rerun `sudo deploy/mac/install-operator-root.sh --install` so the
   helper gets the new code (standing ids refused, root scripts bash or python3 only) and the
   extended denylist.
3. Check: `operator_policy {host:"mac"}` shows `roots.write` = home and `/tmp`, `run_path`, and
   `standing_approvals`.

## Manual acceptance (owner)

1. From ChatGPT: "the 5 most CPU-hungry processes on the Mac" answers in one call.
2. "Create ~/memolabs/workspace/bench-mb/note.md on the Mac" answers in one call (`auto` in the
   result), and `sessions_overview` shows no lingering lock.
3. `operator_grant` request for git, node, pnpm, python3, make, ssh under `~/memolabs`, 8 h:
   one Telegram message; after Approve, `git status`, `pnpm test`, `python3` scripts run with
   no further message; `git push --force` and `gh pr merge` still ask; `/revoke all` ends it.
4. `operator_script` bash as the user on the Mac and on lab; a script with `sleep 300 &` and
   `timeout_s: 2` leaves no `sleep` behind.
5. `operator_docker {host:"vps", action:"ps"}` and `restart` of `beszel` (no prompt); `restart`
   of `traefik` asks.

## Risks left open (accepted or runtime)

- R-R1 standing approval on a wrapper is any command as the user, root on lab for `ssh` (high,
  owner's choice, stated in the Telegram text and the docs).
- R-R2 argv classifier gaps for scripts and package scripts (high, known, documented).
- R-R9 read-only fast path relies on a closed list and agent path checks (medium).
- R-R10 implicit locks last one call (medium; explicit locks for multi-step work).
- Phase 6 acceptance items AC-P6-04/08/10 (real Telegram, owner trials) remain the owner's.
