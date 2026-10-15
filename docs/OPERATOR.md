# Operator access (Phase 6)

Operator tools let the owner, from a ChatGPT Chat conversation (connector "Memo Bridge VPS")
or from the 9443 hub, read, write and run commands on the VPS `lab` and on the Mac, root
included on both (on the Mac once its root helper is installed, owner decision 2026-10-14). They are for the machine. Code in tracked repositories keeps the
worktree, job, pull request flow (`docs/REMOTE_CHATGPT.md`): a write or a command inside a
registered checkout on its default branch answers `use_dev_flow`.

Specification: `.agent/project/phase-6/spec.md` (decisions D1 to D11, deviations DEV-P6-01 to
39; the Mac root follow-up is DEV-P6-32 to 39). Server side on lab: lab-infra role `memo-operator`, `docs/memo-operator.md` there.

## Path of one call

```
ChatGPT ── OAuth ──> hub 9445 ──┐
owner bearer ──────> hub 9443 ──┤ checks scope, freeze flag, rate, approval;
                                │ signs {id, op, host, tier, args_sha256, exp, nonce, principal}
                                ├── wss ──> operator-vps (lab, user memo-operator) ── socket ──> root helper (T3)
                                └── wss over the SSH tunnel 127.0.0.1:9444 ──> operator-mac (Mac, user memo) ── socket ──> Mac root helper (T3)
```

Each agent checks the hub signature (Ed25519, 60 s, nonce never seen), then the tier, roots,
denylist and approval against its **own** policy file. The hub never sends policy. Each call
lands in the hub journal (event `operator_call`, redacted arguments, hashes) and in the host's
hash-chained journal.

## Tiers on each host

| Tier | Scope (Pocket ID) | lab (`operator-vps`) | Mac (`operator-mac`) |
|---|---|---|---|
| T0 read | `operator:read` | policy, state, list, read, search, journal and docker logs of declared units and containers, service status, job status, approval status, freeze status, audit verify | the same, without logs and service status (no journald, no systemd: `logs_unavailable_on_host`, `systemd_unavailable_on_host`) |
| T1 write | `operator:write` | edit (presets, backup, atomic), upload, move, copy, delete with backup, chmod, inside the write roots; `operator_grant` (standing approvals, answered by the hub) | the same, inside the whole home and `/tmp` minus the denylist (owner decision 2026-10-14); writes under `~/Library/LaunchAgents` ask |
| T2 exec | `operator:exec` | `operator_run` argv and `operator_script` (bash, zsh, sh, python3, node) as `memo-operator` (no sudo, no docker group), each in its own process group killed at the timeout; `operator_service` start, stop, restart, reload of declared units through polkit; `operator_docker` through the root helper | `operator_run` and `operator_script` as `memo`, the owner's own user, with `HOME`, the agent's `SSH_AUTH_SOCK` and `run_path` (pnpm, `~/.local/bin`, Homebrew) first in `PATH` |
| T3 root | `operator:root` | `operator_run as_root`, `operator_script as_root` (bash, python3), each in a transient `systemd-run` unit with `RuntimeMaxSec`, `MemoryMax=2G`, `TasksMax=512`, through the root helper | the same two tools, through the LaunchDaemon `dev.memolabs.memo-operator-root`: each call in its own process group, killed at the timeout, `PATH` limited to system directories, no memory limit; without the helper installed, `root_unavailable_on_host` |

Reads cover the read roots (`/` on lab, `~` on the Mac) minus the secret denylist: `.ssh`,
`.gnupg`, `.env*`, `*.pem`, `*.key`, `*.p8`, `id_*`, `*secret*`, keychains, credential stores,
`~/.config/**/secrets/**`, `~/.aws`, `~/.netrc`, browser profiles and cookies, Mail, Messages,
group containers, `~/.memo-operator` and `/etc/memo-operator`. Command output and file content
pass a token redactor and come back wrapped as untrusted data.

## Default host and operator locks (multi-session)

- `host` is optional: without it the hub uses `mac` when the `operator-mac` agent is connected,
  else `vps`. `as_root`, `operator_script` and every call on the dangerous list must name it
  (`host_required`, detail "Mac ou VPS ?"). Every result carries the `host` it ran on.
- Locks (`operator_lock`, `operator_unlock`) live in the hub's memory for both hosts. A remote
  conversation's T1 to T3 call names its `workspace_id` and needs a covering lock of that
  workspace (`workspace_required`, `lock_required`); another workspace's overlapping lock answers
  `locked_by_other_session`. The 9443 principals need no workspace and are refused only under
  another workspace's lock. Locks are saved in the hub's state directory (`MEMO_BRIDGE_HUB_STATE_DIR`, or `StateDirectory=` on lab, `bridge/hub-state.mjs`) and survive a hub restart; implicit
  per-call locks do not. Details: `docs/REMOTE_CHATGPT.md`,
  "Ten conversations at once".

## Tools repatriated from SentinelX (part 2, 2026-10-14)

