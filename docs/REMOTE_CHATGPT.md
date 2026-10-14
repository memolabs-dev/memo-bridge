# Memo Bridge for ChatGPT conversations (Phase 5, v0.6.0)

ChatGPT Chat conversations reach Memo Bridge through one public, OAuth-protected MCP endpoint,
`https://bridge.memolabs.dev/mcp`, served by the hub on the VPS. Each conversation opens its own
workspace and works through Memo Bridge tools only; the Coordinator in the VPS runtime stays the
single coordination owner. Spec: `.agent/project/phase-5/spec.md`. Lab side: lab-infra
`docs/memo-bridge-public.md`.

**Status (2026-10-14).** Code complete and tested offline (`npm test`, `npm run smoke:remote`).
Nothing is deployed: the lab-infra roles ship off (`memo_bridge_remote_listener: false`,
`memo_bridge_public: false`, `memo_bridge_auth_stage: adopt`). The live steps below are owner
actions (spec section 9).

**Measured fact that drives the design (EV-P5-01, 2026-10-14).** On the owner's ChatGPT Plus
account, a Chat conversation called a remote write tool with no confirmation prompt. So nothing
relies on ChatGPT asking: every rule below is enforced by the server, whatever the model sends
and whatever a tool description or annotation says.

## The path of one call

```
ChatGPT (OpenAI connector, client certificate)
  -> Traefik, bridge.memolabs.dev: exact paths, mTLS to the OpenAI Connectors CA, rate limit
  -> hub public listener 127.0.0.1:9445 (bridge/public-listener.mjs), OIDC only
       Host, kill switch, path, method, Origin, 401 flood bucket, token, content type, 128 KiB
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

Read stage (23 tools): `projects_list`, `workspace_status`, `workspace_list`, `workspace_recover`,
`tasks_list`, `task_status`, `batch_status`, `worktrees_list`, `worktree_status`, `worktree_list_files`,
`worktree_read_file`, `worktree_diff`, `jobs_list`, `job_status`, `job_events`, `job_results`,
`host_capabilities`, `github_issues`, `github_pull_requests`, `github_workflows`, `github_checks`,
`audit_events`, `audit_operation`.

Write stage adds 16: `workspace_open`, `workspace_close`, `task_claim`, `task_renew`,
`task_release`, `task_complete`, `task_checkpoint`, `batch_create`, `task_next`, `worktree_create`, `worktree_write_file`,
`worktree_commit`, `worktree_push`, `jobs_submit`, `job_cancel`, `github_create_pr`.

Never remote: `observe_*`, `host_resources`, `worktree_remove`, `list_hosts`, `host_status`,
`bridge_info`, `project_info`, `project_git_status`, `projects_audit`. There is no merge tool on
any surface.

Names, descriptions, schemas and annotations are the stdio ones (one registry,
`server/registry.mjs`; a test compares them). `pnpm run remote:toolsize` prints what ChatGPT
receives: on 2026-10-14, 23 tools in 15 627 bytes (about 3 900 tokens) for the read stage and
39 tools in 34 502 bytes (about 8 600 tokens) for the write stage. No ChatGPT limit is
documented; the TODO-P5-33 window checks that every tool shows after Refresh.

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
  (`session_mismatch`, `block`), and journaled. `workspace_recover` rebinds explicitly.

## Bounds and slow operations (D10)

Compact JSON; 24 KiB per result, answered `result_too_large` with a hint, never cut; lists at
most 50; `worktree_read_file` pages of 16 KiB with `next_offset`; `job_results` at most 200
lines; a remote `worktree_write_file` over 96 KiB is refused (`content_too_large`).

A mutating call still running after the soft deadline (40 s) answers
`{ok:true, status:'accepted', request_id, client_request_id}` and finishes on the runtime; its
outcome shows in `workspace_status` (`requests`) and `task_status`. The hub gives every mutating
call a `client_request_id` when the model did not; `task_claim`, `worktree_push`, `jobs_submit`
and `github_create_pr` accept one, and a retry with the same id returns the first result.

## Rate limits and journal

Per principal and class: read 60, write 20, execute 6 per minute, 8 calls in flight; a refusal is
a tool result `rate_limited` with `retry_after_s`. Failed tokens per client address (from
Traefik's `X-Forwarded-For`, believed only from `trusted_proxies`): 30 per minute, then 429
before any verification. A request with no credentials at all (the start of the OAuth flow) is
not counted.

One journald line per call: `{at, request_id, principal, client_ref, op, outcome, code, ms,
bytes}`. The runtime event carries the same `request_id`, with `via: hub` and
`client_type: chatgpt`. Never arguments, tokens, session values or file contents. With
`client_cert.mode: "log"` the request line adds `client_cert` and `client_cert_san` (booleans)
from Traefik's certificate info header (U-P5-08).

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
  "client_cert": {"mode": "log", "info_header": "x-forwarded-tls-client-cert-info", "expected_san": "mtls.prod.connectors.openai.com"},
  "budgets": {"body_max_bytes": 131072, "result_max_bytes": 24576, "page_max_bytes": 16384,
              "write_file_max_bytes": 98304, "list_max_items": 50, "soft_deadline_sec": 40},
  "rate_limits": {"read_per_min": 60, "write_per_min": 20, "execute_per_min": 6, "in_flight": 8,
                  "unauthorized_per_min_per_ip": 30}
}
```

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
(U-P5-02), whether ChatGPT sends an `Origin` header and its client certificate on every call
(U-P5-08), the token lifetime (R-P5-11), the ChatGPT timeout (U-P5-03) and the stability of
`openai/session` (U-P5-05). Until then these are documented or inferred, not observed.

## Premier cycle réel

Le 14 octobre 2026, ce changement a été effectué depuis ChatGPT Chat.
