# SentinelX design map, and an "operator" surface for Memo Bridge

Research only. I wrote no code, installed nothing, ran nothing against any server, and called none of the SentinelX MCP tools. I cloned and read the sources without executing them, into `/private/tmp/claude-501/-/fdde9467-cc48-4578-8ddc-2eb314628494/scratchpad/sentinelx-src/`.

**Source keys used in citations:**
- **CORE**: github.com/pensados/sentinelx-cloud-core @55acee0 (2026-10-11, agent v0.23.17, `pyproject.toml`).
- **PROTO**: github.com/pensados/sentinelx-cloud-protocol @00169f8 (protocol 1.13.2).
- **INST**: github.com/pensados/sentinelx-cloud-installer @670193f.
- **WEB**: github.com/pensados/sentinelx-app-web @a157b46. This is the source of sentinelx.app.
- **LEGACY**: pensados/sentinelx-core-mcp, the older self-hosted version.
- **SCHEMA**: the hub's tool JSON schemas as this environment exposes them (connector `24777f52…`). I loaded the definitions with ToolSearch to read their input fields; I did not invoke any tool.

The hub (`mcp.sentinelx.app`) is closed source (CORE `README.md` "Architecture"). Everything I say about hub behavior comes from SCHEMA, WEB or PROTO and is marked as such.

---

## 1. Architecture

| Piece | What it is | Source |
|---|---|---|
| Agent | A Python asyncio process (`sentinelx_core`). Linux: systemd unit, user `sentinelx`. macOS: launchd, running **as the logged-in user**. Windows: WinSW service (LocalSystem) or a per-user Scheduled Task. | CORE `README.md`; INST `install.sh` L279-281, L507-560; INST `install-macos.sh` header L4-11 |
| Transport | **One outbound WSS** to `{hub}/agent/connect`. Credential sent as `Authorization: Bearer <JWT>`. JSON text frames carry control messages; binary frames carry file transfers. 30 s heartbeat; 90 s timeout. Reconnect backoff is `[0,1,2,5,10,20,30,60,120,300]` with full jitter, and the agent honors a hub `retry_after` hint capped at 300 s. | CORE `src/sentinelx_core/client.py` L54-63, L363-385, L866-887; PROTO `messages.md`, `python/sentinelx_protocol/__init__.py` |
| Messages | `hello` (host facts, capabilities, policy *counts only*) → `welcome` → `request{id, op, payload, deadline, opaque_ref}` / `response{ok, result \| error{code, message, details}}` → `event` (`job_completed`, `transfer_chunk_ack`) → `error` (fatal). Pydantic models with `extra="forbid"`. New optional fields are gated on capabilities the agent advertises (e.g. `opaque_ref`). | PROTO `python/sentinelx_protocol/messages.py`; CORE `executor.py` L122-135 |
| Response bounding | 128 KiB soft cap before sending. The largest strings are cut head and tail (60/40); lists and dicts are cut too. A `_truncation` block with JSON-Pointer `omitted` paths is attached. The executed op is never lost to a WebSocket close code 1009. | PROTO `bounding.py`, CHANGELOG 1.13.2 |
| Hub | Handles MCP Streamable HTTP at `https://mcp.sentinelx.app/mcp/mcp`, OAuth, multi-host routing, background jobs and notifications, context memory, integrations, a REST API, a dashboard, plan slots and rate limits. | CORE README; WEB `index.html`; SCHEMA |
| Client auth | OAuth through Keycloak (`keycloak.pensa.ar`, realm `mcp`), signing in with Google or GitHub. Open **dynamic client registration**: anyone can POST to `/clients-registrations/openid-connect`. ChatGPT and Claude self-register; Manus needs a manually registered client. **Inference:** PKCE is used, because the MCP auth spec requires it. I did not verify it. | WEB `troubleshooting.html` ("Manus" and "OAuth metadata" sections); WEB `privacy.html`; LEGACY `app.py` L155-247 (old per-tool scopes such as `sentinelx:exec`) |
| Enrollment | A one-time token comes from the dashboard or from `sentinel_mint_enrollment` (TTL 5-1440 min, rate-limited). The installer exchanges it once (`POST /agent/enroll`) for a host credential JWT. That JWT lives 365 days and is rotated past half-life (`POST /agent/rotate`); the rotated copy goes to `identity.rotated.json` and the original root-owned `identity.json` is never overwritten. JWT claims: `iss`, `sub=user_id`, `host_id`, `scope=agent`, `iat`, `exp`. | INST `enroll.py` L144-170; CORE `rotation.py` L1-23, `client.py` L470-520; PROTO `messages.md` "Authentication"; SCHEMA `sentinel_mint_enrollment` |
| Multi-host routing | Every tool takes `host_id`, resolved as exact id, then label, then hostname. A per-user default host is used when `host_id` is omitted. With several hosts connected and no default, the call fails with `ambiguous_host`. Plan slots: hosts beyond the plan limit return `operational=false` / `upgrade_required`. A `duplicate_session` close happens when a second socket uses the same `host_id`; the agent also keeps a local single-instance lock. | SCHEMA `sentinel_list_hosts`, `sentinel_set_default_host` / `get` / `clear`, `sentinel_set_host_label`; CORE `instance_lock.py` |
| Background jobs | With `background=true`, or any `notify_*`, the agent acks `running` with a `job_id`, then sends a `job_completed` event (output capped at 256 KiB). Results are **written to disk before sending** and replayed after a reconnect. The hub keeps an inbox (`notifications_check/get/ack`). The ceiling rises to 3600 s. | CORE `client.py` L540-640, `jobs.py`, `pending_results.py`; SCHEMA `sentinel_exec` |

