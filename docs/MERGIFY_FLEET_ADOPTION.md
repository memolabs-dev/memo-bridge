# Mergify across the fleet: one template, one canary pair per repository

Autoloop T-M3 (`.agent/project/autoloop/spec.md`, REQ-M01, M06, M07, M08), Issue #149.
memo-bridge adopted the policy first (#154, canaries #155 and #156). This page is how every
other repository adopts it, and the state of each one.

## The policy

A pull request lands without a human when, on its exact head: it targets the default branch, is
not a draft, does not come from a fork, its author is `memo-labs-automation[bot]` or
`guillaume-flambard`, it carries neither `hold-merge` nor `needs-human-review`, it touches no
sensitive path, and every required CI check of the repository is green. Squash, one at a time.

Sensitive paths (REQ-M04): `.github/`, `.mergify.yml`, `CODEOWNERS`, the root `AGENTS.md`,
`deploy/`, `ansible/`, `infra/`, `stacks/`, any `migrations/` directory, root `.env*`, plus a
per-repository list. A sensitive PR stays open with green CI. Mergify posts no comment on it:
the reason is in the "Mergify Merge Queue" check of the PR, which lists the unmet `-files`
condition. Labelling and commenting such PRs is T-M2b.

## The template

Copy it as `.mergify.yml`. Only two things change per repository: the `check-success` lines
(one per required check, named as GitHub shows them) and, when needed, extra paths appended to
the `-files` pattern. Keep `merge_method: squash` unless the repository only allows another one.

```yaml
# Memo Labs autoloop merge policy: memolabs-dev/memo-bridge docs/MERGIFY_FLEET_ADOPTION.md.
# A green PR from a trusted author lands without a human. Sensitive paths wait for the owner;
# the "Mergify Merge Queue" check on the PR names the condition that blocks it.
shared:
  land_conditions: &land_conditions
    - base = main
    - -draft
    - -from-fork
    - or:
        - author = memo-labs-automation[bot]
        - author = guillaume-flambard
    - label != hold-merge
    - label != needs-human-review
    - "-files ~= ^(\\.github/|\\.mergify\\.yml$|CODEOWNERS$|AGENTS\\.md$|deploy/|ansible/|infra/|stacks/|\\.env)|(^|/)migrations/"
    - "check-success = @github-actions/<required check>"

merge_queue:
  max_parallel_checks: 1

merge_protections_settings:
  auto_merge_conditions: *land_conditions

queue_rules:
  - name: memo-labs-autoloop
    batch_size: 1
    merge_method: squash
    queue_conditions: *land_conditions
    merge_conditions: *land_conditions
```

## Adopting a repository

1. Read the repository's `AGENTS.md` and `CONTRIBUTING.md`. If they say a human merges, the
   adoption PR changes that sentence too, or the repository is not adopted.
2. List its merge engines: `gh api repos/<r>/actions/workflows`, the `merge_queue` rule in
   `gh api repos/<r>/rules/branches/main`, and any bot that runs `gh pr merge`. Write down the
   required checks from the same rules call or from `branches/main/protection`.
3. Open one PR that adds `.mergify.yml` and removes the legacy engine in the same change
   (workflow file deleted, so both switch at the merge commit). When the legacy engine is a
   `pull_request_target` auto-merge workflow, open the PR as a draft, add `hold-merge`, then mark
   it ready: the base branch's copy of the workflow would otherwise arm auto-merge on the
   adoption PR itself. The PR touches `.mergify.yml`, so the owner merges it.
4. A ruleset `merge_queue` rule blocks every Mergify merge. It is removed, or Mergify is added as
   an `exempt` bypass actor on that ruleset, before adoption. Both are owner settings.
   Source: https://docs.mergify.com/merge-queue/github-rulesets.md
5. Positive canary: a small real code change, no sensitive path. Pass when
   `gh pr view <n> --json mergedBy` says `mergify`.
6. Negative canary: a small real change under a sensitive path. Pass when CI is green and the PR
   is still open with the `-files` condition unmet in the Mergify Merge Queue check. The owner
   then merges or closes it.
7. Set `delete_branch_on_merge` on the repository (T-C3, owner setting) and record the result in
   the table below.

## Rollback (REQ-M08)

Remove `.mergify.yml` (or add `hold-merge` to the open PRs while it is being removed) and only
then restore the legacy engine. Never two engines on the same repository at once.

## State of the fleet

Checked on 2026-10-17 with the calls of step 2.

| Repository | Visibility | Required checks | Legacy engine | Status |
|---|---|---|---|---|
| memolabs-dev/memo-bridge | public | `test (22)`, `test (24)` | `Land` workflow, disabled | ADOPTED: #154, canaries #155 (merged by Mergify) and #156 (held) |
| memolabs-dev/cuesheet | public | `Core and integration tests` | `auto-merge.yml`, disabled | pilot rules (bot only, size caps, code excluded); adoption PR replaces them |
| memolabs-dev/problem-intelligence-engine | public | `test (22)`, `test (24)` | none, the owner merges | adoption PR adds the template; AGENTS.md says the bot may arm GitHub auto-merge |
| memolabs-dev/uni-protocol | public | `UNI required checks` | `auto-merge.yml` (native auto-merge, no sensitive-path rule), active | adoption PR adds the template and deletes the workflow |
| memolabs-dev/drop | public | `test`, `test-windows`, `test-macos` | ruleset `merge_queue` rule, merge commits only | NOT ADOPTED: needs the owner to drop the `merge_queue` rule or exempt Mergify, and to change CONTRIBUTING ("The maintainer reviews and merges", security review on protocol, relay, node, runner, capabilities, requester-mcp). Extra sensitive paths then: `apps/desktop/src-tauri/tauri.conf.json`, `*.entitlements`, `apps/desktop/updater.pub`; `merge_method: merge` |
| memolabs-dev/lab-hub | public | `build` | none | NOTHING TO ADOPT: publish target of the private site, one commit, no pull request ever |
| private memolabs-dev repos | private | - | emargo `auto-merge.yml` | BLOCKED on U-02 (Mergify Free on private repos, emargo canary) |
| guillaume-flambard/* | mostly private | - | lab-infra `private-green-merge` | BLOCKED on U-01 (Mergify not installed on the personal account) |