Spec: `.agent/project/repatriate-tools/spec.md`. Parity study:
`workspace/research/2026-10-14-sentinelx-parity.md`.

| Tool | Tier | Runs on | What it does |
|---|---|---|---|
| `operator_snapshot` | T0 | host agent | orientation of any directory in the read roots: git branch, upstream, ahead/behind, changed and untracked counts, 10 recent commits, tree summary (depth 4, 20 000 entries, 5 s), project markers, README head (4 KiB, untrusted) |
| `operator_read_media` | T0 | host agent | png, jpeg, gif, webp (by content) and PDF pages, as MCP image content plus a text part (metadata, PDF page text) |
| `operator_help` | T0 | hub | topics, then details; reviewed playbooks: `read_logs`, `restart_stack`, `free_disk`, `deploy_check`, `git_sync`, `backup_status`, `rotate_key`, `freeze` |
| `operator_transfer` | T1 | hub, both agents | copy one file, up to 512 MiB, Mac to lab, lab to Mac or within one host |
| `operator_transfer_status` | T0 | hub | progress or outcome of a transfer that answered `running` |
| `operator_upload_init` `stage:true` + `operator_edit` `old_upload_id` / `new_upload_id` | T1 | host agent | edit content larger than one call (8 MiB at most, 64 KiB chunks) |

