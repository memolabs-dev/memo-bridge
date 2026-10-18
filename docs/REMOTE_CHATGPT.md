# Memo Bridge for ChatGPT conversations (Phase 5, v0.6.0)

ChatGPT Chat conversations reach Memo Bridge through one public, OAuth-protected MCP endpoint,
`https://bridge.memolabs.dev/mcp`, served by the hub on the VPS. Each conversation opens its own
workspace and works through Memo Bridge tools only; the Coordinator in the VPS runtime stays the
single coordination owner. Spec: `.agent/project/phase-5/spec.md`. Lab side: lab-infra
`docs/memo-bridge-public.md`.

**Status (2026-10-15).** Merged (#20; client certificate required since #55 and #56) and deployed
on lab (`memo_bridge_version` a8f5a60). ChatGPT connects through Pocket ID OIDC and calls tools
with a client certificate (`public_request` 200, 2026-10-15 09:22 Paris). Writes are live: on
2026-10-15 a ChatGPT conversation committed, pushed and opened PR #59 through the VPS runner.
Until 2026-10-14 the code was tested offline only and the lab-infra roles shipped off. The owner
steps below record how it was set up (spec section 9).

**Measured fact that drives the design (EV-P5-01, 2026-10-14).** On the owner's ChatGPT Plus
account, a Chat conversation called a remote write tool with no confirmation prompt. So nothing
relies on ChatGPT asking: every rule below is enforced by the server, whatever the model sends
and whatever a tool description or annotation says.

## The path of one call

```
ChatGPT (OpenAI connector, client certificate)
  -> Traefik, bridge.memolabs.dev: exact paths, client certificate verified against the OpenAI
     Connectors CA when given (VerifyClientCertIfGiven), its info forwarded, rate limit
  -> hub public listener 127.0.0.1:9445 (bridge/public-listener.mjs), OIDC only
       Host, kill switch, path, method, Origin, 401 flood bucket, bare 401 challenge,
       client certificate required (403), token, content type, 128 KiB
  -> remote surface (bridge/remote-surface.mjs): the remote tool set, gate layer 1, bounds
  -> forwarder (bridge/forward.mjs): request id, session hash, rate limits, soft deadline, journal
  -> hub v2 envelope {op, args, principal:{id, client_type}, meta:{request_id, client_session}}
  -> VPS runner (memo-runner): grants from remote.json (gate layer 3), authorize, Coordinator,
     worktrees, jobs; the runtime event carries the same request_id
```

The 9443 listener of Phase 4 is untouched and never takes an OAuth token: the static owner
bearer, `/agent` and `/health` are structurally unreachable from 9445 (the public listener
module imports none of them and refuses their options). The Phase 1 OIDC mode of 9443
(`MEMO_BRIDGE_OIDC_SETTINGS`, scope `hosts:read`) was removed; setting that variable stops the
hub.

## Identity

- Authorization server: Pocket ID at `https://auth.memolabs.dev`. ChatGPT registers through
  CIMD (`https://chatgpt.com/oauth/client.json`), with PKCE S256 and `resource` (RFC 8707).
- Accepted tokens (`bridge/oidc.mjs`): `typ` `at+jwt`, exact `iss`, `aud` containing
  `https://bridge.memolabs.dev/mcp`, `sub` equal to the owner sub, `client_id` on the
  allowlist, `exp`, `iat` within `max_token_age_sec`, RS256, ES256 or EdDSA. Anything else is a
  401 with a fixed message; the precise reason goes to the journal only.
- Principal `oidc:<owner sub>`, `client_type` `chatgpt` derived from `client_id`, never from
  arguments. Capabilities are the token scopes, capped by the ceiling, minus every write
  capability while the write gate is closed. The baseline scope is `coordinator:read`.
- The JWKS is read from Pocket ID's loopback port (`http://127.0.0.1:1411/.well-known/jwks.json`):
  plain HTTP is accepted for a loopback address literal only.

## The remote tool set

Read stage (28 tools; `delegation_status` since #47): `projects_list`, `workspace_status`, `workspace_list`, `workspace_recover`, `sessions_overview`,
`tasks_list`, `task_status`, `batch_status`, `worktrees_list`, `worktree_status`, `worktree_list_files`,
`worktree_read_file`, `worktree_diff`, `jobs_list`, `job_status`, `job_events`, `job_results`,
`host_capabilities`, `github_issues`, `github_pull_requests`, `github_workflows`, `github_checks`,
`audit_events`, `audit_operation`, and `memory_search`, `memory_get`, `memory_list`.

Write stage adds 21 (`workspace_delegate`, `delegation_join`, `delegation_report`, `delegation_end` since #47): `workspace_open`, `workspace_close`, `task_claim`, `task_renew`,
`task_release`, `task_complete`, `task_checkpoint`, `batch_create`, `task_next`, `worktree_create`, `worktree_write_file`,
`worktree_commit`, `worktree_push`, `jobs_submit`, `job_cancel`, `github_create_pr`, `memory_save`.

Never remote: `observe_*`, `host_resources`, `worktree_remove`, `list_hosts`, `host_status`,
`bridge_info`, `project_info`, `project_git_status`, `projects_audit`. There is no merge tool on
any surface.

Names, descriptions, schemas and annotations are the stdio ones (one registry,
`server/registry.mjs`; a test compares them). `pnpm run remote:toolsize` prints what ChatGPT
receives (operator tools excluded): at a8f5a60 on 2026-10-15, 28 tools in 20 527 bytes (about
5 100 tokens) for the read stage and 49 tools in 49 976 bytes (about 12 500 tokens) for the write
stage. Rerun the script for the current figures. No ChatGPT limit is
documented; the TODO-P5-33 window checks that every tool shows after Refresh.

## Zero ceremony: the conversation's workspace (owner console REQ-Z1)

The owner never has to say "Memo Bridge", "workspace", "claim" or "worktree". A tool that needs a
workspace and is called without `workspace_id` (`task_claim`, `task_next`, `task_renew`,
`task_release`, `task_complete`, `task_checkpoint`, `workspace_status`, `workspace_recover`,
`workspace_close`, `worktree_create`, `jobs_submit`, `github_create_pr`, the delegation tools) runs
in the conversation's own workspace, the way operator tools already did (D-R14):

- only a workspace of the owner bound to this conversation (`openai/session` hash) is ever chosen:
  the one holding the `claim_id`, owning the `worktree_id`, holding a claim on the `issue`, on the
  project named or implied by the Issue's repository, else the most recent one;
- only `task_claim` and `task_next` open one when the conversation has none, through
  `workspace_open` with all its guards; the journal records `workspace_open` and
  `workspace_auto_open`;
- the result carries `implicit_workspace {workspace_id, project, opened}`;
- otherwise the answer is `workspace_required` with one `next_step`, and nothing is opened.

`workspace_open` still works and an explicit `workspace_id` is checked exactly as before.

## Conductor workflow: one chat splits, N chats work (TODO-P5-50 to 52)

ChatGPT cannot open conversations by itself (driving ChatGPT programmatically is against the
OpenAI terms), so the owner opens them. Everything else goes through the Coordinator: there is
no batch table, only a GitHub label and the lease ledger.

1. **Conductor chat.** The owner describes the project; the conductor calls `batch_create`
   with `project` and 1 to 10 tasks (`title`, `scope`, `acceptance`, optional `priority`, p1 by
   default). Each task becomes an ordinary GitHub Issue labelled `agent:ready`,
   `priority:<p>` and `agent:batch-<id>`; the label is created first if it does not exist. The
   answer carries the batch id and the sentence to paste, for example
   `@Memo Bridge prends la prochaine tâche du lot 3f9a0c12de du projet drop`.
2. **Worker chats.** The owner opens N conversations and pastes that same sentence in each.
   Each one calls `workspace_open` on the project, then `task_next` with its `workspace_id` and
   the batch id. `task_next` lists the batch Issues (GitHub Issues endpoint, not search, so a
   new Issue is visible at once), keeps the claimable ones (open, `agent:ready`, one priority,
   no blocking label), skips the ones this store already records as held by a live claim, and
   claims them in order (p0 first, then Issue number) through the same code as `task_claim`.
   A refusal that means someone else got there first (`lease_held`, `lease_race_lost`,
   `issue_not_ready`, `issue_changed`) moves to the next task; any other failure stops and is
   returned. The answer carries the task (Issue, title, scope, acceptance), `claim_id`,
   `fence`, `expires_at` and fixed steps to follow. Nothing is left: `{ok:true, done:true}`.
3. **Follow-up.** The conductor calls `batch_status` (`project`, `batch`): per task the state
   (`ready`, `claimed`, `stale`, `blocked`, `done`, `closed`, `not_ready`, `unknown`), the
   holder (ledger worker and expiry, plus workspace and client kind when this runtime knows
   the workspace; the client label only for your own workspaces), linked pull requests
   (closing keyword or the worktree branch), counts per state and the stale leases.

Rules that hold whatever the model sends:
- Classification: `batch_status` is a read (`coordinator:read`), `task_next` needs
  `coordinator:write` like `task_claim`, `batch_create` needs `github:write` because it opens
  Issues. With `remote_writes` not `enabled`, only `batch_status` is listed and the two writes
  are refused by the runtime as well (D7).
- Project allowlist (D9): `batch_create` and `batch_status` check their `project`, `task_next`
  the project of its workspace. The batch repository must also be in the ledger allowlist.
- Session binding (D8): `task_next` names a workspace, so a call from another conversation is
  refused with `block` and warned with `warn`, before anything is claimed.
- One task per conversation: a workspace that already holds a live claim on a task of the batch
  gets that task back (`already_held:true`) and nothing new is claimed.
- Retries: `task_next` and `batch_create` replay their first result for the same
  `client_request_id`, so they may answer `accepted` past the soft deadline like `task_claim`;
  a retry never claims a second task or creates a second batch.
- `batch_create` refuses AI attribution in the task text, stops at the first GitHub failure and
  reports `partial`, `failed` and `not_created`; an Issue whose labels GitHub dropped (a token
  without push access) is reported as `labels_dropped`, since it could never be claimed.
- Within one runtime, parallel `task_next` calls try different Issues first; across machines the
  ledger alone decides, and the loser moves on.

## Ten conversations at once (multi-session, spec `.agent/project/multi-session/spec.md`)

All conversations are the same principal (`oidc:<owner sub>`). What keeps them apart is the
workspace, the conversation it is bound to, the lease ledger and the operator locks.

**The sentence to paste in each worker conversation** (one line, nothing else to say):

```
Avec Memo Bridge, prends la prochaine tâche disponible : ouvre ton workspace, lis sessions_overview, prends ta tâche avec task_next, ne travaille que sur elle, prends un operator_lock avant toute action opérateur et arrête-toi sur stale_lease, locked_by_other_session ou workspace_other_session.
```

What each conversation does (the server instructions and the plugin skill say the same):

1. `workspace_open` (any allowed project; `task_next` moves it if needed), then `sessions_overview`:
   every active workspace of the owner, newest first, at most 20: id, client, `session_tag` (a
   short tag of the conversation, never the ChatGPT hint), project, held task with its local
   lease state (`held`, `expired`), last recorded activity and last call, `you: true` for its
   own, and the operator locks of each. Local store and hub memory only: no ledger or GitHub call.
2. `task_next({workspace_id})` without `batch`: the next `agent:ready` Issue of every project in
   `remote.json` `projects` (or of `project`), p0, then p1, then p2, then oldest; Issues held by a
   live claim of this runtime or being claimed by a parallel call are skipped, and the ledger
   decides the rest (a lost race moves to the next Issue). A workspace that holds a task gets it
   back (`already_held`). A workspace with no task and no worktree moves to the task's project
   (`project_changed`, journaled `workspace_retarget`). The answer carries `brief`: the task, the
   project, the other conversations on that project (tag and task) and the rules.
3. Operator work: `operator_lock({host, workspace_id, kind, target, reason})` first. Kinds:
   `path` (a subtree), `unit`, `container`, `global` (the whole host). TTL 15 min by default, at
   most 2 h, renewed by locking again; `operator_unlock` releases one lock or all of them.

Rules the server enforces, whatever the model sends:

- Remote `operator_*` writes, commands and root calls must name `workspace_id`
  (`workspace_required`) and be covered by a lock of that workspace (`lock_required`): a path
  lock on the file (both ends of a move, the destination of a copy), on the `cwd` of
  `operator_run`; a unit lock for `operator_service`; a `global` lock for `as_root`,
  `operator_script` and a command without `cwd` (a command line can name any path). Read-only
  tools need no lock. Another workspace's lock that overlaps the target answers
  `locked_by_other_session` with its `session_tag`, workspace, target and reason. The hub
  removes `workspace_id` before signing, so agents and owner approvals are unchanged.
- `host` is optional on the operator tools (owner decision 2026-10-14): without it the hub uses
  the Mac when `operator-mac` is connected, else `vps`. `as_root`, `operator_script` and any call
  on the dangerous list must name it (`host_required`, "Mac ou VPS ?"). Every operator result
  carries the `host` it ran on.
- The 9443 hub principals (Claude Code or Codex on the Mac through the private hub) need no
  workspace, and are refused only where another workspace holds a lock.
- Locks are kept by the hub for both hosts, saved in its state directory
  (`bridge/hub-state.mjs`): they survive a hub restart or a deploy. Pending approvals and implicit
  per-call locks do not. Without a state directory a restart drops the locks; a remote holder's
  next write then answers `lock_required` and it takes the lock again, or learns that another
  conversation took it. `sessions_overview` shows `locks_since` (the start of this hub process).
- Locks compare paths as text (`..` resolved, `~/` as `/Users/memo` on the Mac, case folded on
  the Mac); they coordinate conversations, they do not replace the host policy, the signature or
  the approvals.

### Session binding `enforce`

`session_binding: "enforce"` makes the binding strict for remote principals: a workspace opened
in one conversation answers `workspace_other_session` to any coordinator call from another one
(reads included), to worktree writes, jobs and `github_create_pr`. A call without the
`openai/session` hint answers `session_required`, and so does `workspace_open` (fail safe: no
hint, no work). `workspace_recover` from another conversation rebinds only a workspace with no
recorded activity for 30 min (a refreshed page that changed the hint); otherwise
`workspace_other_session`. `warn` and `block` behave as before; stdio and the 9443 principals are
unchanged in every mode.

Before switching lab-infra to `enforce`: with `warn`, open two conversations and check that
`sessions_overview` shows a non-null `session_tag` for each, different from each other (U-P5-05).
If ChatGPT sends no hint, `enforce` would refuse every remote workspace.

## Sub-agents with Chat alone: delegation (#47, spec `.agent/project/delegation/spec.md`)

With ChatGPT Plus only, a sub-agent is another chat the owner opens by hand. Memo Bridge never
launches a chat (OpenAI terms) and calls no model. The parent conversation holds a task; when the
owner asks it to split the work, it calls `workspace_delegate` (scope `read_only`, `paths` or
`worktree`) and gives the owner the sentence of its `paste` field, for example:

```
Avec Memo Bridge, rejoins la délégation d_3f9a1c2b7e4d.
```

The owner opens a new conversation and pastes it. That conversation calls `delegation_join`: it
gets its own workspace, bound to it (single use: any other conversation gets `delegation_taken`),
the task, the scope, the brief and the rules. It then works only through its own `workspace_id`,
inside its scope, under the parent's task and lease (it never sees the claim id or the fence, and
`task_claim` answers `child_cannot_claim`), and ends with `delegation_report` `final: true`. The
owner goes back to the parent, which reads the results with `delegation_status`, then commits,
pushes and opens the pull request itself. Releasing or completing the task, closing the parent's
workspace, `delegation_end` or the TTL end every child: its next call answers `delegation_ended`.

- Remote join needs the `openai/session` hint in every binding mode (`session_required`): the
  delegation is bound to the conversation that joins it. Check `session_tag` in
  `sessions_overview` first, as for `enforce`.
- Two children of one parent work at once on scopes that never overlap (`scope_overlap`).
- Operator writes of a child: path targets under its absolute scope paths only
  (`outside_delegation_scope`), with or without an explicit lock; its locks block other
  conversations as the parent's would.
- `sessions_overview` lists children under their parent (`children`).
- Tools: `delegation_status` (read stage), `workspace_delegate`, `delegation_join`,
  `delegation_report`, `delegation_end` (write stage). No new OAuth scope: `coordinator:read`
  and `coordinator:write`.

## Write gate (D7)

1. Write tools are not listed unless `remote_writes` is exactly `"enabled"`. A call to an
   unlisted tool gets "unknown tool" from the SDK and a `remote_denied` journal line with reason
   `write_gate_closed`.
2. With `remote_writes: "enabled"`, the hub refuses to start while any `actions.runner.*` unit
   runs as root, or would start at boot as root, or when that cannot be established
   (`systemctl` probe, `bridge/write-gate.mjs`). lab-infra runs the same check before deploying.
3. The runner grants `oidc:<owner sub>` from the same `remote.json`: read while writes are
   disabled, owner once enabled, and strips every write capability from a remote principal
   while the file does not enable writes, whatever `MEMO_BRIDGE_HUB_PRINCIPALS` says.

Write scopes appear in the protected resource metadata (`scopes_supported`) only once the gate
is open; the owner then reconnects ChatGPT to obtain them.

## Server-side invariants for writes (D9)

- Project allowlist (`projects` in `remote.json`, `owner/repo` entries; the catalog project of
  that repository name): `project_not_allowed` otherwise. Release, complete and close stay
  possible after a project leaves the list.
- No write under `.github/workflows/`, `.github/actions/` or `.github/dependabot.yml`, any case,
  through a symlinked parent, in a commit or anywhere in the pushed history: `path_protected`.
- Push only the workspace's own branch, never with force, never the default branch
  (`protected_branch` at worktree creation, `push_rejected` on a rewrite).
- A pull request only on a head this workspace pushed (`head_not_pushed_by_workspace`).
- `workspace_open` stores `client_type: chatgpt` and `host: vps`; `host: mac` is refused with
  `host_not_remote_enabled` (Mac workspaces are Phase 5b).
- Session binding (D8): `workspace_open` records a hash of `_meta["openai/session"]`; a write
  from another conversation is warned (`session_warning`, default `warn`) or refused
  (`session_mismatch`, `block`), and journaled. `workspace_recover` rebinds explicitly. With
  `enforce`, see "Ten conversations at once" above.

## Bounds and slow operations (D10)

Compact JSON; 24 KiB per result, answered `result_too_large` with a hint, never cut; lists at
most 50; `worktree_read_file` pages of 16 KiB with `next_offset`; `job_results` at most 200
lines; a remote `worktree_write_file` over 96 KiB is refused (`content_too_large`).

A mutating call still running after the soft deadline (40 s) answers
`{ok:true, status:'accepted', request_id, client_request_id}` and finishes on the runtime; its
outcome shows in `workspace_status` (`requests`) and `task_status`. The hub gives every mutating
call a `client_request_id` when the model did not; `task_claim`, `worktree_push`, `jobs_submit`
and `github_create_pr` accept one, and a retry with the same id returns the first result.

## Client certificate: only ChatGPT calls tools

Owner decision of 2026-10-15 (option A): only ChatGPT, through OpenAI's connector client
certificate, calls tools on the public endpoint. The check is split between Traefik and the hub,
because TLS client authentication applies per SNI host, not per path, and ChatGPT's discovery
requests carry no certificate: with `RequireAndVerifyClientCert` on the route (2026-10-14) the
discovery never completed.

- Traefik (`clientAuthType: VerifyClientCertIfGiven`, the OpenAI Connectors CA as the only trust
  anchor) refuses the handshake for a certificate from anywhere else, strips client-sent
  `X-Forwarded-Tls-Client-Cert*` headers at the entrypoint and, through `passTLSClientCert`,
  forwards the info of a verified certificate only.
- The hub, with `client_cert.mode: "require"`, answers `403 {"error":"client_cert_required"}` to
  every `POST /mcp` that carries an `Authorization` header without that info, or whose
  certificate does not name `client_cert.expected_san` (an exact SAN value, else the exact subject
  CN). This covers `initialize`, `tools/list` and every `tools/call`. The check runs before the
  token is verified: a token replayed from outside OpenAI learns nothing about its validity and
  does not charge the 401 flood bucket. Journal: `public_refused`, reason `client_cert_required`,
  with the `client_cert` and `client_cert_san` booleans.
- Left open without a certificate: the two protected-resource metadata paths and the bare 401
  challenge (`POST /mcp` with no `Authorization`). They are ChatGPT's discovery: in the Traefik
  access log of 2026-10-14 each connection starts with an unauthenticated `POST /mcp` (401) and
  the metadata fetch, from OpenAI addresses, next to the authenticated calls. Neither runs a tool
  or says more than the public metadata document. The 401 line now records `client_cert` too, so
  the journal shows whether those requests ever carry the certificate.

Evidence before the switch (hub journal, 2026-10-13 to 2026-10-15): 222 authenticated requests,
all with `client_cert: true` and `client_cert_san: true`; 24 refusals at 401 (22 bare
challenges, 2 expired tokens), whose lines did not record the certificate then.

`client_cert.mode: "log"` keeps the booleans without refusing anything; `"off"` (the default when
`client_cert` is absent) does neither. lab-infra renders `"require"` and refuses an optional TLS
client certificate on a public route unless the hub's mode is `"require"`.

## Rate limits and journal

Per principal and class: read 60, write 20, execute 6 per minute, 8 calls in flight; a refusal is
a tool result `rate_limited` with `retry_after_s`. Failed tokens per client address (from
Traefik's `X-Forwarded-For`, believed only from `trusted_proxies`): 30 per minute, then 429
before any verification. A request with no credentials at all (the start of the OAuth flow) is
not counted.

One journald line per call: `{at, request_id, principal, client_ref, op, outcome, code, ms,
bytes}`. The runtime event carries the same `request_id`, with `via: hub` and
`client_type: chatgpt`. Never arguments, tokens, session values or file contents. With
`client_cert.mode` `"log"` or `"require"`, the request line, the 401 lines and the
`client_cert_required` refusal add `client_cert` and `client_cert_san` (booleans) from Traefik's
certificate info header (U-P5-08), never the certificate itself.

## Configuration: remote.json

One file, `/etc/memo-bridge/remote.json` (root 0644, no secret), rendered by lab-infra and read
by the hub and the runner through `MEMO_BRIDGE_REMOTE_CONFIG`. Format version 1, parsed by
`bridge/remote-config.mjs`; an unknown key stops the hub. Example (the lab values, owner sub
elided):

```json
{
  "version": 1,
  "remote_enabled": true,
  "listen": {"host": "127.0.0.1", "port": 9445},
  "public_host": "bridge.memolabs.dev",
  "allowed_origins": ["https://chatgpt.com"],
  "trusted_proxies": ["127.0.0.1"],
  "oidc": {
    "issuer": "https://auth.memolabs.dev",
    "jwks_uri": "http://127.0.0.1:1411/.well-known/jwks.json",
    "audience": "https://bridge.memolabs.dev/mcp",
    "owner_sub": "<Pocket ID user id>",
    "allowed_client_ids": ["https://chatgpt.com/oauth/client.json"],
    "required_scope": "coordinator:read",
    "max_token_age_sec": 3600
  },
  "projects": ["memolabs-dev/memo-bridge"],
  "remote_writes": "disabled",
  "session_binding": "warn",
  "client_cert": {"mode": "require", "info_header": "x-forwarded-tls-client-cert-info", "expected_san": "mtls.prod.connectors.openai.com"},
  "budgets": {"body_max_bytes": 131072, "result_max_bytes": 24576, "page_max_bytes": 16384,
              "write_file_max_bytes": 98304, "list_max_items": 50, "soft_deadline_sec": 40},
  "rate_limits": {"read_per_min": 60, "write_per_min": 20, "execute_per_min": 6, "in_flight": 8,
                  "unauthorized_per_min_per_ip": 30}
}
```

`session_binding` is `"warn"`, `"block"` or `"enforce"`; move to `"enforce"` once
`sessions_overview` shows a `session_tag` for each conversation (see above).

`max_token_age_sec` must be at least the access-token lifetime Pocket ID issues (R-P5-11,
measured in AC-P5-19); 3600 is a placeholder until then.

## Setup, in order (owner steps from the spec, section 9)

1. Pocket ID, enrollment window (lab-infra `memo_bridge_auth_stage: enroll` with the owner IP):
   create the admin with a passkey on `/setup`; create the API with audience
   `https://bridge.memolabs.dev/mcp` and permissions `coordinator:read`, `coordinator:write`,
   `runner:execute`, `repo:write`, `github:write`; enable CIMD access with `coordinator:read`
   only and allow `offline_access`; read your user id (the `sub`).
2. Stage `public` (signups and `/setup` closed), then set `memo_bridge_remote_owner_sub`,
   `memo_runner_enabled`, `memo_bridge_remote_listener: true` and a memo-bridge release with
   this code, deploy the hub, then `memo_bridge_public: true` for the route.
3. ChatGPT on the web: Settings, then add a custom MCP server, URL
   `https://bridge.memolabs.dev/mcp`, OAuth. Consent with the passkey. Keep "Always ask".
4. Read stage checks (TODO-P5-33): the tool list, the decoded claims in the journal, the token
   lifetime, the timeout, session stability, refresh.
5. Write stage, only after lab-infra #161 is closed: `memo_bridge_remote_writes: enabled` (the
   lab-infra guard and the hub self-check must both pass), add the write permissions to the CIMD
   access in Pocket ID, reconnect the connector to obtain the write scopes.

## Kill switches and revocation

- Route: `make memo-bridge-public-off` in lab-infra removes the Traefik route file (immediate);
  also set `memo_bridge_public: false`, or the next deploy brings it back.
- Listener: `remote_enabled: false` in `remote.json` (lab-infra `memo_bridge_remote_serving`),
  hub restart: every request answers 503.
- Writes: `remote_writes: "disabled"`, hub and runner restart.
- Identity: delete the owner's sessions in Pocket ID (there is no revocation endpoint); rotate the
  Pocket ID signing key as a last resort. The hub refetches the JWKS on an unknown key.

## Certificates

- The OpenAI Connectors intermediate CA is the only trust anchor of the mTLS option (lab-infra,
  valid to 2031). A CA rotation by OpenAI makes TLS fail closed: refresh the PEM from
  developers.openai.com when that happens; recheck monthly (TODO-P5-27).
- Traefik verifies the hub with a copy of its certificate (`secrets/tls.crt`, expires
  2027-02-10). Rotating the hub certificate means redeploying the route.

## Not verified yet (live window)

Whether Pocket ID issues `typ: at+jwt` with a `client_id` claim and the expected scopes
(U-P5-02), whether ChatGPT sends an `Origin` header, whether its discovery requests (the bare
401 and the metadata fetch) ever carry its client certificate (U-P5-08; every authenticated call
did), the token lifetime (R-P5-11), the ChatGPT timeout (U-P5-03) and the stability of
`openai/session` (U-P5-05). Until then these are documented or inferred, not observed.

## Premier cycle réel

Le 14 octobre 2026, ce changement a été effectué depuis ChatGPT Chat.
