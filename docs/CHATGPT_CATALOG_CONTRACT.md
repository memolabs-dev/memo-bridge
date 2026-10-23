# ChatGPT simple MCP catalogue contract

Owner-facing surface: `simple`. Source: `server/registry.mjs`. Since 2026-10-23 this is exactly **26 tools** (2 project tools and 24 operator tools), while `full` is explicitly opt-in. A source-code test passing is **not** proof that ChatGPT has refreshed its installed tool metadata.

## Automated, safe regression

Run `node --test tests/chatgpt-simple-contract.test.mjs` (also included by `pnpm test`). Its fixture sends real MCP JSON-RPC `tools/list` and `tools/call` requests through the remote request handler with a simulated owner identity and a no-side-effect dispatcher. It checks all 26 names, metadata, argument routing, exclusions and default fail-closed behavior. It never touches the Mac, VPS or GitHub.

## Required production verification before saying fixed

1. Record **source SHA, deployed `/opt/memo-bridge/app/RELEASE` SHA and deployment time**. The release SHA, not the GitHub branch, determines what the hub runs.
2. Confirm the nonsecret active `remote.json.surface` value is `simple` through the owner's trusted deployment diagnostics; never print tokens, client secrets or private keys.
3. Using the already authenticated ChatGPT connection, inspect the model-visible tool list after **refreshing** Memo Bridge in ChatGPT's Plugins settings. It must show the same 26 tool names as `SIMPLE_REMOTE_TOOLS + SIMPLE_REMOTE_OPERATOR_TOOLS`.
4. In that connection, perform safe calls to `projects_list`, `operator_policy`, `operator_snapshot` and `operator_preflight`, then a deliberately invalid-argument call to a simple tool. An invalid argument should cause a schema error, **never** `Tool not found`. A full-only tool should be unlisted/unavailable.
5. Confirm the hub/operator journal contains correlated requests with success or precise refusal and no secret material. Confirm operator read/write permissions and locks did not change.
6. If ChatGPT still sees old tools, separate **cached client metadata** from **server configuration** by comparing a fresh authenticated MCP `tools/list` response with the model-visible list. Do not solve a cache problem by widening server permissions or changing to `full`.

This checklist is a deployment **blocker** for catalogue-affecting changes. Record observed tool count, exact missing/extra names, release SHA, request IDs and the resulting evidence in issue #279. Never mark fixed based only on this offline smoke test.

## Other release gates

- Branch, unit tests and CI green on the exact head SHA.
- Two-session Git checkout race gate (issue #263) before declaring concurrent edits safe.
- External user journey and factual/métier evidence before saying a product is production-ready (issue #281).
- Protected operations remain policy-checked on the host. The absence of Telegram prompts is **not** evidence that a change is safe.
