# GitHub identity audit (owner-private, read-only)

**Scope:** a stable GitHub repository ID, not a name or a local folder, identifies a repository. A renamed/transferred repository retains its numeric ID. A fork and a copy have different IDs even when their code and README are identical.

The private inventory is a non-authoritative observation made from the Mac project's registered checkout remotes and GitHub metadata. It **does not** grant access, modify GitHub remotes, expand Memo Bridge's runtime allowlists or write to PROJECTS.md.

## Existing verified example (26 October 2026)

- Local project `uni` still has the origin `guillaume-flambard/uni-protocol`.
- Authenticated GitHub GET of that old owner/name resolves to `memolabs-dev/uni-protocol` with repository ID `1370011909`.
- The *different* archived `guillaume-flambard/uni` has ID `1171706619`. They must never be combined.
- A personal Data for Good fork of Mediterranean Rescue and the Memo Labs-maintained repository have **different** IDs; they are not an owner transfer.

## Owner Mac workflow

1. Use the local private, mode 0600 snapshot under `~/memolabs/workspace/data/github-ownership/`. Refresh using authenticated GitHub reads, recording timestamp, requested remote, resolved canonical full name and numeric repository ID; never publish personal/organization private metadata in a public repository.
2. Run `node scripts/check-registered-identities.mjs "$HOME/memolabs/workspace/data/github-ownership/registered-project-identities-2026-10-26.json"`. The command reads data but outputs **only aggregate counts and short error codes**.
3. Any unresolved identity, stale snapshot, repeated project mapping, changed ID, or mismatch between historical alias and current live GitHub ID must be investigated, not silently merged. A repeated ID produces a review-needed outcome; it does not delete/merge projects.
4. Before changing an origin or assigning an alias, obtain a **new** authenticated GET to the old URL, verify the canonical `full_name`, `owner.login` and unchanged numeric ID, and review active PRs, production consumers and permissions.
5. Project identity must never authorize `task_claim`, `workspace_open`, runners, GitHub App permissions or visibility changes. Those remain bound to their **existing verified allowlists**. Extending them is separate, reviewed security work.

Tests: `node --test tests/github-identity-audit.test.mjs`. The fixture exercises rename, folder moves, transfers, forks, duplicate IDs, stale aliases, tampering and unknown/private origins without accessing GitHub.

**Follow-up:** integrate the validated identity map into a *read-only* owner registry lookup, add a transaction-safe versioned alias store, then separately review any permission-bound resolution as required by issue #80. Do not claim #80 complete from this audit-only first step.
