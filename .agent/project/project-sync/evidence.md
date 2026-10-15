# GitHub Projects view: one-way sync (2026-10-14)

Short-form Whole Project Protocol record. Branch `feat/project-sync`, from `origin/main` c2592bd.
Nothing pushed, nothing deployed, no write to the real board.

2026-10-15: merged into main as #22 and deployed on lab in `memo_bridge_version` a8f5a60
(2026-10-15 11:10 Paris). No live write to the board is recorded.

## Change

The Coordinator mirrors its tasks onto a GitHub Projects (v2) board, "Memo Labs OS"
(`memolabs-dev/1`). Issues and the lease ledger stay the source of truth; the board is a view.
Off unless `MEMO_BRIDGE_PROJECT=owner/number` is set. Code: `server/integrations/project-sync.mjs`,
hooks in `server/coordinator/index.mjs` and `server/tools/github-tools.mjs`, wiring in
`server/runtime.mjs`, `ghGraphql` in `server/integrations/github.mjs`. Docs: `docs/COORDINATOR.md`
("GitHub Projects view"), `README.md`.

## Acceptance criteria and evidence

| ID | Criterion | Evidence |
|---|---|---|
| AC-PS-01 | Off by default; no GraphQL call, no `project_url` | test "disabled by default" |
| AC-PS-02 | Field and option ids read at runtime, cached, re-read after expiry; never hard-coded | test "field and option ids are discovered once..." (fake board uses ids unlike the real one) |
| AC-PS-03 | batch_create: add, then Status Prêt, Priorité, Lot; add and update never in one call | test "batch_create adds each Issue..." |
| AC-PS-04 | task_claim and task_next: Réservé and Agent from client_type | test "task_claim and task_next..." |
| AC-PS-05 | github_create_pr: En revue on the task, PR added as En revue; refusals do not touch the board | test "github_create_pr moves the task..." |
| AC-PS-06 | task_complete Fait; release blocked Bloqué; failed or cancelled and workspace_close Prêt | test "task_complete sets Fait..." |
| AC-PS-07 | Expired lease seen by batch_status: Prêt once per expired lease, never for a reader; batch_status returns project_url | test "batch_status returns the board URL..." |
| AC-PS-08 | Failure isolation: operation result unchanged, never waits (hung runner), journaled as project_sync_failed with a code | tests "failure isolation" (2) and "a hook that timed out sends no further write" |
| AC-PS-09 | No token in the journal or in ghGraphql results | tests "failure isolation..." and "ghGraphql: fixed argv..." |
| AC-PS-10 | Real GitHub schema matches the queries and mutations | live read-only run below |

## Verification

| Command | Result |
|---|---|
| `npm test` | 365 pass, 0 fail (17 new in `tests/project-sync.test.mjs`) |
| `npm run build` then `npm run smoke` | ok, `{"ok":true,"tools":51,"roundTrip":true,...}` (smoke needs the build first) |
| `npm run test:deploy` | 113 OK |
| Live, read-only: project-sync with every mutation refused, against `memolabs-dev/1` and `memolabs-dev/memo-bridge#1` | fields query and `issueOrPullRequest` query ok; first mutation refused as intended |
| Live, read-only introspection | `AddProjectV2ItemByIdInput(projectId, contentId)`, `UpdateProjectV2ItemFieldValueInput(projectId, itemId, fieldId, value)`, `ProjectV2FieldValue{text, singleSelectOptionId: String}`, `IssueOrPullRequest = Issue or PullRequest` |

## Decisions and open points

- `task_create` does not exist in the Coordinator: the creation hook is wired to `batch_create`
  only (`taskCreated` is ready for a future `task_create`).
- `runner` is not a `client_type` today (`policy.mjs CLIENT_TYPES`), so `Runner VPS` is never
  chosen until one is added; `codex`, `cli`, `other` map to `Humain` as specified.
- "Stale lease takeover sets Prêt": implemented as batch_status seeing an expired lease (anyone
  may take it over) and setting Prêt once per expired lease; the takeover claim then sets
  Réservé. Only a write-capable principal triggers that board write.
- Owner acceptance: a live run with `MEMO_BRIDGE_PROJECT=memolabs-dev/1` (mutations untested live).
