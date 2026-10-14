# Phase 5 evidence (2026-10-14)

Scope: ChatGPT Chat conversations reach Memo Bridge through a public, OAuth-protected MCP endpoint
served by the hub on the VPS. Spec: `spec.md` (D1 to D11, REQ/AC-P5, work graph section 8).
Repositories: memo-bridge `feat/phase-5-chatgpt-remote` (v0.6.0), lab-infra
`feat/phase-5-chatgpt-ingress`. Nothing pushed, nothing deployed, no VPS write.

## Measured facts

| ID | Fact | Source |
|---|---|---|
| EV-P5-01 | On the owner's ChatGPT Plus account a Chat conversation called a remote custom MCP write tool with no confirmation prompt (server log `openai-mcp/1.0.0`). Every write invariant is therefore enforced by the server. | spec.md header, owner session 2026-10-14 |
| EV-P5-02 | VPS, read-only, systemd 257: emargo runner active as root and enabled; drop runner inactive, root, enabled; factura inactive, root, disabled; lab-infra and vault runners non-root. The write gate probe refuses this state. | write-invariants report (read-only `systemctl`), lab-infra `test_memo_bridge_public.py` live sample |
| EV-P5-03 | Pocket ID published on `127.0.0.1:1411`; image `sha256:323e7ef5...` (v2.18.0); network `memo-bridge-auth_default`, gateway `10.0.7.1`. | research-vps.md, lab-infra report (`docker inspect`) |
| EV-P5-04 | Traefik 3.6.25 running digest `sha256:31267173...`. | lab-infra report |

## Automated verification (Node v24.21.0; Node 22 is not installed on this Mac)

| Command | Result |
|---|---|
| `npm test` | 330 pass, 0 fail; after the verifier fixes 339 pass, 0 fail (`tests/jobs.test.mjs` included, no hang on this run) |
| `npm run build` | ok (`plugin/server/dist/index.mjs`, `job-runner.mjs`) |
| `npm run smoke` | `{"ok":true,"tools":48,"roundTrip":true,...}` |
| `npm run smoke:remote` (`tests/remote-e2e.test.mjs`, `tests/remote-boot.test.mjs`) | 7 pass |
| `npm run test:hub` | 61 pass |
| `npm run test:runner` (includes `test:deploy`) | 122 pass; deploy unittest 113 OK |
| `node scripts/remote-toolsize.mjs` | read: 22 tools, 14 867 bytes (~3 717 tokens); write: 36 tools, 30 691 bytes (~7 673 tokens) |
| lab-infra `python3 -I ansible/roles/memo-bridge-ingress/test_memo_bridge_public.py` | 54 OK; after the verifier fixes 58 OK |
| lab-infra `python3 -I ansible/roles/memo-bridge/test_memo_runner.py` | 49 OK |
| lab-infra `./scripts/tests.sh` | 112 green, 0 red (rerun after the verifier fixes: 112 green) |
| lab-infra `ansible-playbook --syntax-check playbook.yml` (dummy vault password file) | ok |
| Contract: lab-infra `remote.json.j2` rendered by the lab-infra test renderer (writes disabled and enabled), parsed by memo-bridge `parseRemoteJson` | both ok; listener 127.0.0.1:9445, audience `https://bridge.memolabs.dev/mcp`, JWKS `http://127.0.0.1:1411/...`, projects `['memo-bridge']`, soft deadline 40 000 ms |
| lab-infra `ansible-playbook --check --diff` against lab (by the lab-infra implementer, before integration) | ok=45 changed=1 failed=0 (the one change is the existing middlewares file, basic-auth secrets not loaded) |

## Verifier findings fixed (2026-10-14, review verdict BLOCK)

Each fix has a regression test that was run against the pre-fix source (file restored from
`HEAD` in place, test run, fixed file put back) and failed there.