## 2. Security model, as implemented

**Policy file:** `/etc/sentinelx/config.yaml`, mode 0644 root-owned. It is re-read only when the agent restarts. Typos in keys hard-fail at startup; unknown keys only warn (CORE `policy.py` L376-460).

### Commands
- `allowed_commands` is a **prefix match** (`cmd.startswith(entry)`) on a string that is then run through **`bash -lc`** (CORE `policy.py` `is_command_allowed`; `executor_engine.py` L122-129).
- In the default mode (`exec_strict: false`), an allowed prefix followed by `;` runs anything. The project says so itself: THREAT_MODEL §4.1 calls it "not a hard sandbox".
- `exec_strict: true` checks each segment, refuses substitution, control characters and file redirection, and only accepts a fixed set of read-only pipe filters (CORE `handlers/exec.py`; `segment_check.py`). It is off by default because about a third of the fleet's chained calls would break (`policy.py` comment on `exec_strict`).
- **The starter allowlist that ships with the installer is effectively unrestricted.** It contains `bash -lc`, `python3`, `sudo python3`, `if`, `set`, `cd`, `curl`, `wget`, `docker`, `sudo tee`, `sudo rm`, `sudo sed`, `sudo cp` and `apt`, among about 85 entries (CORE `config.example.yaml` L87-193; the installer copies it as-is, INST `install.sh` L474-490).
- `script_run` runs arbitrary bash, python3 or PowerShell, with an optional `sudo`, and is **not** gated by the allowlist (CORE `handlers/script.py` docstring L10-16). The only way to turn it off is `disabled_ops: [script_run]` (CORE `handlers/__init__.py`). `ping`, `capabilities`, `state` and `help` cannot be disabled.
- When `exec` rejects a command, the error message tells the model to use `script_run` instead (CORE `handlers/exec.py` `_classify_rejection`). In other words, the refusal points the model at the way around it.

### Paths
- `file_ops.paths` is a list of `{path, access: r|rw}` entries. Paths are canonicalized with `Path.resolve()` (symlinks and `..`) before an `is_relative_to` prefix check, and the most permissive matching entry wins. An unknown access value degrades to `r` (CORE `policy.py` `FileOpsPath`, `resolve_path`).
- read/list/search need `r`. edit, move, copy, delete, chmod, chown, git apply/clone/push and in-place upload need `rw`. Copy and move check both src and dst.
- Starter config: `r` on `/etc`, `/var/log`, `/var/www`, `/opt` and `/srv`; no `rw` paths at all (CORE `config.example.yaml` L1166-1180).
- Residual time-of-check/time-of-use races (TOCTOU) are acknowledged (THREAT_MODEL §4.2).

### Services
- `services: {name: {unit, actions[], requires_sudo, user, domain, backend}}` allowlists each unit and each action on it. Read-only actions (`status`, `is-active`, `is-enabled`) never use sudo (CORE `policy.py` `ServiceSpec`; `handlers/service.py` L25-60).

### Local APIs
- `local_apis` connects to a Unix socket or stdio over HTTP or JSON-RPC. Each endpoint has an action allowlist with `select` projections, an optional `run_as`, and a declared compatibility probe that fails closed. An endpoint with no actions is not registered (CORE `policy.py` `LocalApiEndpoint`, L796-922). This is the best-designed part of the policy.