**Transfer.** The hub reads the source in 64 KiB chunks through two internal ops signed for the
caller (`operator_transfer_source`: read roots, denylist, `O_NOFOLLOW`, size and SHA-256 computed
on the source host; `operator_read_chunk`: refused with `source_changed` when the file moved),
and writes them through the destination's own `operator_upload_*`. So the destination keeps every
upload rule: write roots, denylist, `use_dev_flow`, the caller's workspace and a lock on
`dst_path` (the caller's, else an implicit one held for each write, see below), the hub freeze, the approval mode, a backup on overwrite, an atomic rename, and the
SHA-256 checked at the destination. Why: a 64 KiB chunk is 87 KiB of base64, under the 128 KiB
request cap and the 128 KiB agent result bound; the 16 KiB frame limit is met by the protocol's
`part` frames. No new frame type or protocol version. Four lanes per transfer, two transfers per
hub; the call waits 20 s, then answers `{status: "running", transfer_id}`. A hub restart loses a
running transfer and places nothing (the staged upload expires after one hour). Both hosts and the
hub journal every chunk. Base64 payloads (chunks, images) skip the text redactor, which could
corrupt them; their size is bounded by the tool.

**Media.** The file is read once through an `O_NOFOLLOW` descriptor and only that private copy is
converted (a path swapped after the check is never rendered). Bounds: image file 20 MiB, PDF
50 MiB, 5 pages and dpi 36 to 150 per call, 560 KiB of image bytes per result (`next_page`
continues), 8 KiB of text per page. Images above the budget are downscaled with `sips` on the Mac;
on lab they answer `too_large` (transfer them to the Mac). PDF pages: PDFKit through
`osascript -l JavaScript` (a fixed script in `bridge/operator-media.mjs`) on the Mac;
`pdfinfo`, `pdftotext` and `pdftoppm` (package `poppler-utils`) on lab, else
`pdf_tools_unavailable`. ChatGPT: OpenAI support said on the developer forum (2026-04-22) that an
MCP image block is valid but "ChatGPT connector output isn't guaranteed to become model-visible
image input"; the text part comes first and always carries the metadata and the PDF text.

**Snapshot and git.** git runs with fixed argv, `GIT_OPTIONAL_LOCKS=0`, no system or global
config, `core.fsmonitor` and `log.showSignature` off, submodules ignored. git's own
`safe.directory` check is kept: in a repository owned by another user (most of lab for
`memo-operator`) git refuses to read its config, and the snapshot reports the branch from
`.git/HEAD` only (`partial: owned_by_another_user`).

**Help and playbooks.** Static text in `bridge/operator-help.mjs`, reviewed with the code. A test
checks that every step names a real tool with real argument names and that no playbook edits a
policy, a root list or an allowlist, or works around a refusal.

**Memory across conversations** (`memory_save`, `memory_search`, `memory_get`, `memory_list`) is a
runtime feature, not an operator one: `docs/COORDINATOR.md` and the server instructions describe
it; the store is the coordinator SQLite (schema v5) on the host that runs the runtime.

## Job notifications and log tails (issues #35, #44)

Spec: `.agent/project/notify-tail/spec.md`.

| Tool or option | Tier | Runs on | What it does |
|---|---|---|---|
| `operator_run`, `operator_script` `background: true, notify: true` | as the call | hub watches, host runs | when the job ends: one Telegram message to the owner chat and one notice in the caller's inbox |
| `jobs_submit` `notify: true` | runtime | hub watches, runtime runs | the same for a test, build or lint job started through the hub (remote chats, 9443) |
| `notifications_check` | T0 | hub | counts of the caller's inbox: unread, total, jobs still watched; also in `sessions_overview` as `notifications` |
| `notifications_get` | T0 | hub | the newest unread notices (or one by id, or with `include_acked`): kind, host, job id, status, exit code, duration, last output lines (redacted, untrusted) |
| `notifications_ack` | T0 | hub | mark notices as read (`notification_ids` or `all: true`); changes only the caller's inbox |
| `operator_read` `tail_lines` | T0 | host agent | exactly the last N lines (1 to 2000) of a file, read from its end |

**notify is the hub's.** It is removed from the arguments before the approval hash and the
signature: the host never sees it, and an approved call matches with or without it. The hub
watches the job by polling its own read tool every 20 s with the starter's principal
(`operator_job_status`, signed T0, so each poll is in both journals; `job_status` for runtime
jobs). A foreground call with `notify` answers `notify: {registered: false, reason: "foreground"}`.
Bounds: 200 watches, 20 per principal (`too_many_watches`, the job still runs); a watch ends as
`watch_expired` 30 min after its job's timeout (plus 4 h of queue for runtime jobs), and as
`unknown` after three permanent errors in a row (`unknown_job`, `forbidden`).

**Telegram.** One message per finished job, to `MEMO_BRIDGE_TELEGRAM_CHAT_ID` only, without
buttons: status, host, op or recipe, job id, exit code, duration, principal, at most 5 output
lines of 160 characters, redacted (`redactSecrets`) on the host and again in the hub. No tool
takes a chat id or a recipient. Without the bot, or when `sendMessage` fails, the notice is still
in the inbox (`telegram: unavailable` or `failed`) and the hub journals `notification_unsent`
with the reason; a delivered one is journaled `notification_sent`.

**Inbox.** Saved in the hub's state directory (`MEMO_BRIDGE_HUB_STATE_DIR`, or `StateDirectory=` on lab, `bridge/hub-state.mjs`), like grants, locks and the `/freeze` flag: the last 50 notices
per principal, 256 principals. The inbox, its acks and the watches of running notify jobs survive
a hub restart; a restored watch is polled again and notifies once. Without a state directory they
live in memory and a restart drops them. The results themselves stay on the hosts and in the
runtime store (`operator_job_status`, `job_status`, `job_results`). A principal
reads and acknowledges only its own notices.

**tail_lines.** The file is resolved by the same read policy and denylist as a byte read, then
read backwards in 16 KiB chunks until N line ends are found, within one window of 128 KiB (or
`max_bytes` when smaller): a 10 MB log costs one window, never the file. A final newline ends the
last line. When the last N lines are larger than the window, the complete lines that fit come
back with `truncated: "max_bytes"` and `offset` to continue backwards. `tail_lines` and `offset`
are exclusive (`invalid_arguments`). Redaction and the 128 KiB result bound are unchanged.

## Read-only commands, implicit workspace and implicit locks

Live bench of 2026-10-14 (19:57 and 20:04): "the 5 most CPU-hungry processes on the Mac" and
"create ~/memolabs/workspace/bench-mb/note.md" each took one SentinelX call and failed here. Now:

- **Read-only commands** run at once, with no workspace, no lock and no approval, even when the
  program is a wrapper: `ps`, `top -l 1` (or `-b`), `uptime`, `vm_stat`, `df`, `du`, `ls`,
  `stat`, `file`, `wc`, `head`, `tail`, `cat`, `grep`, `rg` (no `--pre`), `find` (no `-exec`,
  `-delete`, `-fprint`), `git status`, `log`, `diff`, `show`, `branch` (listing), `rev-parse`,
  `ls-files`, `blame`, `config --get`, `gh` read verbs and `gh api` GET, `uname`, `sw_vers`,
  `system_profiler <DataType>`, `launchctl list` or `print`, `systemctl status`, `show`,
  `list-*`, `journalctl` (no vacuum or rotate), `docker ps`, `logs`, `inspect`, `free`,
  `ip ... show`, `ss` (no `-K`), `hostname`, `date +fmt`, `sysctl` reads
  (`bridge/operator-dangerous.mjs readOnlyCommand`). Any write-capable flag makes the call a
  normal command again. They stay T2: signed, rate limited, in both journals (`read_only: true`
  on the hub line). The agent checks every path-like argument (absolute, `~`, or relative to the
  cwd) against the read roots and the denylist (`path_secret`, `path_not_allowed`), and runs
  read-only git with `core.fsmonitor=false`, `core.pager=cat`, `GIT_OPTIONAL_LOCKS=0`,
  `--no-ext-diff` and `--no-textconv`.
- **Writes just work.** A remote write, command or root call without a `workspace_id` uses the
  conversation's workspace, keyed by its session hash: its own active one, else one opened on
  the project `ops` (`MEMO_BRIDGE_OPERATOR_AUTO_PROJECT`, journaled `workspace_auto_open`), else a
  coordination id derived from the session (`workspace_implicit`). Without an explicit lock the
  call takes an **implicit lock** on its path, unit or container (global for root calls,
  scripts and commands without cwd) for the duration of the call only (`lock_implicit`), and is
  refused with `locked_by_other_session` only when another conversation holds an overlapping
  lock. Explicit `operator_lock` stays for long multi-step work. The result carries `auto`.
  Without a session hint (stdio, 9443) nothing changes.
- `workspace_open` from ChatGPT with `host: "mac"` no longer fails: the workspace (a
  coordination record) lives on the vps runtime, the requested host is kept in its label, and the
  result says so in `note`. Operator tools still act on the host they name.
- Refusals that the model can fix carry `next_step`.

## Standing approvals (owner decision 2026-10-14)

Measured on SentinelX over 1.5 days: `gh` 632, `git` 441, `ssh` 185 calls. Asking Telegram for
each `git`, `node`, `pnpm`, `python3`, `make` or `ssh` call would have been about 780 prompts.

1. At the start of a work session ChatGPT calls, once,
   `operator_grant {action: "request", host, programs: ["git","node","pnpm","python3","make","ssh"], cwd_prefixes: ["~/memolabs"], ttl_hours: 8}`.
   The bot sends the owner the request with Approve and Deny, and says plainly what it means:
   a wrapper can run any command as the agent user, and `ssh` to lab is root on lab.
2. Once approved (TTL 1 to 12 h), an `operator_run` or `operator_script` call that is not
   `as_root`, whose `cwd` is under a prefix and whose wrapper and remote programs are all named
   (`timeout 5 ssh lab id` needs `timeout` and `ssh`; a script needs its interpreter) runs
   without a prompt. Both journals carry the grant id (`ap_st_...`).
3. The owner can also type `/grant mac git,node,pnpm ~/memolabs 8h` in the bot chat (active at
   once), list with `/approvals`, and end with `/revoke <id>` or `/revoke all`. ChatGPT sees them
   with `operator_grant {action: "list"}`, in `operator_policy` and in `sessions_overview`, and
   may revoke its own.
4. Never covered, always one prompt per call: the hard list below, every `as_root` call,
   `operator_docker` stop or restart of `traefik`, `memo-*`, `pocket-id*`. A grant can never name
   `/` as a prefix, nor `sudo`, `su`, `doas`, `rm`, `dd` and the other destructive programs.
   The agent and the root helper refuse a standing id on a hard or root call themselves
   (`approval_scope`), whatever the hub signed.
5. Grants are saved in the hub's state directory (`MEMO_BRIDGE_HUB_STATE_DIR`, or `StateDirectory=` on lab, `bridge/hub-state.mjs`) and survive a hub restart, active or still pending, until
   they expire or are revoked. Without a state directory a restart drops them; ask again.

## Permanent grants (owner decision 2026-10-14 21:29, issue #48)

Everyday programs asked too often even with standing approvals. A permanent grant is a standing
approval with no TTL, written by the owner in the host policy file (`permanent_grants`), never by
a tool: `operator_grant` cannot make, extend or revoke one, and the policy file is root-owned on
lab and 0444 under the denied `~/.memo-operator` on the Mac.

| Host | Programs | Under | Set by |
|---|---|---|---|
| Mac | `python3`, `node`, `bash`, `zsh`, `git`, `pnpm`, `npm`, `make` | `~/memolabs` | `deploy/mac/operator-mac.mjs` (`macPolicy`, `PERMANENT_PROGRAMS`) |
| lab | the same | `/srv`, `/opt` | lab-infra `memo_operator_permanent_programs`, `memo_operator_permanent_prefixes` (switch `memo_operator_permanent_grants`) |

- Coverage is exactly a standing approval's: `operator_run` or `operator_script` as the agent
  user, with a `cwd` under a prefix, every wrapper and remote program of the call named. The hard
  list and every `as_root` call still ask each time; `ssh` is not in the defaults.
- The loader refuses (the agent and the root helper then refuse to start) an entry that names a
  hard-listed program (`rm`, `dd`, `mkfs*`, `kill`, disk and user tools...), a privilege tool
  (`sudo`, `su`, `doas`, `pkexec`, `runuser`, `chroot`, `nsenter`), a path instead of a bare
  name, `/` as a prefix, another host, or any other key (`as_root`, `root`, `ttl_hours`). At most
  8 entries, 16 programs and 4 prefixes each.
- Each entry gets a stable id `ap_pm_<hash of host, programs, prefixes>`. The hub reads the
  entries from the agent's `operator_policy` (on need, at most every 5 minutes and after each
  reconnect) and signs a covered call with that id instead of asking Telegram. The agent checks
  the id against its own file and answers `approval_scope` when that grant does not cover the
  call; the root helper refuses any `ap_pm_` id. A stale or forged hub copy never widens a grant.
