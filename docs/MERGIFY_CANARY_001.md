# Memo Labs Mergify canary 001

This documentation-only change verifies that the Mergify GitHub App and Memo Labs'
existing GitHub Actions checks can observe a harmless pull request.

The pull request is intentionally created in **draft** mode. Draft PRs must never
be queued or merged automatically by the Mergify pilot policy.

## Canary checkpoints

- `test (22)` and `test (24)` succeed for this PR.
- The `Mergify Merge Queue` check does not grant a merge while the PR is draft.
- No `landing:approved` label is set during this first, read-only phase.
- The existing Memo Labs landing automation must be isolated for this PR before
  it is marked ready for review, so that Mergify is the only merging controller.
- Independent acceptance must precede the later, optional positive merge canary.

The file contains no credentials, application logic, build configuration, or
production deployment changes.