### Privilege
- **Linux.** Sudo is now **opt-in**. If enabled, the sudoers rule is `sentinelx ALL=(ALL) NOPASSWD: ALL`, and the installer states plainly that the agent becomes "ROOT-EQUIVALENT". Without sudo the unit gets `NoNewPrivileges=yes`. Other unit settings: `KillMode=process`, `Nice=-5`, `OOMScoreAdjust=-500` (INST `install.sh` L284-370, L493-560).
- The installer has no `ProtectSystem`, `ProtectHome`, `PrivateTmp`, ReadWritePaths or seccomp settings (same file).
- `SECURITY.md` still says sudo is "on by default" and limited to "specific binaries". That is stale; it contradicts the installer and THREAT_MODEL §4.2.1.
- **macOS.** The agent runs as the user, so it reaches `~/.ssh`, the keychain session and everything else in the home directory. In `system` mode the installer **automatically** installs a "scoped" sudoers rule covering `/usr/bin/tee`, `/bin/cp`, `/bin/mv`, `/usr/bin/sed`, `/bin/chmod`, `/usr/sbin/chown`, `/bin/launchctl` and others (INST `install-macos.sh` L54-72, L212). **Inference:** `sudo tee` or `sudo cp` into `/etc/sudoers.d` makes that rule root-equivalent despite the "python3 excluded" comment.

### Allowlist escapes I found (inferences from the code, not exploited)
1. `sentinel_edit` and `edit_upload_complete` accept a free-form `validator` string. It is `shlex.split` and **executed** (under `sudo` when `sudo=true`) without any allowlist check. The tool's own docstring suggests `bash -c '…'` (CORE `vendored/pensa_safe_edit.py` `build_validator` L398-428; `handlers/edit.py` L115-125, L228). So disabling `script_run` does not remove arbitrary execution while `edit` is enabled.
2. Git network ops (`clone`, `fetch`, `push`, `ls-remote`) run with the agent user's environment and git config. The only overrides are `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM` and `LC_ALL`; I found no URL-scheme allowlist and no override of repo-local `core.sshCommand` (CORE `handlers/git_ops.py` L51-90, L854-1003). An `rw` repo whose `.git/config` the model can edit therefore becomes a command-execution path, and `clone` can reach internal or `file://` URLs.
3. `trusted_fetch_hosts` / `file_url` is well defended: https only, host allowlist, rejection of private IPs, no redirects, 15 s timeout (CORE `handlers/upload.py` `_validate_fetch_url`). THREAT_MODEL §4.3 acknowledges a DNS-rebinding gap.

### Self-modification of the policy
- Fixed in 0.11.18, after a report from OpenAI Security: `sudo=true` used to bypass the `rw` check, so the agent could rewrite its own config. Now the config is only editable if the owner explicitly lists it as `rw` (THREAT_MODEL §4.2.1; `handlers/edit.py` L270-310).
- The intended path is that the owner edits the policy through SSH or the dashboard's "Edit config". However, the shipped `add_allowed_command` playbook text still tells the LLM to edit the config (CORE `README.md` playbook example).

### Approval and confirmation
- There is **no human-approval mechanism on the agent**. Confirmation consists of `confirm=true` arguments on `sentinel_agent_update`, `sentinel_context_delete`, `compute_create` and `compute_destroy` (SCHEMA). The model can set those itself, so they only protect against a mistaken call, not against injection.
- In ChatGPT, the only extra gate is OpenAI's own safety layer, which sometimes blocks permission or credential changes (WEB `troubleshooting.html`, "This tool call was blocked by OpenAI").

### Rate limits
- Hub-side only: per-user tool-invocation rate limiting, and rate-limited enrollment minting. The agent itself has none (THREAT_MODEL §5.3; SCHEMA `sentinel_mint_enrollment`).
- The agent does have concurrency bounds: four read and four scan threads, and a 50 s time budget for scans (CORE `handlers/fileops.py` L472-500).

### Audit
- **Hub:** metadata only (user, host, op, time, success), kept 30 days according to the privacy page; THREAT_MODEL §5.5 describes it as a "Redis ring buffer". `opaque_ref` is recorded too (WEB `privacy.html`; PROTO `messages.py` `RequestMessage.opaque_ref`).
- **Agent:** `audit.jsonl` (`/var/lib/sentinelx/`, or `~/Library/Logs/sentinelx/` on macOS) records the **full payload, unredacted**. Base64 blobs are reduced to size + SHA-256; text over 64 KiB keeps its first 2 KB. Retention is 5000 lines; writes are best-effort and the file can be tampered with by the agent user itself (CORE `local_audit.py` L1-120; PROTO CHANGELOG 1.4.0 `read_audit`).
- The audit separates "the handler returned" from the job's own outcome (`result_ok`, `returncode`) (CORE `executor.py` `_nested_outcome`).
- `mutations.log` is a best-effort forensic trail (THREAT_MODEL §5.5).