| Finding | Fix | Regression test | Fails without the fix |
|---|---|---|---|
| F1 HIGH: workflow change through `worktree_create{base}` (D9, REQ-P5-10) | remote principal: `base` must resolve to `origin/<default>` (`base_not_allowed`); push: protected paths also measured from the merge-base with the remote's default branch (tip from `ls-remote`, else the tracking ref; fails closed), for every principal; `github_create_pr` (remote): same check from the merge-base with the default branch GitHub reports, `path_protected` journaled as denied | `tests/remote-write-guard.test.mjs`: `F1 create`, `F1 push`, `F1 pull request` | yes, 3/3 |
| F2 HIGH: lab-infra default made mTLS optional (REQ-P5-01, AC-P5-01) | lab-infra `memo_bridge_mtls_client_auth: RequireAndVerifyClientCert` (group_vars and role default); the ingress role refuses a public route with `VerifyClientCertIfGiven` unless `memo_bridge_mtls_measurement_until` is a date within 14 days; runbook and architecture updated | lab-infra `test_fix_f2_mtls_required_by_default_and_enforced_while_public`, `test_fix_f2_mtls_assert_evaluated_by_ansible` (runs the assert with local ansible-playbook 2.21.4: Require ok, IfGiven refused without a date, ok with +5 days, refused with +30 days and with yesterday) | yes, 3 failures (with the updated route-template test) |
| F3 MEDIUM: remote principal held `coordinator:audit` once writes are enabled (REQ-P5-09) | `gateRemotePrincipal` always strips `coordinator:audit` from `oidc:` principals: `audit_events` / `audit_operation` show only their own events | `tests/policy-remote.test.mjs`: `fix F3 ...`, updated grant assertions | yes, 2 failures |
| F4 MEDIUM: `jobs_submit` / `job_cancel` skipped the session binding (REQ-P5-11) | the job service applies `sessionBindingDecision` on the workspace's `client_session` (refusal `session_mismatch` journaled, `session_warning` in warn mode) and journals the hub `request_id` | `tests/remote-job-binding.test.mjs` (2 tests) | yes, 2/2 |
| F5 LOW: lab-infra runner guard disagreed with the hub layer-2 check | guard now lists names with `list-unit-files` and `list-units --all`, describes each with `show --all`, refuses root units that are active or enabled (same sets as `bridge/write-gate.mjs`), fails closed on a missing unit | lab-infra `RunnerGuardTests` (9 tests, live sample: drop root, enabled, stopped) | yes, 7 failures including `test_fix_f5_enabled_stopped_root_runner_is_refused_like_the_hub` |
| F6 LOW: `accepted` promised safe retries for non-idempotent ops | only `task_claim`, `worktree_push`, `github_create_pr`, `jobs_submit` (`RETRY_SAFE_OPS`) get an injected `client_request_id` and may answer `accepted`; other mutating ops wait for their outcome | `tests/remote-deadline.test.mjs`: `fix F6 ...` | yes |

Plausible findings P1 to P7 are not fixed in code (none is HIGH or CRITICAL as reported); they
are listed in `state.json` under the open follow-ups.

### End-to-end path (TODO-P5-11, `tests/remote-e2e.test.mjs`)

An `@modelcontextprotocol/client` with a locally minted owner token (ES256, `typ: at+jwt`,
`client_id` the ChatGPT CIMD URL) over HTTPS to the public listener built by
`bridge/remote-boot.mjs` from a lab-infra shaped `remote.json`, through the remote surface, the
forwarder, the hub v2 envelope, a real agent and a real runtime on a temporary Git repository
with a bare origin.

- Stage R: `tools/list` equals `REMOTE_TOOLS_READ`, every tool has the three hints; `projects_list`
  returns `demo` from the `owner/repo` allowlist entry; `workspace_list` works and carries the
  hub `request_id`; a forged `task_claim` is refused and journaled `remote_denied`
  `write_gate_closed`; a forged full-capability envelope to the runtime is `forbidden` and
  journaled there; the wire principal is `{id, client_type: chatgpt}`.
