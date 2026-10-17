# Autoloop: from Issue to deployed, without a human

Issue: memolabs-dev/memo-bridge#149. Written 2026-10-17 from a read-only audit of memo-bridge
(origin/main 328c474), memolabs-dev/.github, lab-infra (origin/main) and the live GitHub API.

## 00. Intent

### Goal
An agent task that starts as a GitHub Issue ends deployed on its target (VPS or Mac) with a
receipt on its pull request, and nothing is left behind (worktree, local branch, remote branch).
The owner does not merge, deploy or clean up by hand for the normal case.

### Owner decision (2026-10-17, in conversation)
"Elle doit fusionner sans moi, et memo bridge doit gérer de A à Z de la création au merge de PR
et déploiement que ce soit sur VPS ou Mac." A green code PR from a trusted author lands without
a human. Only the sensitive paths listed in REQ-M04 still need the owner.

### Non-goals
- Migrating off GitHub (considered and rejected on 2026-10-17: the gaps are ours, not the host's).
- Agents merging with their own token. The merge executor stays an external engine (Mergify).
- Store distribution (App Store, notarized public releases) beyond what drop's release.yml does.
- Rewriting the VPS autodeploy. It works; the loop observes and completes it.

### User-visible outcome
1. The owner files or approves an Issue. An agent claims it, codes in a worktree, opens a PR.
2. CI goes green. Mergify merges it within minutes. The remote branch is deleted.
3. The change is deployed by the deployer that owns that target. A commit status
   `memo/deploy` and a PR comment say where and when, or why not.
4. Within an hour the local worktree and branch are gone, any local leftovers archived.
5. Once a day LIVE-STATE lists PRs that are green but stuck, and why, and orphan worktrees.

### Constraints
- memolabs-dev is on GitHub Free: no branch protection or rulesets on its 8 private repos.
  Mergify (installed org-wide, `repository_selection: all`) merges with its own App identity,
  so it does not need branch protection. Private-repo support on Mergify Free is not documented:
  it must be proven by a canary per private repo (risk R-03).
- Personal-account repos (guillaume-flambard/*: lab-infra, kollio-mac, world-kernel, memo-cc,
  stasis, intentlane) have no Mergify installation that we could verify (BLOCKING_UNKNOWN U-01).
- One merge engine per repo (docs/MERGIFY_PILOT.md). Legacy engines are disabled before Mergify.
- memo-bridge AGENTS.md: no deployment without TLS, authentication, host authorization and a
  tested rollback. The loop therefore reuses deployers that already have rollback
  (VPS autodeploy) and adds new deploy paths only with a rollback test.
- Up to six agent sessions run in parallel. Nothing may remove a worktree another session uses.

### Completion sentence
This project is complete when a canary Issue in a Mergify-enabled repo goes from `agent:ready`
to merged, deployed (with a `memo/deploy` status on the merged SHA) and cleaned up (no worktree,
no local or remote branch) without any owner action, and every adopted repo has passed its
canary.

## 01. System map (what exists, from the audit)

```
Issue (agent:ready) -> batch_create / task_next -> task_claim (lease ledger, memolabs-dev/.github)
 -> worktree_create ($MEMOLABS_ROOT/workspace/worktrees/<project>/<branch>)
 -> worktree_write_file / jobs_submit test (sandboxed) -> worktree_commit -> worktree_push
 -> github_create_pr (Closes #n unless close_issue:false)          [all on main]
 -> CI (GitHub Actions)
 -> MERGE: Mergify on memo-bridge and cuesheet only, narrow rules  [GAP: rest of fleet]
 -> DEPLOY: VPS autodeploy polls registries every 2 min, rollback + hold  [image apps only]
            lab-infra stacks, memo-bridge pin, Mac apps: manual           [GAP]
 -> CLEANUP: none. worktree_remove is manual; delete_branch_on_merge off on most repos [GAP]
 -> REPORT: none. autodeploy status lives in /var/lib/autodeploy/*.status   [GAP]
```

Merge engines today: Mergify (memo-bridge, cuesheet), uni-protocol auto-merge.yml, emargo
auto-merge.yml (trusts the retired drop-agent-bot, not the App), lab-infra private-green-merge
(needs a manual label), drop native merge queue that nothing enqueues, and none elsewhere.

Deployers today: VPS autodeploy (ghcr.io/guillaume-flambard, ghcr.io/memolabs-dev,
127.0.0.1:5000 images; CI check; health probe; automatic rollback; hold file; flock), local
builders usine/veilleur/factura (2 min timers, green CI on exact SHA), drop release.yml (draft
release on tag), lab-infra `make deploy-stack` from the Mac (manual), memo-bridge VPS role with a
pinned SHA (manual bump), memo-bridge Mac runtime install-local (manual).

## 02. Requirements

### Epic C: cleanup (reaper)
- REQ-C01: A worktree whose branch has a MERGED PR and whose HEAD equals that PR's head SHA is
  removed automatically, including worktrees created outside Memo Bridge.
- REQ-C02: Local edits in such a worktree (tracked diff, untracked files, status) are archived
  before removal; if archiving fails the worktree is kept.
- REQ-C03: The reaper never removes a worktree that is locked, has a process with its cwd inside,
  has an active Memo Bridge job or live claim, was modified within the grace window (default 6 h),
  has a detached HEAD, has an open or no PR, or whose HEAD differs from the merged head.
- REQ-C04: Dry-run is the default; `--apply` acts. Output is a JSON report, one line per decision
  with the reason.
- REQ-C05: After removal the reaper prunes stale worktree entries, marks the Memo Bridge worktree
  row `removed`, and deletes the local branch only if it is fully contained in the merged PR head.
- REQ-C06: It runs on a timer (launchd on the Mac, systemd on the VPS), at most hourly, under one
  lock so two runs never overlap. Install and uninstall are documented; disabled by default.
- REQ-C07: `delete_branch_on_merge=true` on every adopted repo, so the remote branch goes too.

### Epic M: one merge engine, no human for green PRs
- REQ-M01: Every adopted repo has exactly one merge engine: Mergify. Legacy engines in that repo
  are disabled first.
- REQ-M02: A PR lands when: base is the default branch, not draft, not from a fork, author in
  {memo-labs-automation[bot], guillaume-flambard}, no `hold-merge` label, and every required CI
  check of the repo is successful on the head SHA. No created-at cutoff, no size cap.
- REQ-M03: Dependabot PRs that only bump pinned GitHub Actions or lockfiles land on green CI
  (they touch .github/ so REQ-M04 applies unless explicitly allowed per repo).
- REQ-M04: A PR touching a sensitive path is not merged automatically and gets the
  `needs-human-review` label plus one comment naming the matched paths. Sensitive set:
  `.github/`, `.mergify.yml`, `CODEOWNERS`, `deploy/`, `ansible/`, `infra/`, `stacks/`,
  `migrations/`, `.env*`, plus a per-repo extra list.
- REQ-M05: Merge method squash, queue batch size 1, merge on the exact tested head.
- REQ-M06: A shared template lives in docs/MERGIFY_FLEET_ADOPTION.md; per-repo files differ only
  in required checks and extra sensitive paths.
- REQ-M07: Each repo adoption is proven by one positive canary (code PR merged by mergify[bot])
  and one negative canary (sensitive PR labelled, not merged).
- REQ-M08: Rollback per repo is documented: remove `.mergify.yml` rules (or disable the queue)
  before re-enabling any legacy engine; never two engines at once.

### Epic D: deploy after merge, with a receipt
- REQ-D01: For each registered project, PROJECTS.md (or the Memo Bridge catalog) declares a
  deploy target: `vps-image`, `vps-stack`, `mac-runtime`, `mac-app`, `release`, or `none`.
- REQ-D02: `vps-image` projects are deployed by the existing autodeploy. Memo Bridge reads its
  status and posts a commit status `memo/deploy` (success, failure, pending) on the merged SHA and
  one PR comment with stack, image digest and time, or the hold reason.
- REQ-D03: A deploy that fails or is rolled back produces a failure status and a `lab-notify`
  alert (already sent by autodeploy) and opens an Issue labelled `deploy:failed` once per SHA.
- REQ-D04: `vps-stack` changes (lab-infra compose and stack files) deploy after merge through a
  VPS-side job that refuses when production drifted from the previous main (drift check), takes
  the autodeploy lock, runs the same health probes and rolls back on failure.
- REQ-D05: memo-bridge itself: after a merge on main with green CI, the VPS role pin is advanced
  by an automated PR to lab-infra; that PR touches `ansible/` and therefore follows REQ-M04 until
  the owner opts that path in.
- REQ-D06: `mac-runtime` (memo-bridge on the Mac): a launchd job installs the latest green main
  build with install-local, keeps the previous bundle, health-checks the agent and restores the
  previous bundle on failure.
- REQ-D07: `mac-app` and `release`: drop publishes its release automatically when the release
  workflow is green and `DROP_RELEASE_AUTO_PUBLISH` is set; other Mac apps are `none` until they
  have a signing pipeline (documented as follow-up, not faked).

### Epic O: observability
- REQ-O01: A daily report in LIVE-STATE: green PRs not merged after 2 h with Mergify's reason,
  sensitive PRs waiting for the owner, held stacks, orphan worktrees older than 3 days.
- REQ-O02: Every automated action (reaper removal, deploy receipt) is appended to the Memo Bridge
  audit journal.

## 03. Acceptance criteria

- AC-C01 (REQ-C01, C05): Given a worktree on branch B, PR merged with headRefOid == HEAD, no
  local edits, when the reaper runs with --apply, then the worktree directory is gone,
  `git worktree list` no longer shows it, the local branch B is deleted. Verification: automated
  (temp repo fixture). Evidence: E-03, E-05.
- AC-C02 (REQ-C02): Given the same with a modified tracked file and an untracked file, then the
  archive dir holds `<name>.diff`, `<name>.untracked.tar.gz`, `<name>.status` and the worktree is
  removed. Given archiving fails, then the worktree is kept and the report says why. Automated.
- AC-C03 (REQ-C03): For each of locked, cwd in use, active claim, modified within grace, detached
  HEAD, open PR, no PR, HEAD ahead of PR head: the worktree is kept with that reason. Automated.
- AC-C04 (REQ-C04): Dry-run on any fixture changes nothing on disk (tree hash before == after).
  Automated.
- AC-C05 (REQ-C06): Two concurrent runs: the second exits with `locked`. Automated. Timer file
  installs with launchctl/systemd-analyze verify. Inspection + runtime on the Mac. Evidence: E-05
  (Mac, launchd). VPS systemd: not installed.
- AC-M01 (REQ-M02, M07): Given memo-bridge with the new .mergify.yml, when a bot PR changing a
  file under server/ goes green, then mergify[bot] merges it. Runtime canary. Evidence: E-01.
- AC-M02 (REQ-M04, M07): Given a PR touching deploy/, then it gets `needs-human-review` and a
  comment, and stays open. Runtime canary. Evidence: E-02. Verified: stays open with green CI,
  and the "Mergify Merge Queue" check names the failing `-files` condition. Not verified:
  label and comment. #154 dropped the comment rule (paid Mergify feature) and Mergify posts no
  comment of its own on such a PR (checked on #156). Gap tracked as T-M2b.
- AC-M03 (REQ-M01, M08): For each adopted repo, `gh api repos/X/actions/workflows` shows legacy
  merge workflows disabled and `.mergify.yml` present. Inspection.
- AC-D01 (REQ-D02): Given a merged SHA of a vps-image project, when autodeploy reports success,
  then `memo/deploy` = success on that SHA and one PR comment exists. Runtime (lab-hub canary).
- AC-D02 (REQ-D03): Given autodeploy holds the stack, then `memo/deploy` = failure, one Issue
  `deploy:failed`. Automated (status-file fixture) + runtime if a safe failing canary exists.
- AC-D03 (REQ-D04): Given production drifted, the stack deploy refuses and reports drift.
  Automated. Given a failing probe, it rolls back. Automated on a fixture stack.
- AC-D04 (REQ-D06): Given a broken bundle, the Mac runtime updater restores the previous one and
  the agent is healthy. Automated + runtime on the Mac.
- AC-O01 (REQ-O01): LIVE-STATE contains the stuck-PR section with reasons. Runtime.

## 04. Work graph

| ID | P | Status | Req | Depends | What | Verify |
|---|---|---|---|---|---|---|
| T-SPEC | P0 | DONE | all | - | this document (#149), merged as #152 | review |
| T-C1 | P0 | DONE | C01-C05 | T-SPEC | reaper module + CLI + tests (#150), merged as #153; broken_gitdir reason #155 | pnpm test |
| T-C2 | P1 | DONE (Mac) | C06 | T-C1 | launchd/systemd examples, install on the Mac; VPS timer not installed | runtime E-05 |
| T-C3 | P1 | TODO | C07 | - | delete_branch_on_merge on adopted repos (repo setting, owner or App admin). Off today on memo-bridge and uni-protocol; on for cuesheet, problem-intelligence-engine, drop, lab-hub | gh api |
| T-M1 | P0 | DONE | M02,M04,M05 | T-SPEC | new memo-bridge .mergify.yml (#151), merged by the owner as #154 | Mergify check |
| T-M2 | P0 | DONE | M07 | T-M1 | positive + negative canary on memo-bridge | runtime E-01, E-02 |
| T-M2b | P1 | IN_PROGRESS (owner merges memo-bridge#161, cuesheet#84, problem-intelligence-engine#34, uni-protocol#37) | M04 | T-M2 | label `needs-human-review` + one comment naming the matched paths on sensitive PRs, without a paid Mergify feature (a small workflow under .github/, so the owner merges it) | runtime on a deploy/ PR |
| T-M3 | P1 | DONE | M06,M08 | T-M2 | fleet template + adoption doc, merged as #158 (docs/MERGIFY_FLEET_ADOPTION.md) | review |
| T-M4 | P1 | DONE | M01,M07 | T-M3 | adopt public repos: cuesheet#81, problem-intelligence-engine#31, uni-protocol#34, merged by the owner. lab-hub (memolabs-dev) has no PR traffic: nothing to adopt | E-08, E-09 |
| T-M4c | P1 | DONE | M07 | T-M4 | positive + negative canary on cuesheet, problem-intelligence-engine, uni-protocol | runtime E-09 |
| T-M4d | P1 | BLOCKED | M01,M07 | T-M3, U-03 | adopt drop | canary |
| T-M5 | P1 | BLOCKED | M01,M07 | T-M3, U-02 | adopt private memolabs-dev repos: emargo (disable auto-merge.yml), lab-console, rebuild-radar, mobile-explorer, kollio-v3 | canary proves Mergify Free on private |
| T-M6 | P1 | BLOCKED | M01 | U-01 | personal repos (lab-infra, kollio-mac, world-kernel, memo-cc, stasis, intentlane) | owner decision |
| T-D1 | P1 | DONE | D01 | T-SPEC | deploy targets derived from what deploys (VPS compose images, release workflows), not a PROJECTS.md column; snapshot in docs/DEPLOY_TARGETS.md | inspection E-11 |
| T-D2 | P1 | TODO | D02,D03,O02 | T-D1 | deploy receipt: read autodeploy status on VPS, post memo/deploy + PR comment + Issue on failure | automated + lab-hub canary |
| T-D3 | P1 | TODO | D04 | T-D2, T-M6 | lab-infra stack deploy-on-merge with drift check and rollback | automated fixture |
| T-D4 | P1 | TODO | D05 | T-D2 | memo-bridge pin bump PR to lab-infra after green main | runtime |
| T-D5 | P1 | TODO | D06 | T-SPEC | Mac runtime self-updater with previous-bundle restore | automated + runtime |
| T-D6 | P2 | TODO | D07 | - | drop auto-publish variable; other Mac apps stay `none` | inspection |
| T-O1 | P1 | TODO | O01 | T-C1, T-D2 | stuck-PR and orphan section in LIVE-STATE | runtime |

Planning completeness check: with every row done, an Issue in a public memolabs-dev repo goes to
merged, deployed (vps-image) and cleaned up untouched. Private and personal repos and non-image
targets depend on T-M5, T-M6, T-D3..D5, which are listed with their blockers, not hidden.

## 05. Risks

| ID | Risk | L | I | Mitigation | Status |
|---|---|---|---|---|---|
| R-01 | A green but wrong code PR lands without review | M | H | owner decision; CI is the gate; sensitive paths excluded; squash on exact head; revert is one PR; Mergify can be paused with `hold-merge` | ACCEPTED by owner, mitigated |
| R-02 | Reaper deletes work another session needs | L | H | merged-head equality, grace window, claim/job/cwd/lock checks, archive before removal, dry-run default | MITIGATED: AC-C01..C04 pass in tests, first real --apply removed only merged-head worktrees (E-05) |
| R-03 | Mergify Free does not cover private repos | M | M | canary per private repo before relying on it; fallback is the existing land.py contract (works on private via reusable workflow) | OPEN (U-02) |
| R-04 | Two merge engines act on the same PR | M | H | disable legacy first, verify with gh api, one PR per repo | OPEN per repo |
| R-05 | Stack deploy overwrites hand changes in production | M | H | drift check refuses; existing trap note lab-infra-deploy-traps.md | OPEN (T-D3) |
| R-06 | Auto-deploy of memo-bridge breaks the bridge that runs the loop | M | H | pin bump stays a PR under REQ-M04; Mac updater keeps previous bundle and restores | OPEN (T-D4, T-D5) |
| R-07 | GITHUB_TOKEN merges do not trigger downstream workflows | L | M | Mergify merges with its App identity, which does trigger push workflows | CLOSED: E-04 |

## 06. Unknowns
- U-01 BLOCKING for T-M6: for guillaume-flambard/* repos, install Mergify on the personal
  account, or transfer them into memolabs-dev. Owner decision (outward, account-level).
- U-02 BLOCKING for T-M5: Mergify Free on private repos. Resolved by the emargo canary.

- U-03 BLOCKING for T-M4d: drop requires GitHub's merge queue through ruleset 24880009 (merge
  commits only), which blocks every Mergify merge, and its CONTRIBUTING says "The maintainer
  reviews and merges", with a security review on protocol, relay, node, runner, capabilities and
  requester-mcp. Owner decision: remove the `merge_queue` rule (or exempt Mergify) and rewrite
  those CONTRIBUTING lines, or keep drop out of the autoloop.

- U-04 BLOCKING for the T-D2 runtime canary: no Mergify-adopted repository deploys an image on
  merge (docs/DEPLOY_TARGETS.md). Owner decision: bring a `vps-image` repository into the loop
  (lab-hub-public, which needs PRs to become its way in; drop after U-03; emargo after U-02;
  personal ones after U-01). T-D2 code can be written and tested on fixtures before that.

## 07. Verification plan
STATIC: Mergify config check on the PR; node --check. UNIT/INTEGRATION: node:test fixtures with
temp git repos for the reaper (no network, PR state injected). SYSTEM: reaper dry-run on the real
Mac, report reviewed, then --apply. RUNTIME: Mergify canaries, lab-hub deploy receipt canary.
MANUAL: the owner watches one Issue go to deployed without touching it.

## 08. Evidence

Times are UTC. Mac = the owner's Mac, memo-bridge main checkout at d2d0b7a for E-05.

- E-01 (AC-M01, 2026-10-17): #155, a code change under `server/runners/` authored by
  guillaume-flambard, went green (test 22, test 24) and was merged by `app/mergify` at 20:13:38
  without any owner action. Merge commit f12d09c. #152 (spec, non-sensitive) had also been merged
  by `app/mergify` at 20:05:07.
- E-02 (AC-M02, 2026-10-17): #156 touches only `deploy/reaper/*.plist.example`. CI green, PR
  still open, no label, no comment. The "Mergify Merge Queue" check reports
  "Waiting for queue conditions to match" with `-files ~= ^(...|deploy/|...)` as the only unmet
  condition (the bot-author line is one branch of an `any of` that the owner branch satisfies).
- E-03 (AC-C01..C04): `node --test tests/reaper.test.mjs` 19/19 and `pnpm test` 759/759 on the
  #155 branch.
- E-04 (R-07): the Mergify merges d2d0b7a (#152) and f12d09c (#155) each triggered a `push` CI
  run on main that succeeded.
- E-05 (AC-C01, AC-C05, T-C2): `~/Library/LaunchAgents/dev.memolabs.memo-reaper.plist`
  installed from the template (hourly, `RunAtLoad` false) and run once with
  `launchctl kickstart`. Log `~/Library/Logs/memo-reaper.log`, summary
  `{"apply":true,"counts":{"skip":7,"keep":32,"prune":26,"removed":4}}`. Removed, each with its
  local branch: infrastructure-guardian#1, memo-cc#2, stasis#1, memolabs-dev/.github#59. Kept
  with reasons: pr_open, no_pr, detached_head, bridge_workspace_active (3 merged memo-bridge
  worktrees whose Memo Bridge workspace is still open), head_differs_from_merged_pr,
  status_failed (8 Codex worktrees whose `.git` points into the removed `~/projects`; reported as
  `broken_gitdir` once the checkout runs #155).
- E-06 (T-C3, observation): `delete_branch_on_merge` is `false` on memo-bridge, so
  `fix/reaper-broken-gitdir` stayed on the remote after #155 merged.
- E-07 (T-M3, 2026-10-17): #158 merged by `app/mergify`. The previous French fleet page is kept
  verbatim as an annex; `scripts/mergify-fleet.mjs candidate` still emits the superseded pilot
  rules and must not be used for an adoption until aligned.
- E-08 (T-M4, 2026-10-17): cuesheet#81, problem-intelligence-engine#31, uni-protocol#34 open with
  CI green and the Mergify "Configuration changed" check reporting a valid configuration. uni#34
  was opened as a draft, labelled `hold-merge`, then marked ready: its legacy `pull_request_target`
  job "Enable merge after required CI" was skipped and no native auto-merge is armed. Existing
  open PRs cuesheet#79 and problem-intelligence-engine#30 got `hold-merge` so the new policy does
  not absorb them retroactively. `hold-merge` labels created on problem-intelligence-engine and
  uni-protocol. Merge methods: squash on cuesheet (as before), merge on the other two (their
  history), a deliberate deviation from REQ-M05. uni adds its trust paths to the sensitive set.
- E-09 (T-M4c, 2026-10-17): the adoption PRs were merged by the owner (cuesheet#81 20:34:38,
  problem-intelligence-engine#31 20:34:50, uni-protocol#34 20:35:04). On main afterwards each
  repository has `.mergify.yml` and no legacy merge workflow (`gh api .../actions/workflows`).
  Canaries, all authored by guillaume-flambard:
  - cuesheet: positive #82 (code: `src/adapters/frontier.ts`, `src/frontier-cli.ts`, tests;
    fixes cuesheet#78) merged by `app/mergify` at 20:41:34; negative #83 (`.github/workflows/ci.yml`,
    `persist-credentials: false`) open, CI green, only `-files` unmet.
  - problem-intelligence-engine: positive #32 (README, docs only) merged by `app/mergify` at
    20:46:15; negative #33 (root `AGENTS.md`) open, CI green, only `-files` unmet.
  - uni-protocol: positive #35 (`docs/roadmap.md`, docs only) merged by `app/mergify` at
    20:48:56; negative #36 (`.github/workflows/uni.yml`) open, CI green, only `-files` unmet.
  The PIE and uni positives are docs: code landing was proven on memo-bridge (#155) and
  cuesheet (#82), and the policy has no code exclusion left, so path rules are what each canary
  tests. The three negatives are real fixes left for the owner to merge or close.
- E-10 (T-M2b, 2026-10-17): `.github/workflows/sensitive-paths.yml` opened on the four adopted
  repositories (memo-bridge#161, cuesheet#84, problem-intelligence-engine#34, uni-protocol#37).
  Dry run of its script on the eight canaries: the four sensitive PRs matched with the right
  path, the four others not; both pattern spellings and uni's trust paths handled. Not yet run
  on GitHub (`pull_request_target` uses the base copy): after each merge, close and reopen that
  repository's negative canary and check the label and the single comment.
- E-11 (T-D1, 2026-10-17): read-only inventory of `/opt/stacks` on the VPS: 23 own images in 20
  stacks; emargo held. None of the four adopted repositories deploys an image. Nine running
  images have no `PROJECTS.md` row. Details and derivation commands: docs/DEPLOY_TARGETS.md.
