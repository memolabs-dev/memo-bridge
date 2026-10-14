# Operator access (Phase 6)

Operator tools let the owner, from a ChatGPT Chat conversation (connector "Memo Bridge VPS")
or from the 9443 hub, read, write and run commands on the VPS `lab` and on the Mac, root
included on `lab`. They are for the machine. Code in tracked repositories keeps the
worktree, job, pull request flow (`docs/REMOTE_CHATGPT.md`): a write or a command inside a
registered checkout on its default branch answers `use_dev_flow`.

Specification: `.agent/project/phase-6/spec.md` (decisions D1 to D11, deviations DEV-P6-01 to
25). Server side on lab: lab-infra role `memo-operator`, `docs/memo-operator.md` there.

## Path of one call

```
ChatGPT ── OAuth ──> hub 9445 ──┐
owner bearer ──────> hub 9443 ──┤ checks scope, freeze flag, rate, approval;
                                │ signs {id, op, host, tier, args_sha256, exp, nonce, principal}
                                ├── wss ──> operator-vps (lab, user memo-operator) ── socket ──> root helper (T3)
                                └── wss over the SSH tunnel 127.0.0.1:9444 ──> operator-mac (Mac, user memo)
```

Each agent checks the hub signature (Ed25519, 60 s, nonce never seen), then the tier, roots,
denylist and approval against its **own** policy file. The hub never sends policy. Each call
lands in the hub journal (event `operator_call`, redacted arguments, hashes) and in the host's
hash-chained journal.

## Tiers on each host

| Tier | Scope (Pocket ID) | lab (`operator-vps`) | Mac (`operator-mac`) |
|---|---|---|---|
| T0 read | `operator:read` | policy, state, list, read, search, journal and docker logs of declared units and containers, service status, job status, approval status, freeze status, audit verify | the same, without logs and service status (no journald, no systemd: `logs_unavailable_on_host`, `systemd_unavailable_on_host`) |
| T1 write | `operator:write` | edit (presets, backup, atomic), upload, move, copy, delete with backup, chmod, inside the write roots | the same, inside `~/memolabs`, `~/Desktop`, `~/Downloads`, `~/Documents`, `/tmp` |
| T2 exec | `operator:exec` | `operator_run` argv as `memo-operator` (no shell, no sudo, no docker group); `operator_service` start, stop, restart, reload of declared units through polkit | `operator_run` argv as `memo`, the owner's own user |
| T3 root | `operator:root` | `operator_run as_root`, `operator_script` (bash, python3), each in a transient `systemd-run` unit with `RuntimeMaxSec`, `MemoryMax=2G`, `TasksMax=512`, through the root helper | none: no root on the Mac (`root_unavailable_on_host`) |

Reads cover the read roots (`/` on lab, `~` on the Mac) minus the secret denylist: `.ssh`,
`.gnupg`, `.env*`, `*.pem`, `*.key`, `*.p8`, `id_*`, `*secret*`, keychains, credential stores,
`~/.config/**/secrets/**`, `~/.aws`, `~/.netrc`, browser profiles and cookies, Mail, Messages,
group containers, `~/.memo-operator` and `/etc/memo-operator`. Command output and file content
pass a token redactor and come back wrapped as untrusted data.

## Approval flow (`approval_mode: dangerous`, both hosts)

1. A call on the dangerous list answers `pending_approval` with an `approval_id`: any script;
   `rm`, `dd`, `mkfs`, firewall tools, `kill`, `passwd` and the like anywhere in argv; a shell,
   interpreter or wrapper as the program (`bash`, `python3`, `env`, `find`, `sudo`, `sed`, `awk`,
   `docker`, `git`, package managers, and on the Mac `osascript`, `launchctl`, `open`,
   `security`); `/etc/ssh`, `/etc/sudoers*`, `/etc/pam.d`, `/etc/passwd`, `/etc/shadow`; the
   agent's own control files (`.memo-operator`, `/etc/memo-operator`) and
   `~/Library/LaunchAgents`; stop or disable of `ssh`, `traefik`, `memo-bridge-*`; every
   recursive delete.
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
| Mac file `~/.memo-operator/FROZEN` | the Mac | `touch ~/.memo-operator/FROZEN` | `rm ~/.memo-operator/FROZEN` |
| auto-freeze: 5 signature or policy refusals in 5 min | that host (or the root helper) | automatic, marker `AUTO-FROZEN` in the state directory | read the journal first; `/unfreeze`, or `make memo-operator-unfreeze auto=1` on lab, or `rm ~/.memo-operator/state/AUTO-FROZEN` on the Mac |
| agent key removed from the hub | that agent, entirely | remove `operator-mac.pub` or `operator-vps.pub` from `/var/lib/memo-bridge/secrets`, restart the hub | put it back |

The hub flag set by `/freeze` lives in memory: a hub restart drops it. The files are the
durable switches. The model has no freeze or unfreeze tool.

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
| `policy.json` | 0444 | the Mac policy: `max_tier: exec`, `approval_mode: dangerous`, roots, denylist, `repositories` read from `~/memolabs/PROJECTS.md` through `~/memolabs/.links` |
| `state/` | 0700 | background runs, uploads, the auto-freeze marker |
| `~/Library/Logs/memo-operator/audit.jsonl` | 0600 | the Mac's hash-chained journal |

A policy change is a rerun of the script and a restart (`--install` restarts the job). The
agent reads the policy and the hub key once at start and refuses to start on any problem with
them (owner, mode, unknown key, wrong host).

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
  `deploy/mac/install-operator-agent.sh --uninstall`. From the phone: `/freeze`.
- **Verify a journal**: `operator_audit_verify` reports the first broken line.

## Limits, stated plainly

- **A root compromise of lab gives the Mac as the user `memo`.** The hub signing key lives on
  lab; whoever is root there can sign any call the Mac policy allows: read the home folder
  outside the denylist, write the write roots, run commands as `memo`. The Mac's own FROZEN
  file, its denylist and the absence of root on the Mac bound it; nothing else does
  (R-P6-02, accepted by the owner).
- **No root on the Mac.** `sudo` there asks for a password or Touch ID; operator calls never
  get it.
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
- **Approvals and the hub flag live in hub memory**: a hub restart drops pending approvals and
  the `/freeze` flag. The FROZEN files are durable.
