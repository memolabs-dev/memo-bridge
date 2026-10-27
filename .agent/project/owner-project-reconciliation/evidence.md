# Evidence

EV-01: Mac isolated checkout, focused Node tests: 37 passed, 0 failed (2026-10-27).
Temporary HOME only, including real installer staging test; no live configuration touched.
EV-02: pnpm build passed (standalone read-only smoke included).
Full regression suite, deployment tests, CI and independent review still pending.
Production installation and live smoke BLOCKED: operator_preflight path_secret, recorded
blocked_observer ffea47bd-d9b2-413d-8a86-9acbd09acef8. No alternate privileged path used.
