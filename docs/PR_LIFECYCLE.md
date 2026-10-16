# Memo Bridge — PR lifecycle and Issue closure

## Incident: parent Issue closed by a partial PR

On 2026-10-16, merging [PR #115](https://github.com/memolabs-dev/memo-bridge/pull/115) closed [Issue #86](https://github.com/memolabs-dev/memo-bridge/issues/86) even though [PR #106](https://github.com/memolabs-dev/memo-bridge/pull/106) remained a draft prerequisite. The GitHub Actions comment on #86 says it was closed by #115. The `github_create_pr` tool automatically appended `Closes #86` to the PR body, despite the human body explaining that #115 was only a prerequisite.

## Contract

`github_create_pr` adds one optional `close_issue` argument:

- **Omitted or `true` (default):** preserve the existing single-task flow. A PR in the same repository includes `Closes #<Issue>` (unless already present); GitHub closes the Issue when the PR merges.
- **`false`:** this PR is only one slice of a broader Issue. It does not append an auto-closing keyword, and rejects an explicit GitHub `Closes` / `Fixes` / `Resolves` keyword, including cross-repo references, in the submitted body. The Issue remains open after this PR lands.
- Existing pull requests remain unchanged; the tool returns them without rewriting their bodies. This option applies when **creating** a PR and cannot retroactively undo a closing reference.

An agent should use `close_issue: false` whenever acceptance criteria are incomplete, prerequisite PRs remain unmerged, more than one PR is expected, or the PR is a preparatory spike. The final, accepted PR may use the default and close the Issue **after** every acceptance condition has been verified. A PR's CI passing alone does not mean the Issue is finished.

## Safety and limits

- GitHub still enforces branch protections, reviews and CI through the separate landing contract.
- `close_issue: false` only prevents auto-closing from the submitted PR body. It does **not** disable GitHub automation that explicitly closes an Issue independently, and it does not alter permissions.
- A body containing another closing keyword is rejected in partial mode, rather than silently allowing the other Issue to close.
- The caller must pass a boolean, not the string `"false"`. The default is backward compatible.
- For multi-PR workflows, link the parent Issue with `Refs #86` or `Part of #86`, not `Closes #86`, until the final accepted change.

## Regression tests

`tests/github.test.mjs` covers the default terminal behavior, partial PR body without closure, an explicit terminal PR, rejection of hidden close keywords, invalid input, and two successive PR slices tied to one Issue.

The original Issue #86 has already been closed. This change does **not** reopen it automatically or change PR #115/#106 retroactively; any backlog correction should be performed separately with an explicit audit trail.
