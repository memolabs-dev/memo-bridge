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
