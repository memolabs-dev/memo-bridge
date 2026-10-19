# Contributor policy

Follow ~/memolabs/AGENTS.md and ~/memolabs/PROJECTS.md. Work from a GitHub Issue, in your own
worktree, and open a pull request; never push to `main`. Mergify merges a pull request whose CI
check `check` is green and which touches no gate path (`.github/`, `.mergify.yml`, `CODEOWNERS`,
this file, `.env*`); a gate change waits for the owner. Keep `npm test` passing.
