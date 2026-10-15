# Client certificate required on the public endpoint (owner decision 2026-10-15 08:22, option A)

Intent: only ChatGPT, through OpenAI's connector client certificate, calls Memo Bridge tools on
`https://bridge.memolabs.dev/mcp`; the dated measurement window of lab-infra goes.

Completion sentence: done when the hub refuses every credentialed `/mcp` request without
Traefik's verified certificate info (403 `client_cert_required`, journaled), ChatGPT's discovery
still works without a certificate, lab-infra renders `client_cert.mode: "require"` and accepts
`VerifyClientCertIfGiven` permanently only with it, tests and mutation checks pass, and the owner
has seen ChatGPT connect and call tools after the deploy.

## Facts the design rests on

- TLS client auth applies per SNI host, not per path. With `RequireAndVerifyClientCert`
  (2026-10-14) ChatGPT's discovery never completed: some discovery request carries no certificate.
- Traefik access log, 2026-10-14 13:11:45 and 20:46:11 (two ChatGPT connections): from OpenAI
  addresses 9.160.128.x, an unauthenticated `POST /mcp` (401) and `GET
  /.well-known/oauth-protected-resource/mcp` (200), next to authenticated `POST /mcp` (200).
  Which of the two discovery requests lacked the certificate is not observable: the 401 line did
  not record certificate facts before this change (it does now).
- Hub journal 2026-10-13 to 2026-10-15: 222 `public_request` lines, all `client_cert: true`,
  `client_cert_san: true`; 24 `public_auth_denied` (22 `no_credentials`, 2 `too_old`).
- Traefik strips client-sent `X-Forwarded-Tls-Client-Cert*` at the entrypoint and passes the info
  of a certificate matching the `clientAuthType` policy only (Traefik passTLSClientCert reference:
  entries URL-escaped, joined by `,`; `SAN="a,b"` inside an entry).
- OpenAI documents the connector certificate SAN `mtls.prod.connectors.openai.com`
  (phase-5/research-vps.md).

## Decision

| ID | Decision | Why |
|---|---|---|
| CC-D1 | Bare 401 (no `Authorization`) and the two metadata paths stay open without a certificate. | They are ChatGPT's discovery (access log above); requiring the certificate there is what broke ChatGPT at TLS. Neither runs a tool or says more than the public metadata. |
| CC-D2 | Any request carrying `Authorization` without the info header: 403 `client_cert_required`. | Covers `initialize`, `tools/list` and every `tools/call`; ChatGPT always presented the certificate with a token (222/222). |
| CC-D3 | The check runs before token verification and does not charge the 401 flood bucket. | Equivalent to TLS refusing the caller: a token replayed from outside OpenAI learns nothing about its validity and costs no JWKS work; strangers cannot spend the bucket shared with the owner's OpenAI addresses this way. |
| CC-D4 | With `expected_san`, the certificate must name it exactly, as a SAN value or else the subject CN. | Exact parsing replaces the substring check; CN fallback avoids an outage if the SAN layout differs from the documentation (the live `includes` check could not tell SAN from CN). |
| CC-D5 | The 401 and 403 lines carry `client_cert` / `client_cert_san`. | Shows whether discovery ever carries the certificate, for a later move to TLS-level require. |
| CC-D6 | lab-infra: `VerifyClientCertIfGiven` is permanent and supported only with hub mode `require` (group_vars, deployed `remote.json`, and the memo-bridge role itself); the pinned release must contain `client_cert_required`. | Fail closed on every path that could leave tokens accepted without a certificate. |

## Requirements and acceptance

| ID | Acceptance | Evidence |
|---|---|---|
| CC-R1 | `client_cert.mode` accepts `require`; unknown modes refused in remote.json and in the listener options | tests/public-listener.test.mjs (parsing, structural separation) |
| CC-R2 | Token without certificate: 403 JSON `client_cert_required` for initialize and tools/list, journaled `public_refused` | tests/remote-boot.test.mjs "client certificate required" |
| CC-R3 | Garbage token without certificate: 403 too, 401 bucket not charged | same test |
| CC-R4 | Metadata paths and bare 401 reachable without certificate; 401 line has `client_cert:false` | same test |
| CC-R5 | Certificate present but wrong name, look-alike or malformed: 403; SAN or CN exact match: 200 | same test, "certificate names" |
| CC-R6 | Without `expected_san`, any verified certificate info suffices | "without expected_san" |
| CC-R7 | `log` mode unchanged (never refuses) | "client certificate logging" |
| CC-R8 | Whole suite, build, smoke green | evidence.md |
| CC-R9 | lab-infra renders require, removes the window, asserts on both roles and the deployed file | lab-infra test_memo_bridge_public.py, scripts/tests.sh |
| CC-R10 | ChatGPT connects and calls tools after deploy; curl with a token and no certificate gets 403 | evidence.md, "Live, after deploy" |

## Risks

- R1 (medium, mitigated): ChatGPT sends a token on a request without certificate. Observed 0/222;
  the post-deploy check catches it; rollback is `make memo-bridge-public-off`.
- R2 (low): Traefik info format differs from the reference. CN fallback; post-deploy check.
- R3 (low): deploy order. A release without the mode refuses remote.json; the memo-bridge role
  refuses `require` with such a release before copying anything.