### Secrets
- Hub integration credentials are encrypted and managed in the dashboard only. `list_integrations` never returns metadata or credentials, and `telegram_send_message` takes no `chat_id`, so the model cannot redirect messages (SCHEMA `list_integrations`, `telegram_send_message`).
- `resend_send_email` accepts **any recipient** (up to 10), which is an open exfiltration channel (SCHEMA).
- `sentinel_request_api_key` lets the model mint a bearer REST key (60 s to 24 h) with the user's full access (SCHEMA).
- The agent does not redact secrets from tool output.

### Kill switch and revocation
- Disabling a host in the dashboard makes the hub refuse it at connect (`enrollment_rejected`, close code 1008); the agent keeps retrying (CORE `client.py` `EnrollmentRejected`; SCHEMA `sentinel_list_hosts` "disabled"). A stolen credential can be revoked at the next rotation (CORE `rotation.py`).
- There is **no on-host emergency stop** apart from `systemctl stop` and no model-facing "pause".

### Update
- `sentinel_agent_update(host_id, confirm)` runs the official installer **with sudo through `script_run`** (Linux only; it needs NOPASSWD sudo and `script_run` enabled). The manual path is `git pull` plus a restart, and the installer always restarts the service (SCHEMA; INST `install.sh` L545-560; CORE `SECURITY.md` "Updates").
- The installer clones `main` from GitHub (`curl | bash`). There is no signature or pinned-digest check (INST `install.sh` L370-395, which also downloads `enroll.py` from raw.githubusercontent).

### Hub trust
- The hub is modelled as hostile (THREAT_MODEL A1), but messages are **not signed**. There is only TLS plus a bearer JWT.
- `SECURITY.md` claims the agent "signs/verifies messages at the protocol layer"; I found nothing in the code to support that (CORE `client.py`; PROTO).
- The hub URL comes from `identity.json` or `--hub`; there is no certificate pinning (THREAT_MODEL §5.4).
- **Bottom line:** a compromised hub can run anything the policy allows, and with the defaults that includes `script_run` and `bash -lc`.

### Documentation drift
- The website's config example (`exec: allow:`, `paths: allow_edit:`) does not match the parser. Under that schema the agent would load **zero** commands (WEB `index.html` §5 vs CORE `policy.py` KNOWN_KEYS).
- The privacy page (updated 2026-05-10) says outputs are "not persisted". Background job outputs and saved contexts are stored on the hub (SCHEMA `notifications_get`, `sentinel_context_*`).

## 3. Tool catalogue

All agent tools take `host_id?` and `opaque_ref?` (max 256 characters, recorded in the audit). Fields come from SCHEMA, and agent behavior from CORE `handlers/*`.

### Discovery and health
- `sentinel_capabilities{detail: summary|full}`: policy and limits. `summary` returns counts only and is the default.
- `sentinel_help{topic, path, playbook, offset, limit}`: paged playbooks and help tree (CORE `progressive_help.py`).
- `sentinel_state`: host facts and uptime.
- `sentinel_ping`.
- `sentinel_diagnose{host_id, symptom}`: hub-side cause analysis from its own records.
- `sentinel_report{type, title, summary, …, max 48 KB}`, `sentinel_report_followup`, `sentinel_report_status`: support tickets filed from the chat.

### Execution
- `sentinel_exec{command, timeout=30, background, notify_telegram|notify_resend}`: interactive cap is `exec.timeout_max` (default 600); background cap is 3600 s; partial output is returned on timeout; the whole process tree is killed (CORE CHANGELOG 0.22.1, 0.23.14).
- `sentinel_script_run{content, interpreter: bash|python3|powershell|pwsh, args[], env{}, cwd, filename, sudo, timeout ≤600, cleanup, background, notify_*}`.
- `sentinel_local_api{operation: list|describe|call, endpoint, action, params}`.

### Reading files
- `sentinel_read{path, view_range[s, e|-1], max_bytes}`: capped by `max_read_bytes` (64 KiB). Detects UTF-8, UTF-16 and BOMs; binary files come back as `encoding: "binary"`.
- `sentinel_read_media{path, pages, dpi}`: images, PDFs (rasterized server-side) and audio returned as native MCP content. ChatGPT drops the audio (WEB troubleshooting).
- `sentinel_list{path, depth ≤5, glob, show_hidden}`: noise directories (`.git`, `node_modules`, …) are always skipped; up to 1000 entries.
- `sentinel_search{path, pattern, regex, case_sensitive, file_glob, max_results}`: skips binaries (NUL byte in the first 8 KB); up to 200 results; 50 s budget, returning `truncated_reason: time_budget`.
- `sentinel_project_snapshot{path}`: git and filesystem orientation in one call.

