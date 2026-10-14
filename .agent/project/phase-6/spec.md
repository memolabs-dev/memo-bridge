# Phase 6 specification: operator access on the Mac and the VPS (Memo Labs OS)

Status: SPECIFICATION, 2026-10-14. Branch `feat/phase-6-operator`.
Research base: `research-sentinelx.md` (same folder), a source-level reading of SentinelX
(agent v0.23.17, protocol 1.13.2, installer, website), with file and line citations.

## 0. Sources and trust

- SentinelX sources, read without execution: `research-sentinelx.md` §1 to §6. Every SentinelX
  claim below carries its key there (CORE, PROTO, INST, WEB, SCHEMA).
- Memo Bridge as it runs today: `bridge/protocol.mjs` (wire v2, Ed25519 handshake, 16 KiB
  frames), `bridge/ops.mjs` (op registry, hosts `mac` and `vps`), `bridge/hub-cli.mjs`
  (`mac.pub`, `vps.pub` agent keys), `bridge/remote-surface.mjs` and `bridge/write-gate.mjs`
  (Phase 5 remote surface, write gate), `server/coordinator/policy.mjs` (capabilities).
- EV-P5-01 (2026-10-14): ChatGPT Chat calls write tools with no confirmation prompt. Every
  rule here is enforced by the process that executes, never by a tool description.
- systemd: `systemd-run(1)` (`--wait --pipe --collect -p`), `systemd.exec(5)`
  (`ProtectSystem=`, `ReadWritePaths=`, `MemoryMax=`, `RuntimeMaxSec=`), `polkit(8)` rules.
  To be re-read against Debian 13's installed systemd 257 before TODO-P6-07 (U-P6-03).
- Telegram Bot API: `sendMessage` with `inline_keyboard`, `getUpdates` long polling,
  `callback_query`. To be read at https://core.telegram.org/bots/api before TODO-P6-09.

## 1. Intent

### Goal

Guillaume, from any ChatGPT Chat conversation (Plus, connector "Memo Bridge VPS") or from
Claude Code, can read, write and run commands on his Mac and on the VPS `lab`, including as
root on `lab`, to debug and repair things remotely, the way SentinelX allows, with a better
security model sized for one owner and two hosts.

### Owner's words (2026-10-14)

"je dois pouvoir écrire sur mon Mac et sur mon VPS également, sans restriction, et si j'ai
besoin de débugger des choses à la racine, je dois pouvoir le faire, à distance. Prends exemple
sur SentinelX, faire exactement ce qu'ils font, mais en mieux, et optimisé pour mon cas."

### Non-goals

- Root on the Mac. macOS asks for a password or Touch ID for `sudo`; a `NOPASSWD` sudoers rule
  is a security setting only the owner may add. The Mac agent acts as the user `memo`.
- A multi-tenant SaaS, plan slots, enrollment minting from the chat, cloud provider control
  (DigitalOcean, Cloudflare writes): kept out of the operator surface.
- Replacing the Phase 3 to 5 development flow. Repository work keeps worktree, job, PR,
  auto-merge. Operator tools are for the machine, not for code changes to tracked repos.

### Completion sentence

Phase 6 is complete when a ChatGPT Chat conversation can, through `bridge.memolabs.dev`, read
any non-secret file, edit files, run commands and restart services on `lab` (root included)
and on the Mac (as `memo`), every call lands in a tamper-evident journal, the owner can freeze
everything from his phone in one action, the eight acceptance checks of §6 pass, and the owner
has repaired one real thing remotely.

## 2. What SentinelX does, and what we do better

