# Contributor policy

## GitHub repository identity (mandatory before project creation)

- Read the [Memo Labs canonical repository ownership policy](https://github.com/memolabs-dev/.github/blob/main/docs/repository-ownership-policy.md) and `~/memolabs/PROJECTS.md` before using this template or `project_create`.
- Check **both** `memolabs-dev` and `guillaume-flambard` by name, aliases, description and stable GitHub ID, as well as existing local remotes and deployed services. **Reuse the existing canonical repository** instead of creating a second source for the same product.
- The personal account is normally for individual work and upstream OSS forks; the organization is for maintained Memo Labs products and shared tooling. Do not migrate or mirror purely for portfolio credit: the portfolio reads both owners and upstream PRs.
- Never change a private repository to public, archive, transfer or delete an existing repository without an explicit decision and recorded check of unique commits, PRs, production/CI integrations and secrets.
- After confirmation, record canonical `owner/name` and GitHub repository ID in project documentation, then work via branch, PR and checks. If ambiguous, stop automatic creation and escalate.

Follow ~/memolabs/AGENTS.md and ~/memolabs/PROJECTS.md. Work from a GitHub Issue, in your own
worktree, and open a pull request; never push to `main`. Mergify merges a pull request whose CI
check `check` is green and which touches no gate path (`.github/`, `.mergify.yml`, `CODEOWNERS`,
this file, `.env*`); a gate change waits for the owner. Keep `npm test` passing.