- Journals: the hub's `operator_call` line carries `approval_id: ap_pm_...` and
  `approval_source: "permanent"` (`single_use` and `standing` for the others); the host journal
  carries the `ap_pm_` id. `operator_policy` (`policy.permanent_grants`) and `sessions_overview`
  (`permanent_grants`) show them with `source: "permanent"` and `expires_at: null`.
- To change one: edit the defaults above, then rerun the Mac installer
  (`deploy/mac/install-operator-agent.sh --install`, which rewrites the policy and restarts the
  agent) or `make deploy-memo-operator`. lab-infra refuses to render them for a pinned
  `memo_bridge_version` whose loader predates them.

Hard list additions (repatriation D-R1 to D-R3, D-R9), wherever the program appears in argv and
inside the strings of shells and `ssh`: `gh pr merge`, `gh repo delete|archive|rename|edit`,
`gh release delete`, `gh secret`, `gh variable set|delete`, `gh auth`, `gh ssh-key`,
`gh gpg-key`, `gh extension`, `gh alias`, `gh workflow run|enable|disable`, `gh run delete`,
`gh issue delete`, `gh api` with DELETE, or POST, PUT, PATCH on a protected endpoint (merge,
refs, branches and protection, rulesets, collaborators, hooks, keys, secrets, variables,
environments, deployments, dispatches, the repository itself, orgs, user), `gh api graphql` with
a mutation or `--input`; `git push` with `-f`, `--force`, `--force-with-lease`, `--delete`,
`--mirror`, `--prune`, `--all`, a `+` or `:` refspec, or a destination `main` or `master`;
`git reset --hard`, `git clean -f`, `git branch -D`, `git filter-branch`, `filter-repo`,
`reflog expire`, `update-ref -d`, `stash clear`; `rsync --delete*` and `--remove-source-files`;
`docker rm`, `rmi`, `prune`, `volume rm`, `compose down -v`. Free: `gh` reads and other `gh`
writes (`pr create`, `issue comment`).