- Stage W (writes enabled, systemctl fixture with no root runner): `tools/list` equals
  `REMOTE_TOOLS`; `host: mac` refused; `workspace_open` stores `chatgpt`/`vps`; unlisted project
  refused; `task_claim` and its retry (`replayed`); a write from another conversation gets
  `session_warning` on the coordinator and on the worktree runner; `branch: main` refused
  (`protected_branch`); a file write accepted; `.github/workflows/evil.yml` refused
  (`path_protected`); a 100 KiB write refused (`content_too_large`); commit and push reach the
  bare origin on the workspace branch, `main` untouched; push retry replayed; the runtime event
  and the hub journal line share `request_id`, with `via: hub`, `client_type: chatgpt`; no token,
  argument value, session value or file content in either journal.
- Stage W with a root runner fixture: the listener is never built (`remote writes refused: root_runner`).

### Mutation checks of the integration (scratchpad `integ_mutate.py`, `lab_mutate.py`)

Each integration fix was removed alone and the targeted suites rerun; every removal below was
caught, then restored (the final suite runs above are on the restored code).

memo-bridge (28 of 28 kept fixes caught): envelope meta, envelope client_type, agent meta to
ops, runtime ops `extra.meta`, coordinator tools meta, worktree tools `ctx.meta`, worktree audit
`request_id`, `client_request_id` on `task_claim` and on `worktree_push`, runtime owner grant from
`remote.json`, runtime write stripping, runtime refusal without a policy, runtime audit
`client_type`, boot write gate probe, 401 limiter, invalid-token counting, unlisted call journal,
client certificate facts, loopback-only HTTP JWKS (both directions), `owner/repo` project entries,
strict unknown keys, `MEMO_BRIDGE_OIDC_SETTINGS` refusal, `createHub` OIDC refusal, coordinator
receives the runtime policy, surface bounds checked at parse, `principalFromWire` and
`wireClaim` client_type, unlisted-call hook wiring, policy soft deadline and owner sub. One
mutation survived (reusing the forwarder request id as the hub wire id); that unverified
behaviour was removed instead of kept untested.

lab-infra (8 of 8 caught): runner drop-in task, runner required with the listener, release check
file, `remote.json` restarts the runner, runner-off removal never restarts, a stray
`remote.json` key, JWKS over public HTTP, runner drop-in variable name.

Implementer mutation runs before integration: oidc-listener 13 guards caught (one survivor: the
`mcp-session-id` header strip, which only backs up the SDK); remote-surface 10 of 10;
write-invariants 27 of 28 (survivor: the early path check in `writeFile`, redundant on purpose
with the resolved-path check); lab-infra 19 of 19.

## Acceptance criteria status

| AC | Status | Evidence / what remains |
|---|---|---|
| AC-P5-01 | not started (rt) | needs the deployed route: curl from the Mac and from a product container |
| AC-P5-02 | verified (auto) | `tests/oidc-verifier.test.mjs`, `tests/public-listener.test.mjs`, e2e (a valid owner token lists tools) |
| AC-P5-03 | auto part verified; rt pending | `tests/public-listener.test.mjs` (405, 403 Origin, 413, 403 `insufficient_scope`, both PRM paths, `MCP-Protocol-Version` passthrough); loopback 9445 on the VPS pending |
| AC-P5-04 | not started (rt) | enrollment window |
| AC-P5-05 | not started (rt) | enrollment window |
| AC-P5-06 | verified (auto) | `tests/remote-surface.test.mjs` (stdio parity), e2e stage R |
| AC-P5-07 | auto part verified; rt pending | hub refusal journaled (e2e stage R), runtime refusal journaled, start refusal on a root-runner fixture (`tests/remote-boot.test.mjs`, e2e); a real `systemctl` run on the VPS pending |
| AC-P5-08 | verified (auto) | `tests/policy-remote.test.mjs`, e2e stage W |
| AC-P5-09 | verified (auto) | `tests/remote-write-guard.test.mjs`, `tests/remote-allowlist.test.mjs`, e2e stage W |
| AC-P5-10 | verified (auto) | `tests/remote-session-binding.test.mjs`, e2e stage W (coordinator and worktree, warn mode) |
| AC-P5-11 | not started (man + rt) | two live conversations |
| AC-P5-12 | not started (man + rt) | live recovery |
| AC-P5-13 | verified (auto) | `tests/remote-bounds.test.mjs`, e2e (100 KiB write refused) |
| AC-P5-14 | verified (auto) | `tests/remote-deadline.test.mjs` |
| AC-P5-15 | auto part verified; rt pending | `tests/remote-ratelimit.test.mjs`, `tests/remote-boot.test.mjs` (401 bucket keyed on the trusted proxy header); Traefik 429 burst pending |
| AC-P5-16 | auto part verified; rt pending | e2e (shared `request_id`, no `eyJ`, no argument or content); journald grep on the VPS pending |
| AC-P5-17 | auto part verified; rt + man pending | `tests/remote-boot.test.mjs` (503); route removal drill pending |
| AC-P5-18 | partial (insp) | lab-infra tests and check mode; `make check` after deploy and the amended AC-P4-14 on the VPS pending. AC-P4-14 and REQ-P4-14 amended in `.agent/project/phase-4/spec.md` |
| AC-P5-19 | not started (man + rt) | read-stage connection |
| AC-P5-20 | not started (man + rt) | needs #161 closed and the write gate open |
| AC-P5-21 | partial | green on Node 24.21.0; Node 22 not installed here, not run |
| AC-P5-22 | partial (insp) | `docs/REMOTE_CHATGPT.md`, `docs/OIDC_RESOURCE.md`, `docs/HUB_SECURITY.md`, README, SECURITY.md written; matching against the deployed config waits for the deploy |