| Topic | SentinelX (source) | Memo Bridge Phase 6 |
|---|---|---|
| Execution | prefix allowlist over `bash -lc`; starter list holds `bash -lc`, `python3`, `sudo tee` (CORE `policy.py`, `config.example.yaml`) | argv only, never a shell below T3; named templates for common commands; a real shell exists only as `operator_script`, at T3 |
| Hidden exec paths | edit `validator` string executed, git config `core.sshCommand` (CORE `pensa_safe_edit.py`, `git_ops.py`) | validators are named presets only; git network ops stay in the PR flow with the App token |
| Root | sudo opt-in but `NOPASSWD: ALL` (INST `install.sh`) | root only through a root helper that runs each call as a transient `systemd-run` unit with limits, journaled, freezable |
| Hub trust | TLS plus bearer, requests unsigned, `SECURITY.md` claims signing that does not exist | every hub to agent request signed (Ed25519 over op, args hash, tier, host, expiry, nonce); the agent checks signature, freshness, nonce and its own local policy |
| Human approval | none; `confirm=true` set by the model | optional Telegram approval bound to the exact args hash, for a declared list of dangerous patterns; `confirm` never counts |
| Kill switch | disable host in dashboard; agent retries | three layers: Telegram `/freeze` (owner only), a `FROZEN` file per host, key revocation; plus rate limits and auto-freeze on denial bursts |
| Audit | hub keeps metadata 30 days; agent `audit.jsonl` unredacted, writable by the agent | hub SQLite journal plus a hash-chained, root-owned host log the agent cannot rewrite, head anchored in the hub; arguments redacted, output hashed |
| Secrets | output not redacted; `resend_send_email` to anyone; `request_api_key` | secret path denylist on read and search; token pattern redaction before output leaves the host; no arbitrary recipients; no credential minting |
| Prompt injection | nothing specific | every file and command output wrapped as untrusted data; no tool can widen its own policy |
| Updates | `curl | bash` from `main` as root | deploy through lab-infra Ansible (pinned commit, already in place); no self-update tool |
| Good ideas kept | r/rw paths canonicalized before check; atomic edits with backup and presets; delete refused without backup; 128 KiB response bounding with omission pointers; background jobs written to disk before send; `opaque_ref` end to end | same, reimplemented in Node, tested |

## 3. Design decisions

- **D1. Tiers, enforced on the host agent, each one a separate capability.**
  - `operator:read` (T0): state, list, read, search, stat, service status, journal tail.
  - `operator:write` (T1): edit, upload, move, copy, delete with backup, chmod, inside the
    declared rw roots of that host.
  - `operator:exec` (T2): `operator_run` argv as the agent user (`memo` on the Mac,
    `memo-operator` on lab); `operator_service` start, stop, restart, reload of declared units
    on lab through polkit.
  - `operator:root` (T3, lab only): `operator_run` with `as_root`, `operator_script` (bash or
    python3), writes outside the rw roots. Runs through the root helper (D3).
  The ChatGPT connector receives the scopes the owner grants in Pocket ID. The owner asked for
  no restriction, so the default grant for his own account is T0 to T3. A second, read-only
  client can be made later with T0 only.
- **D2. Hosts.** The VPS hub routes to two operator agents, `mac` and `vps`, named by an enum.
  The Mac agent is a launchd user agent that connects out to the hub. Transport: an SSH local
  forward over the existing `lab` alias (no new public port), restarted by launchd (U-P6-01).
- **D3. Root on lab.** The operator agent runs as `memo-operator` (no sudo, no docker group).
  Root calls go over a Unix socket to `memo-operator-root.service`, a small root process that
  accepts only requests signed by the hub key (same check as D4), then starts
  `systemd-run --wait --pipe --collect -p RuntimeMaxSec= -p MemoryMax= ...` with argv, no
  shell unless the op is `operator_script`. The helper writes the host audit log (D7).
- **D4. Signed requests.** The hub signs `{id, op, host, tier, args_sha256, exp, nonce}` with a
  dedicated Ed25519 operator key, separate from TLS and agent keys. Agents and the root helper
  verify signature, `exp` within 60 s, nonce unseen (bounded cache), and the tier against
  their own local policy file. Limit, stated plainly: the hub key lives on lab, so a root
  compromise of lab can sign. Signing protects the Mac and the root helper from anything that
  reaches the hub socket without the key (ingress bug, forged agent traffic), not from lab root.
- **D5. Approval (owner decided 2026-10-14: `dangerous` on lab).** `approval_mode` per host:
  `off`, `dangerous` or `all_root`. In `dangerous` mode a call matching the dangerous list goes
  to Telegram: fixed owner chat, buttons Approve, Deny, Approve this exact command for 15 min.
  The tool answers `pending_approval{approval_id}`; `approval_status` polls it. Approval binds
  to `args_sha256`, expires after 10 min. Dangerous list v1: any `operator_script`; `rm`,
  `dd`, `mkfs`, `wipefs`, `parted`, `fdisk`; writes under `/etc/ssh`, `/etc/sudoers*`,
  `/etc/pam.d`, `/etc/passwd`, `/etc/shadow`; firewall (`ufw`, `nft`, `iptables`); `systemctl`
  stop or disable of `ssh`, `traefik`, `memo-bridge-*`; `userdel`, `passwd`, `chpasswd`;
  `reboot`, `shutdown`; delete of a directory or of more than 20 files. Without a Telegram bot
  configured, `dangerous` refuses those calls with `approval_unavailable` (fail closed).
