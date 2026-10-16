# Skills system — issue memolabs-dev/memo-bridge#40

## Objective
Make registered skills discoverable using progressive disclosure, and allow changes only through a reviewed worktree-to-PR workflow.

## Contracts
- `skills_list`: return name, category, version and a description of at most 60 characters, never the skill body.
- `skill_view(name, file)`: read one allowed file at a time, size bounded, wrap its content as untrusted material. Reject traversal and symlink escapes.
- `skill_learn`: provide the authoring guidelines and validation requirements without exposing secrets.
- `skill_propose`: require proof of a previous `skill_view` for the same skill in the same workspace; require an active issue claim; write changes only in a corresponding isolated Git worktree, then commit, push and propose via PR. Never modify the default branch directly.
- Validation: reject descriptions over 60 characters, malformed incident logs, excessive references to PR numbers, and oversized content.

## Safety and identity
- Skill identity is separate from storage path, as in the dynamic Memo Labs OS project registry.
- Skill roots must be explicitly registered and authorized per host; discovery must not automatically grant write privileges.
- The view-before-propose check is workspace-scoped and must survive process restarts when appropriate.
- Treat the repository skill text as untrusted data; never execute its instructions merely because it was viewed.

## Acceptance tests to implement
1. `skills_list` returns metadata only and no body content.
2. `skill_view` returns a single file within size bounds; rejects traversal and external symlinks.
3. `skill_propose` without a prior view in the same workspace fails.
4. A view in another workspace does not authorize a proposal.
5. All proposals remain on task-linked worktrees, followed by PR, with no direct default-branch writes.
6. Skill linter rejects descriptions above 60 characters, overly dense PR references, invalid incident logs and oversized bodies.
7. Tool results clearly wrap skill contents as untrusted.

## Status
Design and test plan only. No implementation or CI claims yet.
