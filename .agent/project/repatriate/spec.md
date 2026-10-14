# Repatriate SentinelX execution into Memo Bridge (part 1: execution and safety)

Branch `feat/operator-repatriate-exec` from `origin/main` 255b3dc. Started 2026-10-14 19:39 CEST.
Part 2 (transfer, media, playbooks, context memory) runs in another worktree; this part only
touches the execution path, the danger classifier, approvals and the Mac policy.

## Intent

The owner's decision of 2026-10-14: everything he does today through SentinelX on his Mac
(measured over 1.5 days: 2,646 `script_run`, 1,667 `exec` of which `gh` 632, `git` 441, `ssh`
185, 567 edits) must live in Memo Bridge, with SentinelX's fluidity, and he must control the
Mac and the VPS fully from ChatGPT. Source: `workspace/research/2026-10-14-sentinelx-parity.md`
(matrix rows 12, 16, 17, 19; gaps 1, 2, 3, 5, 8, 13).

Non-goals here: host to host transfer, media, playbooks, context memory, notifications (part 2);
deploying; lab-infra changes (listed for the owner in the closure); launchd services on the Mac.

## Decisions

| ID | Decision | Why |
|---|---|---|
| D-R1 | The classifier (`bridge/operator-dangerous.mjs`) splits a danger into **hard** (asks every time, no standing approval can cover it) and **grantable** (a standing approval naming the program covers it). Grantable: `wrapper:<program>`, `remote:<ssh\|scp\|sftp\|rsync>`, `script` (user scripts). Everything else is hard. Hard reasons are computed first, over the whole argv, so `ssh lab rm -rf /x` is `command:rm`, not `wrapper:ssh`. `git` and `gh` rules apply wherever the program appears in argv (`env git push -f`). | A standing approval must never open the truly destructive list. |
| D-R2 | `gh`: reads stay free (`pr view/list/checks/diff`, `issue list/view`, `run view/list`, `api` GET). Hard: `pr merge`, `repo delete/archive/rename/edit/transfer`, `release delete/delete-asset`, `secret`, `variable set/delete`, `auth`, `ssh-key`, `gpg-key`, `extension`, `alias`, `workflow run/enable/disable`, `run delete`, `cache delete`, `issue delete`, `label delete`, `api` with a non-GET method (`-X`, `--method`, or implied POST by `-f/-F/--field/--raw-field/--input`) on a protected endpoint (merge, refs, branches and protection, rulesets, collaborators, hooks, keys, secrets, variables, environments, transfer, the repository itself, orgs, user), and `api graphql` with a `mutation` or `--input`. Other gh writes (`pr create`, `issue comment`, ...) stay free. | `gh pr merge` passed with no approval on the Mac today (parity gap 5, P0). |
| D-R3 | `git` stays a wrapper (grantable). Hard: `push` with `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--delete`, `-d`, `--mirror`, `--prune`, a `+refspec`, a `:branch` deletion, or a refspec whose destination is `main` or `master`; `reset --hard`; `clean` with `-f`; `branch -D` or `--delete --force`; `filter-branch`, `filter-repo`; `reflog expire`; `update-ref -d`. | Irreversible history or work loss; the default branch is the dev flow's (D11). |
| D-R4 | **Standing approvals** (`bridge/operator-grants.mjs`, hub memory): `{id ap_st_..., host, programs[], cwd_prefixes[], expires, principal or any}`. Created by the owner only: either a ChatGPT `operator_grant{action:"request"}` that the owner approves in Telegram, or the owner's own `/grant <host> <p1,p2> <cwd> <ttl>` in Telegram. TTL 1 to 12 h (default 8). Revoked by `/revoke <id>` or `/revoke all` in Telegram, or `operator_grant{action:"revoke"}` (revoking only removes power). Listed by `/approvals`, `operator_grant{action:"list"}`, `operator_policy` (hub adds `standing_approvals`) and `sessions_overview`. A grant covers an `operator_run` or `operator_script` call that is not `as_root`, whose host matches, whose `cwd` is under one of the prefixes, whose program (`basename(argv[0])`, or the interpreter) is named, and whose danger is grantable. Never: T3, `/`, `sudo`, `su`, `doas` or a hard-listed program. Memory only: a hub restart drops grants (like approvals and locks). | ~780 Telegram prompts in 1.5 days is unusable; one approval per work session is the owner's ask. |
| D-R5 | Defence in depth on the host: a signed approval id starting `ap_st_` is refused by the agent (`approval_scope`) when the call's danger is hard, and by the root helper always (T3). Single-use ids never start with `st_`. | A hub bug cannot turn a standing approval into a hard approval. |
| D-R6 | `operator_script` gains `as_root` (default false), `cwd`, `env`, interpreters `bash`, `zsh`, `sh`, `python3`, `node`. Without `as_root` it is T2 (`operator:exec`) and runs in the agent as the agent user (`memo` on the Mac, `memo-operator` on lab); with it, T3 through the root helper (bash and python3 only, as before). Content at most 64 KiB, written 0700 under `state_dir/scripts`, removed after the run (background: by the supervisor). Lock: a path lock on `cwd`, else global. | The first real usage (2,646 runs) had no equivalent (parity gap 1). |
| D-R7 | Every user run (`operator_run`, `operator_script`, foreground and background) leads its own process group; the group gets SIGKILL at the timeout and once the program exits. | Grandchildren survived the timeout (parity row 16, gap 13). |
| D-R8 | User runs get `HOME`, `USER`, `LOGNAME` of the agent user and, when the agent has it, `SSH_AUTH_SOCK`; new optional policy key `run_path` (absolute directories put before the fixed PATH for user runs only; never for root). The Mac policy sets `~/Library/pnpm/bin`, `~/.local/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`. | `git`, `gh`, `ssh`, `pnpm` need their home and PATH to work as the owner. |
| D-R9 | `ssh`, `scp`, `sftp`, `mosh`, and `rsync` with a remote spec (`host:path`, `-e`, `--rsh`, `--rsync-path`) are `remote:<program>`: grantable, and `host_required` like any dangerous call. `ssh lab` is root on lab (`whoami` = root, parity §1.2): it is T3 equivalent, covered only by an approval or a standing grant naming it. Local `rsync` is free, except `--delete*` and `--remove-source-files` (hard). | First-class ssh/scp/rsync, without a silent root path to lab. |
| D-R10 | Mac write roots: the whole home and `/tmp`; the denylist keeps keychains, `.ssh`, `.gnupg`, secrets, browser profiles, cloud credentials, `~/.memo-operator`, and adds `~/.local/share/memo-bridge` (the agents' pinned code), `.password-store`, `.config/op`, `Library/Application Support/com.apple.TCC`, Vivaldi and Opera. Writes under `~/Library/LaunchAgents` keep asking (sensitive path). The installer's `policy` step stays idempotent (same file, no backup). | Owner decision 2026-10-14 (O-P6-5 settled). |
| D-R11 | `operator_docker{host, action, container?, project?, lines?, since?}` on lab, through the root helper, Docker Engine API over `/var/run/docker.sock` (`/v1.44`, the daemon accepts 1.40 to 1.56). Actions `ps`, `inspect`, `logs`, `compose_ps` (T0, read) and `restart`, `stop`, `start` (T2, container lock). A container must be in the live list (`GET /containers/json?all=1`); a compose project in the live labels. `inspect` is projected (never `Config.Env`, never labels other than compose ones). Stop or restart of `traefik`, `memo-*`, `pocket-id*` is hard (asks every time). No `run`, `exec` or `pull`: those stay `operator_run as_root ["docker", ...]`, T3 plus approval. On the Mac: `docker_unavailable_on_host`. | Docker without the docker group, like SentinelX local_api (parity row 19, gap 8). |
| D-R13 | Live bench 2026-10-14 19:57 (coordinator): `operator_run ["ps", ...]` from ChatGPT failed with `workspace_required`. **Read-only commands** (`operator-dangerous.mjs readOnlyCommand`: ps, top -l/-b, uptime, vm_stat, df, du, ls, stat, file, wc, head, tail, cat, grep, rg, find without -exec/-delete, git status/log/diff/show/branch listing/rev-parse/ls-files/blame/config --get..., gh read verbs and `api` GET, uname, sw_vers, system_profiler with a data type, launchctl list/print, systemctl status/show/list-*, journalctl, docker ps/logs/inspect, free, ip ... show, ss without -K, hostname, date +fmt, sysctl reads) need no workspace, no lock and no approval, not even when the program is a wrapper (git, find). They stay T2: signature, exec rate limit, both journals (`read_only: true` on the hub line). The agent checks every path-like argument (absolute, `~`, or relative to cwd) with the read policy and the denylist (`path_secret`, `path_not_allowed`), and runs read-only git with `core.fsmonitor=false`, `core.pager=cat`, `GIT_OPTIONAL_LOCKS=0` and `--no-ext-diff --no-textconv`. Any write-capable flag makes it a normal command again. | One call for "the 5 most CPU-hungry processes", as with SentinelX. |
| D-R14 | **Auto workspace and lock** for a remote T1 to T3 call without a workspace or a lock: the hub finds the conversation's own active workspace (runtime `sessions_overview`, `you`), else opens one on `autoWorkspaceProject` (default `ops`, `MEMO_BRIDGE_OPERATOR_AUTO_PROJECT`) for that conversation (`workspace_auto_open` journaled), then takes path, unit or container locks on what the call touches (`operator_lock_auto`, reason `auto: <op>`). It never takes a global lock (root calls, scripts and commands without cwd): those answer `lock_required` with `next_step`. No session hint, or a runtime refusal: `workspace_required` with `next_step` (`workspace_open {"project":"ops"}`). The result carries `auto: {workspace_id, workspace_opened, locks_taken}`. Conflicts still answer `locked_by_other_session`. | The lock rule of D-MS5 holds (no two conversations on one target) without a step the user has to type. |
| D-R12 | Instructions (remote `INSTRUCTIONS`, stdio) and `docs/OPERATOR.md`: at the start of a work session, ChatGPT asks once for a standing approval naming programs, cwd and duration; a `pending_approval` on a grantable call says so in its detail. | The model must know the fluid path. |

## Requirements and acceptance

| ID | Requirement | Acceptance (test) |
|---|---|---|
| RR-1 | gh classified (D-R2) | `gh pr merge 1`, `gh api -X DELETE /repos/o/r`, `gh api /repos/o/r/pulls/1/merge -X PUT`, `gh secret set X`, `gh auth token`, `gh repo delete`, `gh release delete v1`, graphql mutation: hard; `gh pr view 1`, `gh pr list`, `gh api /repos/o/r`, `gh run view 1`: null |
| RR-2 | git hard list (D-R3), also behind `env`/`xargs` | each listed form hard; `git status`, `git push origin feat/x`: `wrapper:git` |
| RR-3 | Hard computed before wrapper (D-R1) | `ssh lab rm -rf /x` is `command:rm` |
| RR-4 | Standing approval store (D-R4) | matches program, cwd prefix, host, TTL; refuses T3, other cwd, hard reasons, expired, revoked; `/` and `sudo` refused at creation |
| RR-5 | Hub uses grants (D-R4) | with a grant for git under a dir, two `git status` calls run with no Telegram message, `git push --force` asks, other cwd asks, after revoke asks; journal carries the grant id |
| RR-6 | Telegram `/grant`, `/approvals`, `/revoke`, request buttons (D-R4) | fake client tests, owner chat only |
| RR-7 | Agent refuses a standing id on a hard call; helper refuses it on T3 (D-R5) | tests |
| RR-8 | `operator_script` as user on both hosts (D-R6) | runs bash/sh/python3/node scripts, args, cwd, env allowlist, timeout, background with result and script removed; `as_root` goes to the helper; tier 2 vs 3; lock path vs global |
| RR-9 | Process group killed for user runs (D-R7) | a grandchild `sleep` is gone after the timeout, foreground and background |
| RR-10 | ssh/scp/rsync classification and host required (D-R9) | `remote:ssh`, `remote:rsync` (remote spec, `-e`), local rsync null, `rsync --delete` hard; hub answers `host_required` for `ssh` without host |
| RR-11 | User-run environment (D-R8) | HOME set, `run_path` first in PATH, root env unchanged |
| RR-12 | Mac write roots (D-R10) | rendered policy has home and `/tmp`, new denylist entries; second run unchanged, no backup |
| RR-13 | `operator_docker` (D-R11) | fake Docker socket: ps projection, inspect without Env, logs demultiplexed and redacted, unknown container refused, compose_ps by label, restart of beszel free, of traefik hard; tier 0 vs 2; Mac refuses |
| RR-14 | Docs and instructions (D-R12) | OPERATOR.md sections; instructions text test |
| RR-16 | Read-only commands (D-R13) | classifier accepts the listed shapes and refuses write-capable ones; agent refuses `.env`, symlinks into `.ssh`, paths outside the roots; hub runs `ps` from a remote chat without workspace or lock, journaled `read_only`, even under another chat's global lock |
| RR-17 | Auto workspace and lock (D-R14) | remote edit without workspace: workspace opened, path lock taken, both journaled, `auto` in the result; second chat locked out; command without cwd answers `lock_required` with `next_step`; no hint or runtime refusal answers `workspace_required` with `next_step` |
| RR-15 | No regression | `pnpm test`, `pnpm run build`, `pnpm run smoke` green with the governance root |

Each rule gets one mutation check (rule removed, its test fails), recorded in `evidence.md`.

## Risks

| ID | Risk | Level | Treatment |
|---|---|---|---|
| R-R1 | A standing approval on a wrapper (`bash`, `python3`, `node`, `ssh`, `make`, `pnpm`) is any command as that user, and for `ssh` root on lab. The cwd prefix bounds where it starts, not what it touches. | high (accepted by the owner) | Stated in the Telegram request text, OPERATOR.md and the instructions; hard list still asks; TTL at most 12 h; `/revoke`; journal carries the grant id; T3 never covered. |
| R-R2 | The argv classifier cannot see inside `bash -c`, scripts, `make` targets, `pnpm` scripts or `ssh` remote strings. | high (known, SECURITY.md "argv classifier gaps") | Hard scan of every argv item; scripts opaque by design; the grant is the owner's explicit choice. |
| R-R3 | Mac write root = home: `~/.zshrc`, `~/.gitconfig`, git hooks of checkouts, agent code. | medium | Denylist for agent code and config; LaunchAgents ask; `.git` writes refused by T1 tools; the owner's decision. |
| R-R4 | Grants in memory: a hub restart drops them. | low | The model asks again; documented. |
| R-R5 | Docker API version drift. | low | Versioned path `/v1.44` (daemon minimum 1.40, current 1.56, read 2026-10-14). |
| R-R6 | Parallel part 2 edits the same tool table. | medium | Additions only, isolated hunks. |
| R-R7 | Process-group kill also kills a daemon a user run meant to leave behind (`nohup`). | low | Intended; background mode exists; programs that call setsid survive. |
| R-R9 | Read-only fast path: a program on the list reads a file that the denylist misses, or a repository's own config runs code during `git status` (hooks do not run on reads; fsmonitor and pager are switched off; other drivers remain). | medium | Paths checked by the agent; output redaction; hardening of read-only git; the list is closed and tested. |
| R-R10 | Auto locks: a conversation that forgets to unlock holds path locks for 15 min. | low | TTL 15 min, `operator_unlock`, `sessions_overview` shows them; never global. |
| R-R8 | `operator_script` without `as_root` changed meaning (it was always root). | medium | A root script now needs `as_root: true`; the description and instructions say so; host required unchanged. |

## Work graph

| ID | Todo | Depends | Priority |
|---|---|---|---|
| RP-01 | Spec (this file), state.json | | P0 |
| RP-02 | Classifier: hard/grantable split, gh, git, ssh/scp/rsync, docker reasons | 01 | P0 |
| RP-03 | Grant store and hub integration, `operator_grant` tool, policy and overview listing | 02 | P0 |
| RP-04 | Telegram `/grant`, `/approvals`, `/revoke`, grant request buttons | 03 | P0 |
| RP-05 | Agent and helper scope checks for `ap_st_` | 03 | P0 |
| RP-06 | Process group runs and supervisor cleanup | 01 | P0 |
| RP-07 | `operator_script` as user, tiers, locks, env and `run_path` | 06 | P0 |
| RP-08 | Mac policy: write roots, denylist, run_path | 07 | P0 |
| RP-09 | `operator_docker` via the root helper | 02 | P1 |
| RP-12 | Read-only fast path and auto workspace and lock (bench 19:57) | 02, 03 | P0 |
| RP-10 | Docs, instructions, SECURITY.md | 02-09, 12 | P0 |
| RP-11 | Full suite, build, smoke, mutation checks, evidence, closure | all | P0 |