- **D6. Kill switch.** (a) Telegram `/freeze` and `/unfreeze` from the owner chat set a hub
  flag; the hub then refuses every operator op above T0. (b) `/etc/memo-operator/FROZEN` on lab
  and `~/.memo-operator/FROZEN` on the Mac make the agent refuse everything above T0, checked on
  every call. (c) Removing an agent key in `hub-cli` drops it. Rate limits: T1 120/min, T2
  60/min, T3 20/min per host. Auto-freeze: 5 refusals for policy or signature in 5 min.
  The model has no freeze or unfreeze tool. `operator_freeze_status` is read-only.
- **D7. Audit.** Hub SQLite journal (exists) gains `tier`, `args_sha256`, redacted args,
  `approval_id`, exit code, duration, output hash. Each host keeps
  `/var/log/memo-operator/audit.jsonl` (root, 0600; on the Mac
  `~/Library/Logs/memo-operator/audit.jsonl`), each line hashed with the previous line's hash.
  On lab the root helper writes it, so `memo-operator` cannot rewrite it. The hub stores the
  chain head every 15 min. `operator_audit_verify` recomputes a chain and reports the first
  break.
- **D8. Secrets and untrusted content.** Read, list and search refuse a denylist:
  `**/.ssh/**`, `**/.gnupg/**`, `**/.env*`, `*.pem`, `*.key`, `id_*`, `**/*secret*`,
  `/etc/shadow`, `/etc/gshadow`, `~/Library/Keychains/**`, `/etc/memo-operator/**`,
  `/etc/memo-bridge/*.key`, Docker `.env` files under `/srv`. T3 may read them only through
  `operator_script`, which is approval-gated in `dangerous` mode. Output passes a redactor for
  token patterns (`ghp_`, `github_pat_`, `sk-`, `xox`, AWS keys, JWTs, PEM blocks) before it
  leaves the host. Results carry `{untrusted_content: ...}` with a short boundary note.
- **D9. File writes.** `operator_edit` modes `replace`, `regex`, `block`, `append`, `prepend`,
  `write`, with `dry_run`, `diff`, a backup next to the file (`.memo-bak.<ts>`), ownership and
  mode kept, atomic rename, named validator presets `json`, `yaml`, `nginx`, `systemd`, `sh`,
  `python`, `toml`, `caddy`, `traefik` (each a fixed argv). Delete always backs up first,
  refuses if the backup fails, needs `recursive` for a directory.
- **D10. Bounds.** Results at most 128 KiB, cut head and tail with an `_truncation` block
  listing omitted JSON pointers. `operator_run` default timeout 30 s, max 600 s; past 600 s it
  runs in the background and `operator_job_status` returns the stored result, written to disk
  before it is sent. Search time budget 20 s, 200 results.
- **D11. Repository guard.** On both hosts, a write or a command whose cwd is inside a
  registered project checkout on its default branch is refused with `use_dev_flow`, pointing to
  worktree tools. The operator surface is for the machine; tracked code keeps PR and CI.

## 4. Tools (new, remote and stdio)

All take `host: mac|vps` and `ref?` (correlation id, max 128 chars, journaled).

