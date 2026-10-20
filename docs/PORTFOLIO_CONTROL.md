# Global Memo Labs portfolio — delivery lifecycle

Incremental implementation: the collector is not yet wired to a live MCP endpoint, and no continuous agent has been deployed.

## Sources and authority
- Registered projects: Memo Bridge PROJECTS.md; metadata-only rows remain unverified.
- GitHub Issues and PRs: paged reads, excluding PRs from the Issues endpoint.
- Existing tasks_list, task_next and live leases: authoritative for assignments, not cached queue.
- Source Engine, GitHub and Mergify: evidence of PR/CI/merge, NOT production deployment.
- The target application's release receipt and environment checks: deployment evidence.

## Stages
triage -> ready -> claimed -> PR open -> merged -> deployed verified -> done.

Never equate task_complete, push, passing CI or merge with deployment. For repositories with no deployment concept, allow completion after merge and acceptance only if the repo policy explicitly says so. Never close an issue for partial scope, including close_issue=false. Otherwise wait for deployment receipt and acceptance checks. Preserve human review for irreversible actions.

## Queue behavior
server/portfolio.mjs is a pure read-only collector and ranker. Paginated inputs are injected; permission failures produce an explicit incomplete snapshot. Priorities are p0, p1, p2, then needs-triage. Blocked, already claimed, unprioritized, or PR-in-progress work is never chosen as next actionable work. Its next field is a recommendation; task_next must still revalidate the lease.

## Pending integration
- Wire the collection to the existing GitHub App backend, expose an MCP portfolio_overview without a new auth client, add rate caps.
- Link issues via verified GitHub closing references and Source Engine receipts; PR title heuristics alone cannot conclusively link changes.
- Add idempotent reconciliation for observed merge, verified deployment, issue state and labels (#237).
- Use existing task_next, scheduling and lease mechanisms for continuously refreshed suggestions (#238); no second job runner.
- Add a dashboard or CLI once live source and provenance are validated.

Tracked: #236 (portfolio), #237 (lifecycle), #238 (agent planning).