**ssh, scp, rsync.** `ssh`, `scp`, `sftp`, `mosh`, and `rsync` to a remote (`host:path`, `-e`,
`--rsh`, `--rsync-path`) are dangerous and grantable (`remote:<program>`), and need an explicit
`host` (`host_required`). `ssh lab` opens a root shell on lab: treat a grant naming `ssh` as root
on lab for its duration. Local `rsync` between paths is free.

## Docker on lab (`operator_docker`)

Without the docker group: the root helper speaks to `/var/run/docker.sock` with the Docker
Engine API (`/v1.44`; lab answers 1.40 to 1.56, read 2026-10-14). Actions: `ps`, `inspect`
(projected: never `Config.Env`, only compose labels), `logs` (last lines, `since` like `-2h`,
redacted), `compose_ps` (projects, or one project's containers), and `restart`, `stop`, `start`
of a container from the live list. T2 (`operator:exec`); a mutation holds a container lock;
stop or restart of `traefik`, `memo-*`, `pocket-id*` asks the owner. No `run`, `exec`, `pull`:
`operator_run as_root ["docker", ...]` stays T3 with approval. On the Mac:
`docker_unavailable_on_host`.

## Approval flow (`approval_mode: dangerous`, both hosts)

1. A call on the dangerous list answers `pending_approval` with an `approval_id`: any script;
   `rm`, `dd`, `mkfs`, firewall tools, `kill`, `passwd` and the like anywhere in argv; a shell,
   interpreter or wrapper as the program (`bash`, `python3`, `env`, `find`, `sudo`, `sed`, `awk`,
   `docker`, `git`, package managers, and on the Mac `osascript`, `launchctl`, `open`,
   `security`); `/etc/ssh`, `/etc/sudoers*`, `/etc/pam.d`, `/etc/passwd`, `/etc/shadow` (also
   spelled `/private/etc/...`); the agent's own control files (`.memo-operator`,
   `/etc/memo-operator`) and `~/Library/LaunchAgents`; stop or disable of `ssh`, `traefik`,
   `memo-bridge-*`; every recursive delete. For Mac root: `diskutil`, `hdiutil`, `asr`,
   `csrutil`, `nvram`, `bless`, `fdesetup`, `sysadminctl`, `dseditgroup`, `pfctl`, `tccutil`,
   `spctl`, `kextload`, `kmutil`, `systemsetup`, `softwareupdate`, `pmset` anywhere in argv;
   `dscl` with a writing verb (`-create`, `-delete`, `-passwd`, `-append`...; `-read` and `-list`
   do not ask); any path under `/Library/LaunchDaemons`, `/var/db/dslocal`, or the root
   helper's own files (`/Library/Application Support/MemoBridge`, `/var/log/memo-operator`,
   `/var/db/memo-operator-root`, `/var/run/memo-operator`). `rm` always asked, recursive or not,
   and `launchctl` is a wrapper, so `launchctl bootout system/...` asks too.
2. The bot sends the owner chat the call, with Approve, Deny, and "this exact command for
   15 min". The approval binds the SHA-256 of the exact arguments and the principal; it expires
   after 10 min. `confirm: true` from the model counts for nothing.
3. The model polls `approval_status`, then repeats the same call, which runs once.

Without a configured bot the dangerous calls answer `approval_unavailable` (fail closed). The
host checks the signed approval id itself, so a hub set to `off` cannot unlock a host set to
`dangerous` (`approval_required`).

## Freeze and unfreeze