### Editing
- `sentinel_edit{path, mode: replace|regex|replace-block|append|prepend|write, old, new_text, pattern, start_marker, end_marker, count, multiline, dotall, interpret_escapes, create, dry_run, diff, allow_no_change, backup_dir, validator | validator_preset: nginx|json|python|sh|yaml|systemd|toml, sudo}`.
  - Writes go to a temporary file, are validated, then atomically renamed.
  - A timestamped backup is taken; ownership and mode are preserved.
  - If validation fails, the original file is untouched (CORE `vendored/pensa_safe_edit.py`).
- `sentinel_edit_upload_init` → `sentinel_edit_upload_file{upload_id, role: old|new, content | content_base64}` → `sentinel_edit_upload_complete{…same fields as edit}`.

### Filesystem mutation (each path needs `rw`)
- `sentinel_move{src, dst, overwrite}` and `sentinel_copy{src, dst, overwrite}`: both ends need `rw`; a backup is taken before overwriting.
- `sentinel_delete{path, recursive}`: always backs up first. Files go to `.bak.<ts>`, directories to `.bak.<ts>.tar.gz`. If the backup fails, the delete is refused. Deleting a SentinelX backup is final (CORE CHANGELOG 0.21.0).
- `sentinel_chmod{path, mode (octal string)}`, `sentinel_chown{path, owner?, group?}`.

### Transfer
- `sentinel_upload_file{target_path (relative to upload_base), content_base64 | file_url, filename, overwrite}`.
- `sentinel_upload_init{target_path, total_size, filename, overwrite}` → `sentinel_upload_chunk{upload_id, index (0-based, any order), content_base64}` → `sentinel_upload_complete{upload_id, sha256}`. Chunks of about 256 KiB are recommended; the cap is 10 GiB (CORE `handlers/upload.py` L44).
- `land_in_place` writes directly to an `rw` path, across filesystems if needed (CORE CHANGELOG 0.23.17).
- `sentinel_transfer_file{source_host_id, source_path, destination_host_id, destination_path, overwrite, land_in_place}`:
  - Host-to-host relay through the hub, up to 512 MiB.
  - Binary frames: `[16-byte transfer_id][4-byte big-endian chunk_index][payload ≤1 MiB]`.
  - Backpressure through `transfer_chunk_ack`; SHA-256 verified at the destination.
  - Source side uses the internal ops `file_export_*` (PROTO `binary.py`; CORE `handlers/file_export.py`).

### Services
- `sentinel_service_status` (bundles status, is-active and is-enabled; each part can error on its own), `sentinel_service_start`, `sentinel_service_stop`, `sentinel_service_reload`, `sentinel_restart{service}`. Systemd user units are supported (CORE CHANGELOG 0.23.12).

### Git
- `sentinel_git_diff{path, base_ref, staged, unstaged, include_untracked, context_lines ≤10, max_files ≤50, max_patch_bytes ≤128 KiB}`: total budget 512 KiB.
- `sentinel_git_apply_patch{path, patch ≤5 MiB, dry_run}`: all-or-nothing. Absolute paths and `..` in the patch are refused, every touched path is checked against `rw`, and a `--recount` retry handles corrupt-patch errors.
- `sentinel_git_clone{url, dest (empty, rw), branch, depth}`: a partial clone is removed on failure.
- `sentinel_git_fetch{path, remote, ref}`.
- `sentinel_git_push{path, branch, remote, force, expected_remote_sha}`: a **force push requires the expected remote SHA**, giving lease semantics, and a bare force is impossible.
- `sentinel_git_ls_remote{remote, ref_pattern, path}`.
- Fixed git environment, 15 s per command, 45 s per operation, git root re-validated against the allowlist (CORE `handlers/git_ops.py`).

### Fleet and account
- `sentinel_list_hosts`, `sentinel_set_default_host` / `get` / `clear`, `sentinel_set_host_label`, `sentinel_remove_host_label`, `sentinel_mint_enrollment{ttl_minutes}`, `sentinel_agent_update{host_id, confirm}`, `sentinel_request_api_key{ttl_seconds, contract: full|terse|none, label}` (REST `POST {base}/op`, same allowlist, audited).