| Tool | Tier | Notes |
|---|---|---|
| `operator_policy` | T0 | effective policy of a host: tiers, roots, units, approval mode, frozen |
| `operator_state` | T0 | uptime, load, memory, disk, failed units, last boot, docker ps summary |
| `operator_list` | T0 | depth at most 5, glob, hidden, 1000 entries, noise dirs skipped |
| `operator_read` | T0 | range, max 128 KiB, encoding detection, binary flagged |
| `operator_search` | T0 | literal or regex, file glob, 200 results, 20 s budget |
| `operator_logs` | T0 | `journalctl -u <unit>` or docker logs of a declared container, lines at most 2000, since |
| `operator_service_status` | T0 | status, is-active, is-enabled |
| `operator_edit` | T1 | D9 |
| `operator_upload_init` / `_chunk` / `_complete` | T1 | chunks of 256 KiB, sha256 on complete, max 512 MiB |
| `operator_move`, `operator_copy`, `operator_delete`, `operator_chmod` | T1 | both ends in rw roots; delete backs up |
| `operator_run` | T2, T3 with `as_root` | argv array, cwd, env allowlist, timeout, background |
| `operator_service` | T2 | start, stop, restart, reload of declared units (polkit) |
| `operator_script` | T3, lab only | `bash` or `python3`, content at most 64 KiB, runs in a transient unit |
| `operator_job_status` | T0 | background run result |
| `approval_status` | T0 | pending, approved, denied, expired |
| `operator_freeze_status` | T0 | hub flag and host files |
| `operator_audit_verify` | T0 | D7 |

Not provided, on purpose: credential minting, arbitrary email or webhook, policy writes,
unfreeze, self-update, chown below T3 (use `operator_run as_root`).

## 5. Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-P6-01 | Operator agent on lab (`memo-operator`) and on the Mac (launchd, user `memo`) connect to the hub and serve the §4 tools | P0 |
| R-P6-02 | Tier per op checked on the host from its local root-owned policy, after the hub's own check | P0 |
| R-P6-03 | `operator_run` executes argv without a shell; `;`, `|`, `$()`, newlines are plain argument bytes | P0 |
| R-P6-04 | Root calls on lab go only through the root helper, as transient units with time and memory limits | P0 |
| R-P6-05 | Hub signs every operator request; agents and helper refuse bad signature, expired, replayed, or tier above local policy | P0 |
| R-P6-06 | Kill switch: Telegram `/freeze`, FROZEN files, key removal; each stops everything above T0 within one call | P0 |
| R-P6-07 | Hash-chained host audit the agent user cannot rewrite; hub journal with redacted args and hashes | P0 |
| R-P6-08 | Secret denylist on T0 and T1 paths, output redaction, untrusted content wrapper | P0 |
| R-P6-09 | Atomic edits with backup, presets only, delete with backup | P1 |
| R-P6-10 | Approval in `dangerous` mode via Telegram, bound to args hash, fail closed without a bot | P0 (owner chose `dangerous`) |
| R-P6-11 | Rate limits per tier and auto-freeze on denial bursts | P1 |
| R-P6-12 | Responses bounded at 128 KiB with omission metadata; background runs stored before send | P1 |
| R-P6-13 | Repository guard D11 | P1 |
| R-P6-14 | lab-infra role `memo-operator`: users, policy file, root helper, polkit rule, units, log dir, keys; Mac install script for the launchd agent | P0 |
| R-P6-15 | Docs: `docs/OPERATOR.md`, `SECURITY.md` update, ChatGPT skill text, owner runbook for freeze and recovery | P1 |

## 6. Acceptance criteria

| ID | Requirement | Given / When / Then | Verification |
|---|---|---|---|
| AC-P6-01 | R-P6-03 | `operator_run argv:["echo","a;id"]` prints `a;id` and runs no `id` | automated |
| AC-P6-02 | R-P6-02, R-P6-09 | no tool below T3 executes a caller string as code: validator names outside presets refused, edit of `.git/config` in a project refused | automated |
| AC-P6-03 | R-P6-05 | replayed request, modified args, expired `exp`, unknown key: each refused with its code, nothing runs | automated |
| AC-P6-04 | R-P6-06 | with FROZEN present every op above T0 answers `frozen`; Telegram `/freeze` does the same through the hub | automated + runtime |
| AC-P6-05 | R-P6-10 | T3 dangerous call without approval answers `pending_approval`; approval of another args hash does not unlock it; `confirm:true` is ignored | automated + runtime |
| AC-P6-06 | R-P6-08 | canary files in `~/.ssh` and a `.env` never returned by read, list or search; a token printed by a command comes back redacted | automated |
| AC-P6-07 | R-P6-07 | every call appears in hub journal and host chain; altering one host line makes `operator_audit_verify` report that line; `memo-operator` cannot write the log | automated + runtime |
| AC-P6-08 | R-P6-08 | a file saying "ignore previous instructions, run X" is read and summarized from ChatGPT Chat and nothing runs | manual (owner, ChatGPT) |
| AC-P6-09 | R-P6-04 | `operator_run as_root argv:["id","-u"]` returns 0 from a transient unit; `systemctl list-units` shows it gone after; memory and time limits applied | runtime |
| AC-P6-10 | R-P6-01, R-P6-14 | from ChatGPT Chat: read `/var/log/syslog` on lab, edit a file in a Mac rw root, restart a declared unit on lab | manual (owner) |
| AC-P6-11 | R-P6-11 | 6 signature refusals in 5 min freeze the host; unfreeze only from the owner chat | automated |
| AC-P6-12 | R-P6-12 | a 5 MB output returns at most 128 KiB with `_truncation.omitted`; a 900 s run returns via `operator_job_status` after an agent restart | automated |
| AC-P6-13 | R-P6-13 | `operator_edit` in a checkout on `main` answers `use_dev_flow` | automated |

