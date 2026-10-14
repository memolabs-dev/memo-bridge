# GitHub App installation tokens for the VPS runner

Branch `feat/app-tokens` (memo-bridge) and `feat/memo-runner-app-tokens` (lab-infra).

Intent: the VPS runner gets its GitHub write credentials from the GitHub App `memo-labs-automation` (App id 5298579, installation 170927025 on `memolabs-dev`), as installation tokens minted on demand, one repository and the minimal permissions each, instead of long-lived fine-grained PATs. The owner never handles a token. The PAT path keeps working as a fallback.

Non-goals: GitHub reads outside the pull request flow (they keep gh's environment), the Mac (no `$CREDENTIALS_DIRECTORY`: unchanged), deploying, adding repositories to the installation (owner step).

Sources (read 2026-10-14): [JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [authenticating as an installation (Git over HTTPS)](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [stateless token format changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header). Reference implementation validated live 2026-10-13: `os/integrations/github/scripts/with-app-token.py` (App id as `iss`, iat-60, exp under 10 min, one repository, explicit permissions, returned permissions checked, 5 minutes left).

## Requirements and acceptance

| ID | Requirement | Acceptance | Evidence |
|---|---|---|---|
| AT-R1 | RS256 JWT, iat 60 s in the past, exp at most 10 min, iss App id (or client id when set) | signature verifies with the public key, claims exact | `tests/github-app.test.mjs` "appJwt" |
| AT-R2 | Installation token narrowed to one repository and the minimal permissions per purpose (ledger: `.github` contents:write; push: contents:write; PR: contents+pull_requests write) | fake API receives exactly those bodies | "mint" |
| AT-R3 | Cache per (repo, permissions) until 5 min before expiry; concurrent requests mint once | one POST for 3 concurrent calls; refresh at the margin | "cache" |
| AT-R4 | Response checked (scope, repository, expiry, token shape, App identity); foreign owner never requested | each bad answer is a short code, nothing cached | "responses are checked" |
| AT-R5 | PAT fallback exactly as before when no App; App failure falls back to the PAT and is logged | PAT mode returns the files; fallback event | "fallback" |
| AT-R6 | Ledger gets the App token in its python child only | child GH_TOKEN equals token, process.env untouched | "ledger with the App" |
| AT-R7 | Git push with the App and no push-gh, token via askpass file removed after; no token in argv, env, store or journal | real git against a local bare origin | "runner push with the App" |
| AT-R8 | PR creation passes GH_TOKEN per gh call with a private config dir, never process-wide | recording gh | "pull request creation" |
| AT-R9 | agent-cli starts with App only; refuses an unusable App without ledger-gh; logs fallback | real entry point | "agent-cli" |
| AT-R10 | No token, JWT or key in logs or errors | events inspected | "no token" |
| AT-R11 | Stateless JWT-shaped `ghs_` tokens accepted (dots, about 520 chars) | readTokenFile and askpass | "token pattern" |
| AT-R12 | Existing suites unchanged and green | pnpm test, smoke, smoke:remote, test:deploy, test:runner, build | evidence below |
| AT-R13 | lab-infra loads `app-key` from the Mac PEM at deploy, 0600 credstore, App ids in group_vars, push-gh optional and absent by default, no change on lab while the runner is disabled | lab-infra tests and `./scripts/tests.sh` | lab-infra branch |
| AT-R14 | Live mint, push and PR from the VPS | runtime check after deploy | **pending: owner deploy** |

## Risks

| Risk | Level | Handling |
|---|---|---|
| Ledger preflight reads a pilot repository's Issue with a token narrowed to `.github` | medium | pilot repos are public (preflight refuses others); public reads work with any token (inference, to confirm live, AT-R14). Fallback: `ledger-gh` |
| Repository not added to the installation | medium | `app_token_http_422`, PAT fallback if present; owner step listed |
| App token on disk during a Git call | low | 0600 file in a 0700 state dir, removed after the calls, stale purge after 2 h, token expires in 1 h; the PAT it replaces lives on disk permanently |
| `repositories` absent from GitHub's answer | low | accepted (narrowing requested, GitHub enforces); checked when present |

## Evidence (2026-10-14)

- `pnpm test`: 379/379 pass (new file `tests/github-app.test.mjs`: 14/14).
- `pnpm run build` ok; `pnpm run smoke` ok (51 tools); `pnpm run smoke:remote` 7/7; `pnpm run test:deploy` 113 OK; `pnpm run test:runner` 138/138 and 113 OK.
