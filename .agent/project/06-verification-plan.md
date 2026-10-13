# Verification plan
STATIC: node --check via test import; build (esbuild) succeeds.
UNIT/INTEGRATION: npm test (coordinator, store contract, concurrency, catalog, probe).
SYSTEM: npm run smoke on bundled build (20 tools + round trip).
RUNTIME: bundled server against real ~/projects/PROJECTS.md with temp state dir.
INDEPENDENT: verifier subagent tries to falsify AC-01..AC-12.
CI: PR checks green.
