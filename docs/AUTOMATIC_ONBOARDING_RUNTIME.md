# Automatic onboarding runtime — guarded ingress and durable effects

Status: implementation staged in [#123](https://github.com/memolabs-dev/memo-bridge/issues/123). **Not wired to a production service or permissions.** Uses the pure state machine from [#116](https://github.com/memolabs-dev/memo-bridge/issues/116).

## Pipeline

1. A GitHub App webhook receiver forwards the **raw** request bytes, `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery` to `ingestOnboardingWebhook`.
2. The handler rejects bad signature, payload >256 KiB, unknown org, unexpected repo identity, untrusted event type or missing owner-configured dependencies. It does not read policy from the webhook.
3. A trusted provider reads the host-local catalog and **fresh** GitHub evidence using a token scoped to the **exact repository and installation**. GitHub webhook fields alone never grant access.
4. The reconciler evaluates the reviewed organization policy, main-branch opt-in manifest, App token proof, governance/infra receipts and CI SHA. It produces at most one reviewed proposal per repo/cycle; failed CI or hold prevents activation.
5. A fixed-capability adapter proposes changes in *separate PRs*; the existing landing contract controls merging. The adapter NEVER calls `git push main`, `gh pr merge`, deployment, App access writes or an arbitrary command from a webhook.
6. `OnboardingActionStore` uses SQLite transaction `BEGIN IMMEDIATE` and stable action IDs. It records a time-bounded reservation with a random token, durable receipt or retryable failure. A stale holder cannot finish a replacement reservation.
7. A recurring reconciliation job (hourly) retries incomplete actions. A repo removal suspends new work.

## Modules

- `server/onboarding-auto-ingress.mjs` — validated raw webhook ingress; **no caller-supplied policy**.
- `server/onboarding-auto-http.mjs` — minimal HTTP adapter with fixed path, POST-only, JSON type, body cap, concurrency cap, bounded error codes.
- `server/onboarding-auto-store.mjs` — SQLite CAS receipt store; admin chooses the DB location. Never accept a DB path from a PR, webhook, or user-controlled source.
- `tests/onboarding-auto-ingress.test.mjs` — forged webhooks, replay, restart, expired leases, removal and HTTP request boundaries.

## Required wiring to actually activate

This PR does **not** install a daemon. A separate reviewed `lab-infra` change must:
- Bind the HTTP server to loopback or a private Unix socket, behind the existing hub authentication and Traefik request limits. Never listen directly on `0.0.0.0`. Provide webhook secret via the existing secret store, not an environment file inside any checkout or logs.
- Configure an **owner-approved** policy for `memolabs-dev` and the installation ID, default deny on other orgs. Organization-wide enrollment requires explicit owner approval and the manifest on `main`.
- Supply a fresh scoped-App evidence provider (repo ID, full name, default branch, contents at main, CI exact SHA, App token installation scope), a host-local canonical catalog reader and an effects adapter constrained to the pre-existing reviewed PR routes.
- Put the database in a restricted private directory and back it up using the existing safe-state policy. Bind replay state to actual receipts/PR IDs, never only the request delivery ID; reconcile after restart.
- Add an hourly timer or systemd schedule; enforce one coordinator instance or database fencing and publish redacted audit receipts.
- Test wrong-SHA / pending / `hold-merge`, App removal, expired leases, duplicate delivery, 401 request, 503 provider failures and rollback on a disposable repository.
- Do not mark #100 complete until both initial product PRs land safely and `projects_list` reports `available: true` on VPS.

The GitHub App for this organization currently selects **specific** repositories. A one-time owner decision is still needed to grant the new private repos to the App or to adopt an explicit organization-wide policy; never silently broaden access because auto-onboarding code exists.
