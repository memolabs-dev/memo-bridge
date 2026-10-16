# Landing workflow proposal — issue #88

This file is a **proposal, not an installed workflow**. Memo Bridge correctly blocks
writing to `.github/workflows` (`path_protected`). A trusted maintainer must
review and install it using a workflow-authorized route.

## Requirements before enablement

- Repository Settings > General > Pull Requests > **Allow auto-merge** must actually
  be enabled (GitHub connector currently reports disabled).
- Required branch-protection check names must be configured for Node 22 and Node 24.
  Merely having green optional checks does not protect a merge.
- `landing:approved` is a privileged acceptance signal, granted only after review
  against the original Issue; disallow untrusted actors from setting it.
- Workflows that modify auth, CI, permissions or this workflow must require
  independent review. Never grant a model GitHub Admin or unrestricted Workflows.
- Only in-repository PRs by allowlisted authors, no draft, no `hold-merge` label.
- Do not use `pull_request_target` to check out or run the PR code.
- Require a canary PR: successful CI and positive manual acceptance => auto-merge.
  Negative canaries (draft, hold, unauthorized, failing CI) must not merge.
- No automatic deployment as a side effect of landing.

## Proposed `.github/workflows/auto-merge.yml`

```yaml
name: Enable approved auto-merge
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize, labeled, unlabeled, converted_to_draft]
permissions:
  contents: write
  pull-requests: write
jobs:
  arm:
    if: >-
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      (github.event.pull_request.user.login == 'guillaume-flambard' ||
       github.event.pull_request.user.login == 'memo-labs-automation[bot]') &&
      contains(github.event.pull_request.labels.*.name, 'landing:approved') &&
      !contains(github.event.pull_request.labels.*.name, 'hold-merge')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Arm native auto-merge
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          EXPECTED_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          current="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid --jq '.headRefOid')"
          if [ "$current" != "$EXPECTED_SHA" ]; then
            echo 'Stale head SHA'
            exit 1
          fi
          gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --squash
  disarm:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      (github.event.pull_request.draft ||
       !contains(github.event.pull_request.labels.*.name, 'landing:approved') ||
       contains(github.event.pull_request.labels.*.name, 'hold-merge'))
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Revoke armed auto-merge
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          armed="$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json autoMergeRequest --jq '.autoMergeRequest != null')"
          if [ "$armed" = true ]; then
            gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --disable-auto
          fi
```

## Status

- Decision logic and negative tests: `bridge/landing-policy.mjs`,
  `tests/landing-policy.test.mjs`.
- Repository-owned privileged landing workflow: **not installed**.
- Native GitHub auto-merge availability: **not verified enabled**.
- PR #66 (skills), #71 (diagnose), #57 (Cuesheet smoke): do not
  automatically promote drafts. Acceptance must be explicit first.