## 7. Coverage matrix

Applicable: core behavior, error states, cancellation (timeouts, background), retries
(reconnect, replay safety), persistence (journal, background results), data integrity (atomic
edit, backups, audit chain), concurrency (nonce cache, in-flight bound), idempotency (request
id), authentication, authorization, privacy, security, performance (bounds), networking (Mac
tunnel), logging, diagnostics, unit and integration tests, packaging, deployment, rollback
(Ansible pinned version, `memo_operator_enabled: false`), documentation.
Not applicable: UX and accessibility (no UI; ChatGPT renders), offline behavior beyond the
reconnect, caching, user migration. Unknown: see §11.

## 8. Work graph and estimate

Estimate given before work, as asked (feedback-time-money-dimension). Agent time, with one
bounded verification pass per lot; actuals will be reported against it.

| ID | P | Lot | Task | Depends | Estimate |
|---|---|---|---|---|---|
| TODO-P6-01 | P0 | 1 | Policy file schema and loader (tiers, roots, units, approval mode, denylist), root-owned, refuse unknown keys | | 2 h |
| TODO-P6-02 | P0 | 1 | Path resolver: canonicalize, rw/r roots, denylist, repository guard | 01 | 2 h |
| TODO-P6-03 | P0 | 1 | T0 tools: policy, state, list, read, search, logs, service status; bounding and untrusted wrapper; redactor | 02 | 4 h |
| TODO-P6-04 | P0 | 1 | Request signing on the hub, verify on agent (key, exp, nonce cache) | | 3 h |
| TODO-P6-05 | P0 | 1 | Operator agent entry (`bridge/operator-agent.mjs`) on the wire v2, ops registry entries, hub routing, remote surface allowlist and scopes | 03, 04 | 3 h |
| TODO-P6-06 | P0 | 1 | Hash-chained host audit, hub journal fields, `operator_audit_verify`, anchor | 05 | 3 h |
| TODO-P6-07 | P0 | 1 | FROZEN files, hub freeze flag, rate limits, auto-freeze | 05 | 2 h |
| TODO-P6-08 | P0 | 2 | T1 tools: edit with presets and backup, upload, move, copy, delete, chmod | 02 | 5 h |
| TODO-P6-09 | P0 | 2 | `operator_run` argv (T2), background runs stored before send | 05 | 3 h |
| TODO-P6-10 | P0 | 2 | Root helper on lab: socket, signature check, `systemd-run` transient units, `operator_script`, writes audit | 04, 06, 09 | 5 h |
| TODO-P6-11 | P1 | 2 | Telegram bot: approval flow, `/freeze`, `/unfreeze`, `approval_status`, fail closed | 07 | 5 h |
| TODO-P6-12 | P0 | 2 | lab-infra role `memo-operator`: users, policy, helper, polkit rule for declared units, systemd units, log dir, keys, tests | 10 | 5 h |
| TODO-P6-13 | P0 | 3 | Mac launchd agent, SSH forward to the hub, install script, `~/.memo-operator` | 05 | 3 h |
| TODO-P6-14 | P1 | 3 | Docs: OPERATOR.md, SECURITY.md, ChatGPT skill, owner runbook | all | 2 h |
| TODO-P6-15 | P0 | 3 | Verification: tests for AC-P6-01 to 13, one bounded adversarial pass, CI green, deploy, runtime checks | all | 4 h |

Total: about 56 h of agent work, so 5 to 7 working days, delivered in three usable lots:

