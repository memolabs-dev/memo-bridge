# Project context discovery — Issue #107

## Purpose
Before creating a task, designing architecture, or dispatching an agent, query the existing Memo Labs project registry, Source Engine, and Coordinator. This prevents duplicate projects and invalid design proposals.

## Reuse, not replacement
- Canonical project identity: PROJECTS.md + existing catalog and verified Git origin.
- Source Engine: append-only change registry and queries (do not assume that a pending PR has been deployed).
- Coordinator: active sessions, leases, checkpoints and registered tasks.
- Git integration: existing repository adapter, not a new provider implementation.

## Contract
`project_context({project, goal?})` is an owner-scoped read-only capability, returning:
- canonical identity, verified origin, observed timestamps and source references;
- known components/capabilities with explicit state: `deployed`, `on_main`, `in_open_pr`, `planned`, `unknown`;
- related Issues, PRs, check conclusions and dependencies; never infer check success from an empty list;
- active workspaces, task leases and potential overlap;
- reusable existing components and proposed next steps with provenance;
- `stale` / `unavailable` markers for each upstream source.

All external observations are advisory; no permission to write, approve, bypass policy or merge follows from them.

## Safety
- Enforce existing owner, registered-project and remote-allowlist authorization before any query.
- Do not accept arbitrary filesystem paths or unverified repository origins.
- Limit external request count, results and output size; paginate history.
- Never expose credentials, env values, workspace paths disallowed by policy, or unrelated project data.
- On failed lookup, fail closed for authorization and degrade visibly for availability.

## Acceptance tests
1. Memo Bridge discovers existing Source Engine, Coordinator and #86/#88/#94/#103, rather than offering to recreate them.
2. Drop resolves independently and only when it is an explicitly authorized project.
3. Unknown, forbidden or cross-project identifiers fail closed.
4. A capability present only in a PR is never labelled deployed.
5. Offline, stale, duplicate and inconsistent upstream records are marked, not silently trusted.
6. Active foreign workspace/lease is visible as conflict risk but cannot be overridden.
7. Read-only tool is registered consistently across stdio, remote policy and smoke inventory.
8. All tests pass before PR is considered for landing.

## Integration sequence
1. Establish catalog + runtime authorization query.
2. Add bounded aggregation from existing Coordinator and Source Engine.
3. Reconcile GitHub PR/CI via #108, separating observed state from merge authorization.
4. Expose MCP tool and integration tests.
5. Demonstrate one normal project and one denied project.
6. Integrate with the landing workflow from #88 and queue #86, without editing their worktrees.

## Non-goals
No independent project database, no new orchestrator, no blanket auto-merge and no Forgejo migration in this issue.