### Hub integrations
- `list_integrations`.
- `telegram_send_message{integration_name, text ≤4096, parse_mode, disable_notification}`.
- `resend_send_email{integration_name, to[] ≤10, subject, html | text, from_address, reply_to}`.
- `cloudflare_dns_list_zones/list/create/update/delete_record`, `cloudflare_rulesets_list`, `cloudflare_ruleset_get`, `cloudflare_zone_settings`, `cloudflare_security_events`, `cloudflare_access_apps/policies_list`.
- `compute_list/regions/sizes/images/create{…, grant_sudo, enroll, confirm}/power_on/off/snapshot/destroy{confirm}` on DigitalOcean.
- `notifications_check/get/ack`.

## 4. Context and session memory (hub-side)

From SCHEMA `sentinel_context_*`:
- **Storage:** contexts (`sxc_…`) live on the hub, per user, as **revisions**.
- **Saving:** `save{context_id?, base_revision, data{title, objective, summary, tags, hosts, workspace, parent_context_id, related_context_ids, …}}`. `base_revision` gives optimistic concurrency.
- **Reading:** `resume{context_id, detail: summary|full, revision}` explicitly "restores knowledge, not authorization", telling the model to re-check live state and approvals. Also `list` and `search` (filters: status, tags with tag_mode, host, workspace, task_group, parent, updated_after/before, include_archived), `export_md` (never writes files), `archive`, `reactivate`, `delete{confirm}`.
- **Conversation binding:** `status` shows which context is bound to the current chat; archiving a context clears those bindings.
- **Settings:** `auto_save: off|suggest|operational|milestone`, `md_mode: off|local|project`. **Inference:** `local` and `project` mirror contexts to Markdown on a host or in a project directory.
- The save instructions say "never transcripts or secrets", but nothing enforces it.

## 5. Assessment

**Worth copying:**
1. The r/rw path model, canonicalized before the prefix check, with src and dst both checked on copy and move (`policy.py` `resolve_path`).
2. Structured edits: modes plus a validator preset, atomic rename, backup, preserved ownership, `dry_run` and `diff`. Also the 3-step staged upload for large content.
3. Delete is refused unless a backup succeeds; directory deletes require `recursive`.
4. Git push with a lease (`expected_remote_sha`), all-or-nothing `apply_patch` with path checks on every file in the patch, and bounded, structured `git_diff`.
5. `local_api`: endpoints declared with an action allowlist and field projection, failing closed on a protocol mismatch. Much better than `exec` for docker and similar daemons.
6. Response bounding with JSON-Pointer omission metadata; time budgets on scans; separate thread pools so reads never wait behind scans.
7. Background jobs whose results are written to disk before sending and replayed after reconnect.
8. `opaque_ref` correlation carried end to end into the audit.
9. Error codes that tell the model what to do next (but never advertise a bypass).
10. `restores knowledge, not authorization` on resume; `base_revision` concurrency on context saves.
11. Integration secrets kept out of the model's reach, and a fixed `chat_id` for Telegram.
12. A systemd unit for the agent itself with OOM and nice protection so it stays reachable on a loaded host; `KillMode=process`.

**Weak or risky:**
1. A prefix allowlist over `bash -lc`, with strict mode off by default and a starter list containing `bash -lc`, `python3`, `sudo tee` and similar. The "allowlist is the boundary" marketing does not hold with the defaults.
2. `script_run` and the edit `validator` are unbounded execution paths; one is hidden inside edit.
3. Opt-in sudo is all or nothing: `NOPASSWD: ALL`. The macOS "scoped" rule is effectively root.
4. The hub is assumed hostile, yet requests are unsigned. The hub, an Argentine SaaS, plus the OAuth path is a single point that can drive every host.
5. No out-of-band approval. In ChatGPT Plus, tools run without confirmation, and any file the model reads can inject instructions.
6. The local audit is unredacted, writable by the agent user and best-effort. The hub audit has no arguments.
7. Updates run unsigned `curl | bash` from GitHub `main` as root.
8. `resend_send_email` to arbitrary recipients and `sentinel_request_api_key` are exfiltration and privilege-handoff channels.
9. Documentation drift: SECURITY.md, the website config example and the privacy page are stale, as noted in section 2.

## 6. Proposed Memo Bridge "operator" surface (single owner)

**Fixed context.** One owner (Guillaume). Two hosts: the Mac and `lab` (Debian 13 VPS). ChatGPT Plus runs tools without confirmation. Memo Bridge already has Pocket ID OAuth, a hub plus agents over WebSocket with Ed25519, an SQLite audit journal, Coordinator leases, worktrees, sandboxed jobs, a PR flow and GitHub App tokens.

