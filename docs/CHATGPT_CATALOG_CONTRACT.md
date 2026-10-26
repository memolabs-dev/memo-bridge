# ChatGPT simple MCP catalogue contract

Owner-facing surface: `simple`. Source: `server/registry.mjs`. Since 2026-10-26 the proposed next release lists **28 tools** (2 project tools, 24 operator tools and 2 narrowly scoped design tools), while `full` is explicitly opt-in. A source-code test passing is **not** proof that ChatGPT has refreshed its installed tool metadata.

## Automated, safe regression

Run `node --test tests/chatgpt-simple-contract.test.mjs` (also included by `pnpm test`). Its fixture sends real MCP JSON-RPC `tools/list` and `tools/call` requests through the remote request handler with a simulated owner identity and a no-side-effect dispatcher. It checks all 28 names, metadata, argument routing, exclusions and default fail-closed behavior. It never touches the Mac, VPS or GitHub.

## Required production verification before saying fixed

1. Record **source SHA, deployed `/opt/memo-bridge/app/RELEASE` SHA and deployment time**. The release SHA, not the GitHub branch, determines what the hub runs.
2. Confirm the nonsecret active `remote.json.surface` value is `simple` through the owner's trusted deployment diagnostics; never print tokens, client secrets or private keys.
3. Using the already authenticated ChatGPT connection, inspect the model-visible tool list after **refreshing** Memo Bridge in ChatGPT's Plugins settings. It must show the same 28 tool names as `SIMPLE_REMOTE_TOOLS + SIMPLE_REMOTE_OPERATOR_TOOLS + REMOTE_DESIGN_TOOLS`.
4. In that connection, perform safe calls to `projects_list`, `operator_policy`, `operator_snapshot` and `operator_preflight`, then a deliberately invalid-argument call to a simple tool. An invalid argument should cause a schema error, **never** `Tool not found`. A full-only tool should be unlisted/unavailable.
5. Confirm the hub/operator journal contains correlated requests with success or precise refusal and no secret material. Confirm operator read/write permissions and locks did not change.
6. If ChatGPT still sees old tools, separate **cached client metadata** from **server configuration** by comparing a fresh authenticated MCP `tools/list` response with the model-visible list. Do not solve a cache problem by widening server permissions or changing to `full`.

This checklist is a deployment **blocker** for catalogue-affecting changes. Record observed tool count, exact missing/extra names, release SHA, request IDs and the resulting evidence in issue #279. Never mark fixed based only on this offline smoke test.

## Open Design façade: security and verification

- The two tools, `design_create` and `design_status`, are exposed only when the authenticated owner has `operator:exec` and `remote_writes: enabled`. No additional scope is introduced. Requests are translated into the existing **Mac-only** `operator_run` (T2) with a fixed program `/Users/memo/bin/opencode-v2` and fixed `od-create` / `od-status` operations.
- An agent cannot provide an arbitrary shell, executable, host, model, provider or command flag; its only design inputs are a name, brief and optional checked design-system/skill IDs. The Mac operator enforces its own policy, resource limits and cross-session locks.
- `accepted` means started, not finished. `verified:true` from `design_status` means a completed generation with a nonempty artifact was found; it does NOT certify browser rendering, accessibility or production readiness. Independently check desktop/mobile screenshots, focus, overflow and console errors before a real product handoff.
- The Mac must have the Open Design app and isolated OpenCode/Lab Code adapter configured. Missing prerequisites fail with a short code. The test fixtures dispatch no real shell commands or network calls.

## Other release gates

- Branch, unit tests and CI green on the exact head SHA.
- Two-session Git checkout race gate (issue #263) before declaring concurrent edits safe.
- External user journey and factual/métier evidence before saying a product is production-ready (issue #281).
- Protected operations remain policy-checked on the host. The absence of Telegram prompts is **not** evidence that a change is safe.
