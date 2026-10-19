# The delivery gate: the `uni` and `uni-ratchet` checks

A memo-bridge pull request lands only when two checks are green on its exact head commit, on top
of `test (22)` and `test (24)`:

| Check | Workflow | What it proves |
|---|---|---|
| `uni` | job `uni` of `.github/workflows/ci.yml` | uni accepts `uni/intents/delivery.uni` on the head commit, at assurance A3 |
| `uni-ratchet` | `.github/workflows/uni-ratchet.yml` | the pull request leaves the judge of pull requests at least as strong as `main` |

Mergify requires both (`.mergify.yml`, `land_conditions`), so a PR that changes `.github/`,
`.mergify.yml`, `AGENTS.md` or the judge itself lands on its own when both are green. Only root
`.env` files stay out of reach of automatic landing. Design and decisions: the spec
`1-Projects/home-assurance/2026-10-19-livraison-design.md` in the Vault, sections "Check 1",
"Check 2" and "Mergify".

## How `uni` decides

1. It checks out `pull_request.head.sha` (on a push to `main`, `github.sha`), never the synthetic
   merge commit, fresh on every run. Nothing under `.uni/` is cached or restored.
2. It installs uni v0.9.4 from the release asset, checked against the sha256 written in the
   workflow. A wrong checksum or a failed download fails the job.
3. It refuses a tree that is not that commit, is not clean, or carries committed uni state
   (`.uni/evidence/`, `.uni/decisions/`, a registry snapshot).
4. It asks GitHub for an OIDC token with audience `uni-cli`, in a step of its own, and masks it.
5. It runs `uni verify --json uni/intents/delivery.uni` with the token in `UNI_IDENTITY_TOKEN`
   and without the variables that could mint another one (`ACTIONS_ID_TOKEN_REQUEST_URL`,
   `ACTIONS_ID_TOKEN_REQUEST_TOKEN`).
6. It accepts only when all of these hold, read from that run's stdout:
   - uni exited 0 and `decision` is `Accepted`, `trust_boundary_changed` is `false`;
   - every claim is `Valid` and has its proof in `evidence`;
   - every proof has `commit_sha` equal to the head commit and `workspace_dirty` false;
   - every proof was made by an actor with `assurance` `verified`, `source` `oidc`, an id from
     `https://token.actions.githubusercontent.com`, distinct from the executor (this is how uni
     itself derives A3 and an independent actor; `uni verify --json` in 0.9.4 does not print
     `assurance` or `commit` at the top level);
   - after the run, `HEAD` is still the head commit and `git status --porcelain` is empty;
   - `uni report --json` agrees: `Accepted`, `A3`, `independent_actor` true, identity
     `VERIFIED`.

Any other outcome fails the job. No step is `continue-on-error`.

## Reading a `uni` refusal

Open the failed `uni` job. The verify step ends with one `::error::uni: ...` line, then the
output of `uni explain --annotations` (inline annotations on the files that moved) and of
`uni explain` (one block per claim: status, command, watched files, why, next command).

| Error line | Meaning | What to do |
|---|---|---|
| `uni verify exited 1` | a claim failed or lacks a proof (`UNI REJECTED` or `UNI EVIDENCE_REQUIRED` above it), or the token was refused | read the claim marked FAIL in `uni explain`; fix the code, not the test |
| `not Accepted at A3 with an independent actor on <sha>` | uni accepted, but a proof is not A3, not on this commit, or a claim is not `Valid` | read the step log; a proof on another commit means the tree was not the head commit |
| `uni report disagrees: not Accepted at A3` | uni's own summary does not match its stdout | rerun once; if it repeats, report it, the job never passes on a disagreement |
| `the proof changed the tree` | a verifier wrote a tracked or unignored file | make the test write under a temporary directory |
| `HEAD moved during the proof` | something checked out another commit | the same: tests never touch the repository's git state |
| `uni runtime state is committed` (earlier step) | the PR adds files under `.uni/evidence/`, `.uni/decisions/`... | remove them from the PR; they are git-ignored on purpose |
| `no OIDC token request for this run` / `GitHub returned no OIDC token` | the job has no `id-token: write`, or the PR comes from a fork | forks never land; otherwise GitHub had an incident, rerun |

To reproduce locally: `uni verify uni/intents/delivery.uni`, then `uni explain`. A local run has no
GitHub token, so it reaches A2, never A3: it tells you whether the claims hold, not whether the
check passes. It takes about five minutes.

## Reading a `uni-ratchet` refusal