### Design principles (improvements over SentinelX)

- **P1. Argv only, no shell.**
  - `op_exec{argv[], cwd, timeout}` is matched against **named command templates** in the policy, e.g. `journalctl: ["journalctl","-u",{unit},"-n",{int≤500}]`.
  - No `bash -lc`, no prefix matching, and no free-form "validator" string: only named presets.
  - Arbitrary scripts exist only at a separate tier (see T3).
- **P2. Signed requests.**
  - The hub signs every request: Ed25519 over `{id, op, payload_hash, host, tier, exp, nonce}`. Memo Bridge already has the keys.
  - The agent verifies the signature, freshness and a nonce cache, and checks the tier against its **local** policy.
  - Writes to the policy file are impossible over the wire: root-owned, outside every rw path, changed only over SSH.
- **P3. Privilege tiers, enforced on the agent, each one a separate OAuth scope.** A ChatGPT connector can be granted T0-T1 only.
  - **T0 read.** state, capabilities, read, list, search, read_media, project_snapshot, git_diff, service_status, journal_tail (templated), docker inspect through `local_api`. No secrets: a denylist of globs such as `**/.env*`, `**/.ssh/**`, `*.pem`, `id_*`, `*.key`, `.git/config` credentials, plus content redaction of token patterns before output leaves the agent.
  - **T1 write-user**, inside declared rw roots only (e.g. `/srv/apps/*` on lab, `~/memolabs` on the Mac):
    - edit (with presets), staged upload, move/copy, delete (with backup), chmod (no chown).
    - git apply_patch, fetch, clone with an `https://github.com/` URL allowlist.
    - Prefer the existing worktree, PR and job flow for repositories over in-place edits.
  - **T2 service-ops on lab:** start, stop, restart or reload of declared units. Implementation: a dedicated `memo-operator` user with **polkit rules for exactly those units**, not sudo. Docker goes through `local_api` with declared actions; no raw `docker` CLI.
  - **T3 root on lab:** `script_run` and `sudo`. Disabled by default. Each call needs **out-of-band approval**, and runs as a transient `systemd-run --wait --pipe -p ProtectSystem=strict -p ReadWritePaths=…` unit with time and memory limits.
  - **Mac:** T0-T1 as the user, in a launchd agent with `sandbox-exec` or a profile like Memo Bridge's job sandbox. Never a sudoers rule. No T2 or T3 on the Mac.
- **P4. Out-of-band approval through Telegram for destructive patterns.**
  - Triggered by: any T3 call; any T2 stop or restart of an allowlisted critical unit; delete of more than N files or of a directory; chmod or chown; edits under `/etc`; force push; any outbound send (email, DNS write).
  - Flow: the hub parks the request and sends a Telegram message to Guillaume's bot (fixed chat, inline keyboard Approve / Deny / Approve 15 min for this exact argv hash), with expiry. The tool returns `pending_approval{approval_id}`, polled with `approval_status`.
  - Approval binds to the payload hash, so the model cannot swap the arguments afterwards. A `confirm=true` argument is never accepted as approval.
- **P5. Kill switch, three layers.**
  - (a) `operator_freeze`, a hub flag that the *owner* sets from Telegram `/freeze` or the dashboard, never the model. It immediately rejects every request above T0.
  - (b) On each host, the existence of `/etc/memo-operator/FROZEN` (or `~/.memo-operator/FROZEN` on the Mac) makes the agent refuse everything except ping and state.
  - (c) Revoke the host key in the hub.
  - Also: rate limits per tier (e.g. T1 ≤ 60/min, T3 ≤ 5/hour) and anomaly auto-freeze (e.g. more than 3 denied calls in 5 min).
- **P6. Audit.**
  - The SQLite journal records request id, `opaque_ref`, tier, the argv hash **plus redacted arguments**, approval id, outcome, `returncode`, duration and output hash.
  - The agent keeps its own append-only, hash-chained JSONL that it **cannot rewrite**: owned by root, written through a small root helper or `journald`, with periodic anchoring of the chain head into the hub's SQLite.
  - Separate execution success from the outcome of what ran, as SentinelX does.
- **P7. Prompt-injection hygiene.**
  - Every file or command output is wrapped as untrusted data (`{"untrusted_content": …}`) with an instruction-boundary note.
  - Tool descriptions never suggest a bypass.
  - No tool lets the model widen its own policy, mint credentials (drop the equivalent of `request_api_key`) or send to an arbitrary recipient. Outbound messages only go to fixed owner channels.