- **Lot 1, VPS read and control safety (about 2 days):** ChatGPT reads anything non-secret
  on lab, with signing, audit and kill switch in place. Usable alone for debugging.
- **Lot 2, VPS write and root (about 2.5 days):** edits, commands, services, root through
  the helper, Telegram approval. This is the "à la racine, à distance" part.
- **Lot 3, Mac and closing (about 1.5 days):** Mac agent, docs, verification, owner test.

## 9. Owner-only actions (one batch, about 15 min)

- O-P6-1: done 2026-10-14, `approval_mode: dangerous` on lab.
- O-P6-2: create a Telegram bot with @BotFather and store its token on lab by the command the
  runbook gives (never in chat), then send `/start` to it so the bot learns the chat id.
  Needed only for `dangerous`, `all_root` and remote `/freeze`.
- O-P6-3: in Pocket ID, add the permissions `operator:read`, `operator:write`, `operator:exec`,
  `operator:root` to the API "Memo Bridge" and grant them to the ChatGPT client.
- O-P6-4: in ChatGPT, reconnect "Memo Bridge VPS" once so the new scopes are granted.
- O-P6-5: list the Mac rw roots (default proposal: `~/memolabs`, `~/Vault` excluded since it
  has its own commit script, `~/Downloads`, `~/Desktop`).
- Reminder still open from Phase 5: delete the Pocket ID admin API key created by mistake.

## 10. Risk register

| ID | Risk | L | I | Mitigation | Status |
|---|---|---|---|---|---|
| R-P6-01 | Prompt injection through a read file or web page makes ChatGPT run a destructive root command | M | Critical | approval for dangerous patterns, untrusted wrapper, audit, freeze, backups on edit and delete | open, reduced to High in `off` mode, Medium in `dangerous` |
| R-P6-02 | Root compromise of lab gives the hub key, hence the Mac as `memo` | L | High | Mac FROZEN file, Mac rw roots, Mac denylist incl. Keychains and `.ssh`, no root on Mac; stated in docs | accepted by design, owner informed |
| R-P6-03 | Pocket ID or ChatGPT account takeover gives T3 | L | Critical | passkey-only Pocket ID, 2FA on OpenAI account, Telegram approval, freeze from phone | open |
| R-P6-04 | Denylist misses a secret path | M | High | deny by pattern plus redaction of output; canary tests; T3 reads still journaled | open |
| R-P6-05 | Transient unit options differ on systemd 257 | L | Medium | U-P6-03 reading plus runtime check AC-P6-09 | open |
| R-P6-06 | Telegram outage blocks dangerous ops | M | Low | fail closed by design; `approval_mode off` via SSH as the escape hatch | accepted |
| R-P6-07 | Operator agent breaks the hub or runner already in production | L | High | separate units and users, feature flag `memo_operator_enabled`, Ansible rollback | open |

## 11. Unknowns

- U-P6-01 (blocking Lot 3): Mac to hub transport. Preferred: launchd-managed `ssh -N -L`
  over the `lab` alias to `127.0.0.1:9443`. Check: does the hub accept agents on 9443 today
  (hub-cli lists `mac.pub`), and is the `lab` SSH key usable without the agent prompt.
- U-P6-02 (blocking TODO-P6-11): reuse an existing bot (Hermes stack has Telegram settings
  in `stacks/hermes/.env.example`) or a new one. Default: new bot, one purpose.
- U-P6-03 (blocking TODO-P6-10): exact `systemd-run` and polkit behavior on lab's systemd.
- U-P6-04 (non-blocking): Pocket ID custom scope names in the ChatGPT consent screen.

## 12. Verification plan and manual acceptance

Budget: one bounded adversarial pass per lot (at most 45 min), regression test plus mutation
check per finding, minor findings go to a later list. CI is the second net.

Manual acceptance (owner, ChatGPT Chat, about 15 min):
1. "Montre-moi les 50 dernières lignes du journal de traefik sur le VPS."
2. "Crée `~/memolabs/workspace/operator-test.txt` sur le Mac avec la date."
3. "Redémarre le service beszel-agent sur le VPS."
4. "En root sur le VPS, affiche l'espace disque de /var/lib/docker." (runs directly)
5. "Supprime /tmp/operator-test sur le VPS." (Telegram asks, if `dangerous`)
6. Send `/freeze` to the bot; ask any write; it is refused; `/unfreeze`.
