# STAR — project catalog foundation (2026-10-13)

**Situation** — Memo Labs has ten or more concurrent AI clients and many Git repositories. The source of truth for canonical project registration is `~/projects/PROJECTS.md`. Memo Bridge is currently a read-only local stdio MVP; two other worktrees are already developing hub authentication.

**Task** — Add a safe, provider-neutral, read-only project catalogue and gap detection without touching production, the main branch, or other worktrees.

**Action** — Create isolated `feat/project-catalog` worktree. Add `projects_list`, `project_info`, `project_git_status` and `projects_audit` as MCP tools. Restrict project names, validate paths against the canonical projects root and reject symlink escapes. Use only fixed Git arguments, no shell. Compare the registry to the existing inventory and navigational aliases without automatically authorizing unregistered projects.

**Result** — PASSED on the Mac: 7/7 unit tests, npm build, MCP smoke (7 tools). Found 59 accessible registered projects and 19 unregistered candidates (including emargo, medsharing and problem-intelligence-engine). No services, VPS files, GitHub runners or Vault content changed.

**Next independent task** — Reconcile the canonical PROJECTS.md register with human-reviewed real projects, then implement a durable private task coordinator (claims, leases, job records) with transactional persistence and conflict tests. Integrate with the independently developed hub-auth / oidc-resource branches only after review and their own passing tests.

**Limits** — No shared task state, no VPS worker, no public HTTP MCP, and no auth in this branch. Do not connect to ChatGPT remotely using this stdio package as though it were a secure hosted MCP.