## Deviations from the spec (decided during integration)

- `bridge/scopes.mjs` was folded into `bridge/oidc.mjs` (scope map, ceiling, `writeGateOpen`).
- The 9443 MCP surface (`makeMcp`) is kept for Phase 4 loopback clients; its OIDC mode and
  `oidcGuard` (scope `hosts:read`, no `typ` check) were removed instead.
- Results stay compact text JSON, not `structuredContent` plus a one-line summary (REQ-P5-14
  wording): stdio parity kept, budget counted once.
- The runner grants the owner from `remote.json` (`oidc.owner_sub`, role from `remote_writes`)
  rather than from a `MEMO_BRIDGE_HUB_PRINCIPALS` entry: one file decides the gate on both sides.
- Pocket ID stays on its own network (`memo-bridge-auth_default`) instead of `lab` (lab-infra
  implementer decision, so product containers cannot reach `/setup`).
- JWKS read over HTTP on Pocket ID's loopback port; accepted for loopback address literals only.
- `remote.json` project entries are `owner/repo`; memo-bridge allows the catalog project named
  after the repository (inference: the pilot repositories are registered under their repository
  name; a mismatch fails closed with `project_not_allowed`).

## Conductor batches (TODO-P5-50 to 52), 2026-10-14

- Tools `batch_create` (github:write), `task_next` (coordinator:write), `batch_status` (read), in
  `server/coordinator/batches.mjs` and `server/coordinator/index.mjs`, registered in
  `server/tools/coordinator-tools.mjs`; remote lists, policy, ops timeouts and `RETRY_SAFE_OPS`
  updated. A batch is a GitHub label; claims go through `operations.taskClaim`.
- `tests/batches.test.mjs`, 9 tests: creation and labels, input refusals and partial batch,
  replay on `client_request_id`, 10 parallel `task_next` on 10 tasks (10 distinct claims, 10
  ledger workers, the 11th call `done:true`), lost race and foreign lease skipped, ledger failure
  stops, lease expiry (stale in `batch_status`, then taken over), status shape and states,
  remote classification, gate layer 1, read-only refusal, project allowlist, session binding.
- `npm test`: 348 pass, 0 fail (339 before, plus the 9 new tests).
  `npm run smoke`: ok, 51 tools. `npm run smoke:remote`: 7 pass.
- `npm run remote:toolsize`: read 23 tools, 15 627 bytes; write 39 tools, 34 502 bytes.
- Not verified: GitHub label creation and Issue creation against the real API (the in-memory
  GitHub follows the documented REST contract; label auto-creation on Issue creation is not
  documented, so the batch label is created explicitly with POST /labels first).