Any one switch stops every call above T0 on the next call; reads keep working.

| Switch | Freezes | Set | Lift |
|---|---|---|---|
| Telegram `/freeze` (owner chat only) | the hub flag: both hosts | `/freeze` | `/unfreeze` (also clears the hosts' auto-freeze markers through a signed internal op); `/status` shows it |
| hub file `/etc/memo-bridge/operator-FROZEN` | both hosts, survives a hub restart | `make memo-operator-freeze` (lab-infra) | `make memo-operator-unfreeze` |
| lab file `/etc/memo-operator/FROZEN` | lab | `make memo-operator-freeze` | `make memo-operator-unfreeze` |
| Mac file `~/.memo-operator/FROZEN` | the Mac, its root helper included | `touch ~/.memo-operator/FROZEN` | `rm ~/.memo-operator/FROZEN` |
| Mac root file `/Library/Application Support/MemoBridge/operator-root/FROZEN` | Mac root only; only root can lift it | `sudo touch "/Library/Application Support/MemoBridge/operator-root/FROZEN"` | `sudo rm` of the same path |
| auto-freeze: 5 signature or policy refusals in 5 min | that host (or the root helper) | automatic, marker `AUTO-FROZEN` in the state directory | read the journal first; `/unfreeze`, or `make memo-operator-unfreeze auto=1` on lab, or `rm ~/.memo-operator/state/AUTO-FROZEN` on the Mac |
| agent key removed from the hub | that agent, entirely | remove `operator-mac.pub` or `operator-vps.pub` from `/var/lib/memo-bridge/secrets`, restart the hub | put it back |

The hub flag set by `/freeze` is saved in the hub's state directory (`MEMO_BRIDGE_HUB_STATE_DIR`, or `StateDirectory=` on lab, `bridge/hub-state.mjs`) before it is journaled: a hub restart or a
deploy keeps the hub frozen (journal `operator_frozen` with `by: restored`) until `/unfreeze`.
Without a state directory it lives in memory and a restart drops it. The files stay the switches
no tool can lift. The model has no freeze or unfreeze tool.

## Install on the Mac (TODO-P6-13)

The operator agent is a second launchd job next to the probe agent, through the same tunnel
(`dev.memolabs.memo-bridge-tunnel`, 127.0.0.1:9444 to lab 127.0.0.1:9443). It runs a pinned
bundle under `~/.local/share/memo-bridge/operator`, never the Git checkout: `~/memolabs` is a
write root, and the code that enforces the policy must not sit inside one.

```
cd ~/memolabs/os/core/bridge            # a checkout of the commit to install, pnpm install done
ssh lab cat /etc/memo-operator/operator-hub.pub > /tmp/operator-hub.pub
deploy/mac/install-operator-agent.sh --hub-pub /tmp/operator-hub.pub
# lab-infra copies ~/.memo-operator/operator-mac.pub to the hub and restarts it:
make -C ~/memolabs/lab/infrastructure deploy-memo-operator
deploy/mac/install-operator-agent.sh --install
launchctl print gui/$(id -u)/dev.memolabs.memo-operator-agent | head -20
tail ~/Library/Logs/memo-operator/stderr.log   # operator_ready, then no reconnect_scheduled
```

Without `--install` the script writes only `~/.memo-operator`, the bundle and the logs folder,
and stages the plist in `~/.local/share/memo-bridge/operator/launchd/`. It prints the public key
path, never the private key. Rerunning it is safe: it changes only what differs, keeps the key,
and keeps a replaced policy as `policy.json.<ts>.bak`. `--uninstall` unloads the job and
removes the plist; keys and logs stay.

| File | Mode | Role |
|---|---|---|
| `~/.memo-operator/` | 0700 | configuration, denied to the agent's own tools |
| `agent.key` | 0600 | Ed25519 identity of `operator-mac`, same generator as the probe agent's key |
| `operator-mac.pub` | 0444 | its public half, read by lab-infra (`memo_operator_mac_pub_path`) |
| `hub-ca.crt` | 0444 | the hub TLS CA, copied from `~/.config/memo-bridge/hub-ca.crt` |
| `operator-hub.pub` | 0444 | the hub's operator signing key (one or more PEM blocks) |
| `policy.json` | 0444 | the Mac policy: `max_tier: exec`, `approval_mode: dangerous`, roots, denylist, `repositories` read from `~/memolabs/PROJECTS.md`, Path relative to `~/memolabs` (`MEMOLABS_ROOT`) |
| `state/` | 0700 | background runs, uploads, the auto-freeze marker |
| `~/Library/Logs/memo-operator/audit.jsonl` | 0600 | the Mac's hash-chained journal |

A policy change is a rerun of the script and a restart (`--install` restarts the job). The
agent reads the policy and the hub key once at start and refuses to start on any problem with
them (owner, mode, unknown key, wrong host).

## Root on the Mac (owner decision 2026-10-14)

Root on the Mac goes through a second, separate process: the LaunchDaemon
`dev.memolabs.memo-operator-root`, running as root. It runs from a **root-owned copy** (code,
node, policy, hub key), never from the home folder: whatever `memo` can edit, a compromise of
`memo` could edit, and root would then run it. It accepts only calls signed by the hub operator
key (its own copy), checks its own root policy (`max_tier: root`, `approval_mode: dangerous`,
refused with `off`), both FROZEN switches, its rate limit and auto-freeze, then runs the argv
without a shell, or the script from a root-only file. The agent forwards `as_root` and
`operator_script` only while the helper's socket exists.

| Path | Owner, mode | Role |
|---|---|---|
| `/Library/Application Support/MemoBridge/operator-root/` | root:wheel 0755 | the root-owned tree; the helper refuses to start if it or any parent is not root-owned or is group or other writable |
| `.../bin/node` | root:wheel 0555 | a copy of the official node the agent runs; the install refuses a node that links libraries outside `/usr/lib` and `/System` (Homebrew's node links `/opt/homebrew`, which `memo` can rewrite) |
| `.../bridge/operator-root-mac-cli.mjs`, `operator-job-supervisor.mjs`, `package.json`, `VERSION` | root:wheel 0444 | the bundle (`scripts/build-operator.mjs --root`) and the commit it came from |
| `.../policy.json` | root:wheel 0444 | host `mac`, `max_tier: root`, `approval_mode: dangerous`, read root `/`, the Mac denylist, the repository guard |
| `.../operator-hub.pub` | root:wheel 0444 | copy of `~/.memo-operator/operator-hub.pub` made at install |
| `/Library/LaunchDaemons/dev.memolabs.memo-operator-root.plist` | root:wheel 0644 | `UserName root`, `KeepAlive`, `ThrottleInterval 30`, `Umask 077` |
| `/var/run/memo-operator/root.sock` | dir root:wheel 0755, socket memo 0600 | made at each start; macOS checks the socket's write permission on connect, so only `memo` and root connect |
| `/var/log/memo-operator/audit.jsonl`, `helper.log` | root 0600 in a 0700 dir | the root hash-chained journal, and the helper's log |
| `/var/db/memo-operator-root/` | root 0700 | scripts, background root runs, `AUTO-FROZEN` |

Install, in this order (the root helper first, then the agent, so the agent's policy picks it up):

```
cd ~/memolabs/os/core/bridge                     # a checkout of the commit to install, pnpm install done
deploy/mac/install-operator-root.sh              # dry run: read the plan, the policy, the plist, the hub key id
ssh lab cat /etc/memo-operator/operator-hub.pub > /tmp/lab-hub.pub
node deploy/mac/operator-mac.mjs hub-key-id --from /tmp/lab-hub.pub   # same key id as the dry run
sudo deploy/mac/install-operator-root.sh --install
deploy/mac/install-operator-agent.sh --install   # as memo: policy becomes max_tier root, agent restarts
sudo launchctl print system/dev.memolabs.memo-operator-root | head -20
sudo tail /var/log/memo-operator/helper.log      # root_helper_ready
```

`--install` builds the bundle and renders the policy and plist as you (`$SUDO_USER`), never as
root, then copies them root-owned with `install -S`, runs the copied helper with `--check`, and
only then writes the plist and runs `launchctl bootstrap system`. Rerunning it is safe; it keeps
the root FROZEN file. After a hub key rotation, rerun it (it copies the key again).

Freeze Mac root only: `sudo touch "/Library/Application Support/MemoBridge/operator-root/FROZEN"`.
`touch ~/.memo-operator/FROZEN` freezes the agent and the root helper together; Telegram
`/freeze` and the hub file stop both at the hub.

Uninstall: `sudo deploy/mac/install-operator-root.sh --uninstall` (bootout, removes the plist,
the root tree, the state and the socket; keeps `/var/log/memo-operator`), then
`deploy/mac/install-operator-agent.sh --install` as `memo` so the agent's policy goes back to
`exec`.

## Key rotation

- **Mac identity**: `mv ~/.memo-operator/agent.key ~/.memo-operator/agent.key.old`, rerun the
  script (new key, new `operator-mac.pub`), `make deploy-memo-operator` in lab-infra (copies it,
  restarts the hub), then `--install`. Delete the `.old` file once the agent connects.
- **lab identity and hub signing key**: lab-infra `docs/memo-operator.md`, "Keys". After a hub
  signing key rotation the Mac needs the new public half: fetch it as above, rerun with
  `--hub-pub` and `--install`. To rotate without a gap, put both PEM blocks in the file given to
  `--hub-pub` (the agent accepts several), then drop the old one.

## Recovery

- **The Mac agent does not connect**: `tail ~/Library/Logs/memo-operator/stderr.log`. A policy or
  key error stops it before it connects (`policy_*`, `invalid_operator_policy:<field>`); launchd
  retries every 30 s. `reconnect_scheduled` only means the tunnel or the hub is down: check
  `launchctl print gui/$(id -u)/dev.memolabs.memo-bridge-tunnel`.
- **The hub refuses the agent**: `operator-mac.pub` is not in `/var/lib/memo-bridge/secrets` or the
  hub was not restarted after the copy.
- **Everything answers `frozen`**: check the four switches above in that order: `/status`, the
  hub file, the host file, the `AUTO-FROZEN` marker. Read the journal before lifting an
  auto-freeze: it fired on signature or policy refusals.
- **The Mac must be cut off now**: `touch ~/.memo-operator/FROZEN`, then
  `deploy/mac/install-operator-agent.sh --uninstall` and
  `sudo deploy/mac/install-operator-root.sh --uninstall`. From the phone: `/freeze`.
- **The Mac root helper does not start**: `sudo tail /var/log/memo-operator/helper.log` names
  the check that failed (`root_dir_untrusted:...`, `policy_*`, `approval_mode off`...); the
  agent answers `root_unavailable_on_host` meanwhile. Rerun the `--install`.
- **Verify a journal**: `operator_audit_verify` reports the first broken line.

## Limits, stated plainly

- **A compromise of the hub signing key now means root on the Mac.** The key lives on lab;
  whoever is root there, or reads that key, can sign any call both Mac policies allow,
  including `operator_run as_root` and `operator_script` on the Mac. What still stands in the
  way: the Telegram approval for the dangerous list (the Mac checks the signed approval id
  itself, but the key holder signs that too, so against a key compromise approval is no
  barrier), the two FROZEN files, the rate limit, and both journals. Before the root helper the
  same compromise gave `memo`; `memo` was already admin on this Mac, so the difference is
  root without a password prompt. Freeze or uninstall the root helper the moment lab is in
  doubt (R-P6-02, R-MR-11, accepted by the owner on 2026-10-14).
- **Mac root bounds.** Each root call is killed at its timeout with its whole process group,
  but a root program can leave its group on purpose (`setsid`, a launchd job) and macOS has no
  cgroup to catch it; there is no memory limit (`setrlimit(2)` on macOS has no enforced memory
  cap). SIP still protects `/System` and the like from root; TCC still applies to the daemon: do
  not grant it Full Disk Access. A program named by absolute path under `/opt/homebrew` or
  `/usr/local` runs as root as given; bare names resolve in system directories only.
- **`sudo` on the install script** runs that script, from your checkout, as root. Run it only
  from a checkout you trust, on a commit you read.
- **A standing approval on a wrapper is any command.** `bash`, `python3`, `node`, `make`,
  `pnpm` or `git` can run anything as the agent user; `ssh` is root on lab. The cwd prefix bounds
  where a call starts, not what it touches. The hard list still asks, but an argv classifier
  cannot see inside scripts, `make` targets, package scripts or `ssh` strings beyond their words.
- **A permanent grant on an interpreter is owner power without a prompt.** Under `~/memolabs` on
  the Mac (and `/srv`, `/opt` on lab) `python3 -c ...` or `bash script.sh` may do anything the
  agent user can. On the Mac the agent user is the owner, who owns the 0444 policy: such a call
  can rewrite `~/.memo-operator/policy.json`, and the change takes effect at the agent's next
  start. lab's policy is root-owned and out of reach. A root-owned Mac policy would close this.
- **Whole home writable on the Mac.** The T1 tools may now rewrite `~/.zshrc`, `~/.gitconfig`
  and the like; the denylist keeps keys, keychains, browser profiles, `~/.memo-operator` and the
  agents' own code under `~/.local/share/memo-bridge` out of reach.
- **T2 on the Mac is the owner's user.** `operator_run` can do what `memo` can do, including
  rewriting `~/.memo-operator` (the directory is the owner's). The read-only policy stops the T1
  tools, not a command. What stands in the way: approval for wrappers and for any argument
  naming the control files or `~/Library/LaunchAgents`, the journal, and the hub freeze, which
  does not depend on the Mac. An argv classifier cannot see everything a program does
  (`cp`, `mv` and `chmod` on other paths do not ask).
- **Prompt injection.** A file or a log can tell the model to run something. Results are marked
  untrusted and the dangerous list asks the owner, but a call off that list runs. Freeze if a
  conversation behaves oddly.
- **macOS privacy (TCC).** A launchd job does not hold Full Disk Access: Mail, Messages, Safari
  and other protected folders fail with a permission error even where the policy would allow.
  Do not grant it Full Disk Access.
- **Node path.** The plist names the absolute node that ran the install (an nvm path today). If
  that version is removed, the job fails to start: rerun the script with the new node.
- **Pending approvals live in hub memory**: a hub restart drops them, since the call waiting for
  them ended with the process. The `/freeze` flag, grants, locks, the notification inbox and the
  watches are durable with a state directory, as are the FROZEN files.
- **Transfers move data between the hosts.** A file readable on one host can be written on the
  other, inside its write roots. The source denylist and roots, the destination lock and both
  journals are the barriers; there is no content filter on what a transfer carries.
- **PDF rendering parses untrusted files** (PDFKit on the Mac, poppler on lab), out of the agent
  process, on a private copy, with a 30 s timeout per step.
