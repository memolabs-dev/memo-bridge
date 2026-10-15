# Evidence (2026-10-15, local)

- `pnpm test`: 595 tests, 595 pass. `pnpm run build`: pass. `pnpm run smoke`:
  `{"ok":true,"tools":61,"roundTrip":true,...}`. No governance variable needed.
- Mutation checks (each applied alone, tests/remote-boot.test.mjs and
  tests/public-listener.test.mjs run, then reverted): 9/9 caught. Gate removed; bare challenge
  requiring a certificate; SAN substring match; expected_san ignored; CN read from the issuer;
  no certificate facts on the 401 line; `require` not parsed; the gate charging the 401 bucket;
  the listener accepting an unknown mode.
- lab-infra `bash scripts/tests.sh`: 115 green, 0 red. Mutation checks on the lab-infra side: 6/6
  caught (ingress var assert, deployed remote.json check, memo-bridge role assert, release marker,
  lab mode back to log, template hardcoding log).
- Live evidence before the change: see spec.md, "Facts".

## Live, after deploy (2026-10-15)

- lab-infra #227 merged (4b43f21), `make deploy-memo-bridge` then `make deploy-memo-bridge-ingress`,
  both `failed=0`. Hub log `public_listener_started` carries `"client_cert":"require"`.
- From outside: POST /mcp with `authorization: Bearer x` and no certificate: 403
  (`public_refused`, `client_cert_required`). Bare POST /mcp: 401. GET
  /.well-known/oauth-protected-resource/mcp: 200.
- ChatGPT called `projects_list` at 07:22:34Z: `public_request` status 200, `client_cert:true`,
  `client_cert_san:true`. No `client_cert_required` line for ChatGPT since the deploy.
