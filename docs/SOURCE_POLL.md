# Source Engine autonomous poller — issue #122

**Implementation status: code + opt-in templates only. NOT installed or enabled on any host by this PR.**

## Existing architecture reused

- Memo Bridge Coordinator SQLite and verified `PROJECTS.md`: identity and durable worktree/checkpoint provenance.
- Source Engine V0 `recordSourceChange`: append-only, revision-fenced snapshots.
- GitHub App scoped **read** operations already provided by `createGitHub`; no new token permission.
- The #108 `reconcileSourceProject`: read-only GitHub PR/check inspection and private Source Engine updates.
- Existing #88/#86 landing policy remains solely responsible for independently checking reviews, required CI, head SHA and branch protection before merging.

## Admission rules for NEW records

A PR can be discovered only when every assertion holds:

1. Project is an operator-allowlisted **locally available** repo in canonical `PROJECTS.md`; verified registered origin matches the GitHub repository.
2. Same-repository head origin, permitted **exact author**, target equals live default branch; valid 40-character head SHA.
3. A Coordinator worktree *already* links a canonical Issue in that origin to that exact branch.
4. A prior **remote** checkpoint for the *same* Issue, workspace and branch attests the **exact** PR head SHA.
5. The identity match is unique, its Source Engine stable ID is not already claimed by an unrelated record.

The PR title, body, `Closes #123` marker and `agent/` branch name **alone never establish identity**. Forks, branch rewrites, foreign authors, missing or stale checkpoints and incomplete metadata fail closed. Reads are bounded to 40 GitHub PRs, 100 local worktrees, and 500 Source Engine records per project. When a page bound prevents exhaustive proof, the poller reports that limitation or refuses discovery; it does not assume missing records are closed.

The first observed CI state is `unknown`. The existing #108 reconciler checks exact SHA and treats absent, pending, stale, truncated or failing CI accordingly. Neither module approves or merges anything.

## Opt-in policy

The operator, **not GitHub and not a ChatGPT tool argument**, owns the private `<MEMO_BRIDGE_STATE_DIR>/source-poll-policy.json` file. It must be a regular (not symlinked), owner-owned, 0600 file. Example canary:

```json
{
  "enabled": true,
  "apply": false,
  "projects": ["memo-bridge"],
  "trustedAuthors": ["memo-labs-automation[bot]"]
}
```

`enabled: false` is the default when no valid private policy exists. `apply: false` performs a **non-mutating discovery dry-run**. Only the operator may change it to true after observing evidence, checking source authorization and landing protections. The file must stay in the already private state directory; **never commit it**.

`node server/source-engine/poll-cli.mjs` runs exactly one pass. It emits only bounded receipts under the Coordinator state directory (`source-poll-receipts.jsonl`, mode 0600) plus one audit event. It does not become a new MCP write tool or expand its permissions. A failure backs off exponentially (15, 30, 60, 120 minutes, capped at two hours) based on previous local receipts; the operator can inspect its retry-after.

## VPS scheduler template — deliberately not installed

Two templates live at `deploy/source-poll/`: `memo-source-poll.service.example` and `memo-source-poll.timer.example`. An operator must first verify the actual VPS checkout, restricted runner user, local catalog root, state directory and GitHub App read-only credential delivery. Replace `@@...@@` paths, then verify the rendered systemd unit before installing. The timer runs roughly every 15–18 minutes, with deterministic rate limits and randomized systemd jitter. The service uses nonblocking `flock` to prevent overlapping OS-process runs; code also guards against concurrent use of the same in-process store.

Do **not** expose the private policy or secrets through GitHub Issues, job logs or pull requests. Do **not** grant the poller repository write/merge credentials. Use a read-only scoped installation token; Coordinator-only local observations are its sole side effect.

### Canary evidence to collect

- Dry-run output identifies tracked PRs and trustworthy discovery candidates only; no new SQLite source rows.
- An expected first-party PR (same exact SHA as Coordinator checkpoint) can be imported once; replay adds no new event.
- Fork, spoofed title, stale SHA, untrusted bot, no GitHub scopes, missing checks and conflicting sessions refuse safely.
- Release path is still **Issue → worker → CI → independently reviewed landing → main**; the poller only observes it.
- Run `npm test` and `npm run build`; run the packaged smoke check before authorizing the service.

### Rollback

Stop/disable the **timer**, or set `enabled: false` in the private policy. This stops future ingestion without rewriting historical append-only evidence. The existing Source Engine read tools continue to work. Do not silently delete or overwrite previous audit events.

## Limitations

Only same-repo bot/owner-authored PRs backed by exact Coordinator remote checkpoints can be discovered. A legitimate branch advanced beyond a checkpoint intentionally waits for a fresh checkpoint; a PR created outside Memo Bridge is intentionally not enrolled. It is safe to skip and report rather than guess. No automatic code edits, CI repairs, mergers, releases or deployments are performed by the poller.