The ratchet writes one comment on the PR, starting with `<!-- memo-labs:uni-ratchet -->`, updated
in place on each run, and fails. Each line is a rule and a path:

| Rule | What the PR did |
|---|---|
| `contract_weakened` | removed a claim or invariant, dropped `REQUIRED` or `CRITICAL`, changed a verifier or the `ACCEPT` rule, or broke `uni compile` |
| `registry_weakened` | removed or changed a `[verifiers]` entry of `.uni/config.toml` (a new entry is fine) |
| `identity_changed` | touched `[identities]` or `.uni/identity/` |
| `policy_changed`, `judge_changed` | touched `.uni/policies/`, the mutation harness, the `uni` job, `uni-ratchet.yml`, `scripts/uni-ratchet.mjs`, the `test` / install scripts of `package.json`, the pnpm configuration, a permissions block of a workflow, or named a job like a required check |
| `invariant_test_changed` | modified or deleted an existing file of `tests/invariants/` |
| `invariant_without_mutant` | added an invariant test with no `tests/mutations/<name>-<suffix>.patch` |
| `mutants_decreased`, `mutant_changed` | removed a mutant, or changed the `-`/`+` lines of an existing one |
| `mergify_weakened` | removed, changed or moved a line of `.mergify.yml` (a new plain condition is fine) |
| `runtime_path` | committed uni runtime state |
| `secret_path` | touched a `.env` file |
| `hold_removed` | someone other than the owner lifted a `hold-merge` the owner set |
| `ratchet_error` | the ratchet could not read everything (API error, truncated tree, the PR moved): it refuses on doubt; the next push or label event judges again |

An agent cannot make the ratchet pass by loosening a rule. The task ends `blocked`, with the
comment as its reason. Only the owner loosens a rule: he changes it in a PR of his own and merges
it himself, since Mergify will not.

The ratchet runs from `main` (`pull_request_target`): it never checks out or runs the PR's code,
it reads both trees through the API and the contracts through `uni compile`. A change to the
ratchet therefore applies only once it is on `main`.

## When GitHub rotates its OIDC keys

Symptom: `uni` fails on every PR at the verify step, uni refusing the token (unknown `kid` or a
bad signature). This is by design: uni never falls back to a self-declared identity.

The keys are pinned in `.uni/identity/github.jwks.json`, never fetched during verification.
Refresh them on a branch of your own:

```sh
curl -fsSL https://token.actions.githubusercontent.com/.well-known/jwks | jq -cj . > .uni/identity/github.jwks.json
jq -r '.keys[].kid' .uni/identity/github.jwks.json   # compare with the kids in git diff
git diff --stat .uni/identity/github.jwks.json
```

`jq -cj .` keeps the file's format (one line, no trailing newline), so the diff shows only the
keys that changed. The `uni` check of that PR passes, since its head carries the new keys.

Why this is the owner's own act: changing `.uni/identity/` is an `identity_changed` violation, so
`uni-ratchet` fails and Mergify never lands the PR. That is deliberate. Whoever controls the
pinned keys decides whose token proves A3; no agent may change that on its own. The owner checks
that the file came from the URL above, then merges the PR himself. uni's weekly `identity-live`
workflow (in uni-protocol) gives an early signal of a rotation.

## What `task_complete` will require

Not implemented yet (spec section "`task_complete`, la porte de fait"). `task_complete` will take
a mandatory `pr` and finish the task only when, read from GitHub:

1. the PR belongs to the claim: its branch is the claim's worktree branch and its `head.sha` is the
   last commit checkpointed by this claim and workspace;
2. it is merged, `merged_by` being `mergify[bot]` or `guillaume-flambard`;
3. `uni` and `uni-ratchet` are `success` on `head.sha`, published by the `github-actions` app,
   read exhaustively (absent, pending, ambiguous duplicate or another app: refused);
4. the tree of the squashed commit on `main` equals the tree of `head.sha`.

Refusals: `pr_not_merged` (retry later), `pr_not_ours`, `proof_missing`, `proof_failed`,
`tree_mismatch`, `merged_by_untrusted`, `github_unreadable`. Only `task_complete` will write
`completed`; `task_release` keeps `blocked`, `failed` and `cancelled`.

## Bootstrap

The PR that adds these checks touches `.github/` and `.mergify.yml`, which the rules in force
before it exclude from automatic landing, so the owner merges it by hand, once. `uni-ratchet`
does not run on that PR: `pull_request_target` takes the workflow from `main`, where it does not
exist yet. From the next PR on, both checks run and Mergify requires them.