- **P8. Updates.** The agent updates only from a **signed release artifact**: a GitHub release with a minisign/Ed25519 signature checked against a pinned key, staged and then swapped atomically, with an automatic rollback if the agent does not reconnect within 60 s. An update needs T3 approval. No `curl | bash` from `main`.
- **P9. Responses.** Reuse the 128 KiB bounding with `_truncation.omitted` pointers, time-budgeted scans and background jobs replayed from disk. Long work goes to Memo Bridge `jobs_submit`, which already has sandboxing and a leased lifecycle.

### Mapping from SentinelX tools to Memo Bridge equivalents

| SentinelX | Memo Bridge equivalent | Tier | Notes |
|---|---|---|---|
| capabilities / help / state / ping | `host_capabilities`, `host_status`, `host_resources` (existing) + `operator_policy` (read-only view of the effective policy) | T0 | Summary by default |
| list_hosts / default / label | `list_hosts` (existing) + `operator_set_default_host` | T0 | Only two hosts; route by `host: mac\|lab` enum |
| exec | `operator_run{template, args{}}` | T0/T1/T2 depending on the template | Argv templates, no shell, no prefix matching |
| script_run | `operator_script{interpreter, content}` | T3, lab only | Approval required; transient hardened systemd unit; disabled on the Mac |
| read / read_media / list / search / project_snapshot | `operator_read`, `operator_read_media`, `operator_list`, `operator_search`, `project_info` (existing) | T0 | Secret-glob denylist, redaction, untrusted-content wrapper |
| edit + edit_upload_* | `operator_edit` (same modes, presets only) + `operator_stage_*` | T1 | Edits under `/etc` need T3 approval; inside repos use `worktree_write_file` |
| upload_* / upload_file | `operator_upload_init/chunk/complete{sha256}` | T1 | No `file_url`, or a fixed allowlist of GitHub release URLs |
| transfer_file | `operator_transfer{src_host, src, dst_host, dst}` | T1 | Relay through the hub using the same binary framing; SHA-256 check |
| move / copy / delete / chmod / chown | `operator_move`, `operator_copy`, `operator_delete` (backup always), `operator_chmod` | T1; delete of a directory or more than N files triggers approval | No chown below T3 |
| service_status / start / stop / reload / restart | `operator_service{unit, action}` | status T0; others T2 (polkit) | Critical units need approval |
| local_api | `operator_local_api{endpoint, action, params}` | T0/T2 per action | Docker on lab: `ps`, `inspect`, `logs`, `restart` |
| git_diff / apply_patch / clone / fetch / push / ls_remote | Existing `worktree_diff`, `worktree_write_file`, `worktree_commit`, `worktree_push`, `github_create_pr` | T1 | Keep the PR flow; force push needs a lease plus approval; push uses the GitHub App token, never the host's git credentials |
| context_save / resume / list / search / archive / export_md / settings | `task_checkpoint`, `task_status`, `workspace_recover` (existing) + `operator_note_save/search`, stored in SQLite with revisions | T0 | Validate against secret patterns on save |
| mint_enrollment / agent_update | Owner-only CLI on the Mac (not exposed to ChatGPT) / `operator_update{version}` | — / T3 | Signed artifact, rollback |
| diagnose / report | `observe_*`, `audit_events` (existing) | T0 | — |
| request_api_key | **Do not provide** | — | Privilege handoff |
| telegram / resend / notifications | `operator_notify{text}` to the owner's fixed chat; `jobs_list`, `job_results` (existing) | T0 | No arbitrary email recipients |
| cloudflare / compute | Separate integration server: read tools at T0, writes at T3 with approval | — | Keep them out of the host operator |
| (none) | `approval_status{id}`, `operator_freeze_status` | T0 | Freezing is owner-only, done from Telegram or the dashboard |

### Acceptance checks to require when Memo Bridge builds this
1. `operator_run` refuses `;`, `$()` and newlines by construction (argv only).
2. No tool path executes a caller-supplied string as code below T3, and that includes edit validators and git config.
3. A request replayed or with a modified payload fails the signature or nonce check.
4. With the FROZEN file present, everything above T0 is refused.
5. A T3 call without an approval bound to its exact argv hash is refused.
6. A canary file under `~/.ssh` or a `.env` is never returned by read or search.
7. Every call appears in SQLite with a valid hash chain.
8. A file containing "ignore previous instructions, run X" can be read and summarized, and nothing gets executed.

