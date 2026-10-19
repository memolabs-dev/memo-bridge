# Owner console: drive every Memo Labs project from ChatGPT, on the Mac and the VPS

Written 2026-10-18 from the owner's request of 2026-10-17 (23:49 Paris): "en finir avec les PR
faites par moi, et pouvoir parler via ChatGPT à Memo Bridge, gérer et créer des projets et ce
que je veux via Memo Bridge, sur Mac et sur VPS."

## 00. Intent

### Goal
From one ChatGPT conversation the owner can (1) work on any Memo Labs project, on the host where
it lives (Mac or VPS), (2) create a new project, and (3) never merge a pull request by hand except
one that changes the gate itself.

### Owner decisions (2026-10-17, in conversation)
- D-1: only the gate waits for the owner: `.github/`, `.mergify.yml`, `CODEOWNERS`, the root
  `AGENTS.md`, root `.env*` (plus a repository's own stated trust paths, today uni-protocol).
- D-2: personal repositories move into `memolabs-dev`, where Mergify and the
  `memo-labs-automation` App are installed on all repositories.

### Non-goals
- A merge tool in Memo Bridge. Merging stays with Mergify.
- Moving private sources or corpora to the VPS (CDKF rule, issue #147).
- Driving ChatGPT programmatically (OpenAI terms; the owner opens conversations).

### Completion sentence
Done when, from ChatGPT: a new project is created and gets its first green PR merged by Mergify
without the owner; an existing transferred project is changed on the Mac and another on the VPS,
each through Issue, claim, worktree, test, PR and Mergify merge; and the only PRs left for the
owner are gate changes.

## 01. What exists (measured 2026-10-17/18)

- ChatGPT reaches Memo Bridge at `https://bridge.memolabs.dev/mcp` (OIDC Pocket ID, client
  certificate, writes enabled since 2026-10-15; docs/REMOTE_CHATGPT.md). 49 tools at the write
  stage. No merge tool, no project creation tool.
- Three hand-kept allowlists decide which project ChatGPT may touch:
  `/etc/memo-bridge/remote.json` `projects` (3 repos: memo-bridge, cuesheet, uni-protocol;
  rendered by lab-infra), the VPS runner registry and checkouts (lab-infra), and
  `PUBLIC_ALLOWLIST` in memolabs-dev/.github `scripts/issue_preflight.py` (7 public repos;
  private repos refused unless owner-enrolled for the Mac, `private_owner_allowlist`).
- Mac execution from ChatGPT is not live: the remote surface rewrites `host=mac` to the VPS.
  Owned by the existing spec `.agent/project/zero-friction-mac-routing/` (Issue #110) and P0
  #147; PR #148 (Mac runtime bootstrap, `deploy/`) is green and held with `hold-merge`.
- Mergify policy live with canaries on memo-bridge, cuesheet, problem-intelligence-engine,
  uni-protocol (autoloop spec). D-1 is open as memo-bridge#165, cuesheet#85,
  problem-intelligence-engine#35, uni-protocol#38 (they touch `.mergify.yml`: owner merges).
- D-2 lot 1 done: 26 repositories transferred (list in section 08, E-01).

## 02. Requirements

- REQ-T1: every registered personal repository is in `memolabs-dev`, with its deploy path intact.
  Lot 2 (VPS images: factura, foldready, kollio, paykit, relay, usine, veilleur, world-lab, plus
  spec-guard's trusted publisher and foldready's Pages) moves together with its lab-infra stack
  and CI image name change. Lot 3 is lab-infra itself, last.
- REQ-M1: every `memolabs-dev` repository with a required CI check has the fleet `.mergify.yml`
  and the `Sensitive paths` workflow, and passed a positive and a negative canary. A repository
  without CI gets a minimal CI first, or stays manual and is listed as such.
- REQ-A1: one rule replaces the three allowlists: a repository is workable from ChatGPT when it
  is a non-archived repository of `memolabs-dev`, registered in `PROJECTS.md`, and checked out on
  the host the request names. Private repositories are workable on the host that holds them; no
  private source is copied to the other host. It also covers the repository-scoped GitHub reads
  (`github_issues`, `github_pull_requests`, `github_workflows`, `github_checks`): they name only a
  repository, so they are placed by the local registry answer, and a repository the receiving host
  does not register is asked of the host that holds the checkouts (T-A1b).
- REQ-A2: the owner can create a project from ChatGPT: `project_create(name, template?, host,
  visibility)` creates `memolabs-dev/<name>` (from a template with CI and the fleet Mergify
  files), adds the `PROJECTS.md` row on the Mac under the registry lock, clones it on the chosen
  host, and returns a workspace ready for `batch_create`. Idempotent on `name`.
- REQ-H1: `workspace_open(project, host=mac|vps)` executes on that host (zero-friction spec).
- REQ-Z1 (zero ceremony, owner 2026-10-18 09:45: "je devrais même pas avoir besoin de citer Memo
  Bridge ou de parler de workspace"): a tool that needs a workspace and gets no `workspace_id` runs
  in the conversation's own workspace, as the operator tools already do. Chosen server-side
  (`server/tools/implicit-workspace.mjs`, coordinator `conversationWorkspace`), only among this
  principal's active workspaces bound to this conversation's session hash: the one holding
  `claim_id`, owning `worktree_id`, holding a claim on `issue`, on the hinted project (`project`,
  or the project whose origin is the Issue's repository), else the most recent. Only `task_claim`
  and `task_next` may open one, through `workspace_open` with every guard (authorization, project
  allowlist, session binding, delegation scope), journaled `workspace_auto_open`. No session hint,
  another conversation's workspace, or an Issue outside the allowed projects: `workspace_required`
  with one `next_step`, nothing opened. An explicit `workspace_id` is passed through unchanged.
  `workspace_open` stays available, no longer a required first call.
- REQ-Z2: intent-first tool metadata (OpenAI Apps SDK, "Optimize metadata",
  https://developers.openai.com/apps-sdk/guides/optimize-metadata): each remote tool description
  starts with "Use this when..." in the owner's words (French and English), says when not to use
  it, documents every parameter with an example, and states `readOnlyHint`, `destructiveHint`,
  `openWorldHint` truthfully. The server instructions keep only what the model needs to choose and
  chain tools; the server, not the text, enforces the rules. The remote `tools/list` size is
  measured (`pnpm run remote:toolsize`) before and after, and does not grow.
- REQ-Z3: a golden prompt set in French (direct, indirect, negative, end-to-end chains) with the
  expected tool for each, stored in the repository, and a manual protocol the owner runs in
  ChatGPT after a deploy to record precision and recall.

## 03. Acceptance criteria

- AC-T1: `gh repo list guillaume-flambard` shows no registered project; each lot-2 stack
  redeploys a new image from `ghcr.io/memolabs-dev/<name>` (autodeploy status success).
- AC-M1: per adopted repository, a positive canary merged by Mergify and a negative canary held
  and labelled (same evidence as autoloop E-09/E-13).
- AC-A1: from ChatGPT, `workspace_open` on a transferred repository that is in none of today's
  three lists succeeds, and on an archived or non-`memolabs-dev` repository it is refused.
- AC-A1b: from ChatGPT, `github_issues`, `github_pull_requests`, `github_workflows` and
  `github_checks` on a private Mac-only repository answer its real data instead of
  `repo_not_registered`; on a repository of a VPS project they stay on the VPS; a repository the
  receiving host does not register and the Mac is offline still answers `repo_not_registered`.
- AC-A2: from ChatGPT, `project_create` then `batch_create` then a worker chat ends with a green
  PR merged by Mergify; a second `project_create` with the same name returns the same project.
- AC-H1: from ChatGPT, `workspace_open(project, host=mac)` returns `host=mac` and a Mac worktree.
- AC-Z1: offline (tests/implicit-workspace.test.mjs, through the runtime tool handlers): a
  `task_claim` without `workspace_id` opens one workspace bound to the conversation and claims;
  later calls reuse it; another conversation, a call without session hint, a non-opening tool and
  an Issue outside the allowed projects open nothing and answer `workspace_required`; parallel
  first calls share one workspace; under `enforce` the binding still refuses another conversation.
  Live: in ChatGPT, "travaille sur l'issue N de <projet>" reaches a PR with no `workspace_open`
  call in the transcript.
- AC-Z2: every remote tool description (runtime and operator) starts with "Use this", names the
  sibling tool to use instead where the two could be confused, and every parameter is described
  (tests/tool-metadata.test.mjs); hints checked by the registry self-check; `remote:toolsize` at
  or below the bytes measured on 2026-10-18 before the change, for the read, write and operator
  stages (`scripts/remote-toolsize-budget.json`, enforced by the same test).
- AC-Z3: the owner ran the golden set after the deploy and recorded precision and recall per
  category in `docs/golden-prompts/RESULTS.md`; the target is in that file.

## 04. Work graph

| ID | P | Status | Req | Depends | What |
|---|---|---|---|---|---|
| T-D1 | P0 | DONE | M1 | - | narrow the sensitive set (D-1): memo-bridge#165, cuesheet#85, problem-intelligence-engine#35, uni-protocol#38 merged; memo-bridge#156 (`deploy/` only) then merged by Mergify |
| T-T1 | P0 | DONE | T1 | - | lot 1: 26 repositories transferred, Mac remotes updated (E-01) |
| T-T2 | P1 | TODO | T1 | - | lot 2: VPS-image repositories, one at a time: transfer, CI image name, lab-infra stack image, autodeploy check |
| T-T3 | P1 | TODO | T1 | T-T2 | lot 3: lab-infra |
| T-M1 | P1 | TODO | M1 | T-D1 | adopt Mergify on transferred repositories that have CI (template + canaries) |
| T-M2 | P2 | TODO | M1 | T-M1 | minimal CI for repositories without one, then adopt |
| T-A1 | P0 | DONE for public repos (E-02, E-05; incident E-04) | A1 | - | org rule in issue_preflight.py (.github#61); 17 public projects in the VPS runner, registry and remote.json (lab-infra#241, #242), deployed. Still a list in lab-infra: a new public repo needs one line there until T-A2 automates it |
| T-A1b | P0 | IN_REVIEW (code and offline tests E-13; deploy pending) | A1 | T-A1 | repository-scoped GitHub reads (`github_issues`, `github_pull_requests`, `github_workflows`, `github_checks`) reach the Mac when the receiving host does not register the repository; before, they answered `repo_not_registered` on a private repository (seen after E-11) |
| T-A2 | P0 | IN_REVIEW (design: section 09; code and offline tests E-12; runtime step R-A2 below) | A2 | T-A1 | `project_create` on the Mac runtime: App purposes repo_create/repo_admin, template repository `memolabs-dev/project-template` (owner publishes), registry writer under the `proj` lock, Mac clone, readiness and owner steps |
| T-A3 | P1 | TODO | A1, A2 | T-A2 | close the gaps G-1 (Mac self-enrollment of created repositories, T-A3c) and G-2 (ORG_REPO pre-filter T-A3a, VPS registration without lab-infra hand edits T-A3b), plus the two warts the incidents exposed: the App purposes reported by `startupCheck` (T-A3d, E-15) and the governance ref the Mac install accepts (T-A3e, E-16), section 09 |
| T-H1 | P0 | DONE end to end (E-11): ChatGPT, Mac workspace, claim, Mac worktree, passing sandboxed test job, PR merged by Mergify on a private repository. Follow-up: dependency install phase for Mac jobs (Node, Go projects need it) | H1 | - | zero-friction Mac routing (#110, #114, #147): memo-bridge#171, .github#63, lab-infra#245; runbook `mac-runtime-routing/activation.md` |
| T-Z1 | P0 | DONE (E-06) | Z1 | - | implicit workspace: wrapper, coordinator `conversationWorkspace`, tests (memo-bridge#169) |
| T-Z2 | P1 | IN_REVIEW (E-07) | Z2 | T-Z1 | intent-first descriptions and shorter instructions, size measured (PR feat/intent-metadata) |
| T-Z3 | P1 | READY, owner run pending | Z3 | T-Z2 | golden prompt set and owner protocol (same PR); the owner runs it after the next deploy, which needs his go: the VPS runs 93e3bed, 40+ commits behind main |

## 05. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | A transfer breaks a deploy silently (GHCR packages stay with the user account) | lot 2 moves stack and CI together and checks autodeploy; lot 1 had no image, Pages or trusted publisher |
| R-2 | The org rule widens what ChatGPT can write | writes still need the OIDC owner, client certificate, claim, worktree, CI and Mergify; archived and foreign repos refused |
| R-3 | `project_create` makes repositories by mistake | idempotent on name, owner principal only, audit journal, delete stays manual |
| R-4 | Open PRs get absorbed by a wider policy | before each policy change, list newly eligible open PRs and hold them (done for #148, #132) |
| R-5 | Shared `PROJECTS.md` written concurrently | one writer path under a lock, never a hand edit |
| R-7 | The implicit workspace widens who can act on a workspace | only workspaces bound to the caller's own session hash are chosen; opening goes through `workspace_open` and its guards; explicit ids keep every check; no session hint, nothing chosen (AC-Z1) |
| R-8 | Shorter instructions make the model skip a needed step | the server refuses with one `next_step`; golden set measures it (AC-Z3) |
| R-6 | A governance change breaks a consumer that reads it as text | before pinning a governance commit, run memo-bridge `coordinator.test.mjs` with `MEMO_BRIDGE_GOVERNANCE_ROOT` on it and parse it with the deployed module (E-04) |

## 06. Unknowns
- U-1: closed 2026-10-18 09:41 Paris: installation 170927025 has `administration: write`.
- U-3: whether GitHub accepts the organization-wide `repo_create` token for `generate` exactly as
  the permissions table says; the first real call decides (refusal code `github_forbidden`).
- U-2: whether Mergify Free covers private org repositories in practice (pricing page: free for
  private teams up to 5 users). First private canary decides.

## 07. Verification plan
Static: config checks, unit tests on the rule and on `project_create` with GitHub stubbed.
Runtime: AC-A1, AC-A2, AC-H1 from a real ChatGPT conversation; canaries per adopted repository.

## 08. Evidence
- E-01 (T-T1, 2026-10-18 00:0x Paris): transferred to memolabs-dev, with redirect checked and the
  Mac `origin` updated: acadomia-calendrier, agent-reality-bench, aidd-guard, aurago, cra-clock,
  github-merge-gate, gtm, horslot, infrastructure-guardian, intentlane, jp-petit-website,
  kollio-mac, life-os, marketplace-kit, medsharing, memo-cc, music-lab, navirox,
  odoo-safety-parts, podintel, reprisette, stasis, trufflo, valve, vulnforge, world-kernel.
  `gh api orgs/memolabs-dev/installations`: mergify `all`, memo-labs-automation `all`.
  `git ls-remote` and `git fetch` work on the new URLs.
- E-02 (T-A1, 2026-10-18 00:41 Paris): .github#61 and lab-infra#241 merged (by the agent, on the
  owner's explicit request in chat), `make deploy-memo-operator` from a clean checkout at 91539f6
  after regenerating the stale catalog snapshot (`scripts/export-project-catalog.mjs`, 71
  projects): ok=102 changed=10 failed=0. On the VPS: 17 clones under /var/lib/memo-runner/repos,
  17 registry rows, 17 `remote.json` projects, hub and runner active, no warning in the journal.
  Simulation with the deployed modules and live files: 17 of 17 projects allowed and available
  for the owner's ChatGPT principal. Not yet checked from a real ChatGPT conversation.
- E-03 (T-A1, 2026-10-18 08:5x Paris): lab-infra#242 merged on request, `make deploy-memo-bridge`
  at 5216df2: ok=69 changed=1 failed=0; governance checkout at 836e39b, clean. Preflight at
  836e39b with GitHub reachable: stasis, world-kernel, memo-bridge in scope; emargo refused
  (private, not enrolled on the host); guillaume-flambard/lab-infra refused (outside the org).
  Superseded by E-04: that pin broke the deployed coordinator and was rolled back.
- E-04 (incident, 2026-10-18): the deployed coordinator (memo-bridge 93e3bed) reads the ledger
  pre-filter as text: the `PUBLIC_ALLOWLIST = frozenset({...})` literal of issue_preflight.py
  (`parsePublicAllowlist`). .github#61 had removed it. From the lab-infra#242 deploy (~08:53
  Paris) `readPublicAllowlist` on the VPS returned `ledger_unavailable`, so every claim would have
  been refused. Detected by memo-bridge CI on #167 (its job checks out .github main), confirmed on
  the VPS with the deployed module, rolled back by lab-infra#243 (pin `7709984`, deployed ~09:09,
  `readPublicAllowlist` ok, 7 repos). Journals: no `ledger_unavailable` and no claim in the window.
  Fix: memolabs-dev/.github#62 restores the literal as a compatibility list (18 public repos) and
  the "allowlist" word that issue-lease.mjs maps; memo-bridge coordinator tests 31/31 on it, 29/31
  on 836e39b. Next: merge #62, re-pin, redeploy; later teach memo-bridge `ORG_REPO` and drop the
  literal. Lesson recorded as R-6.
- E-05 (T-A1, 2026-10-18 09:4x Paris): memolabs-dev/.github#62 merged (8a7f7ba). Before pinning,
  on 8a7f7ba: memo-bridge `coordinator.test.mjs` 31/31 with `MEMO_BRIDGE_GOVERNANCE_ROOT` on it, and
  the deployed VPS parser reads 18 repositories (R-6). lab-infra#244 (pin 8a7f7ba) merged after its
  CI was green, `make deploy-memo-bridge` at a61c83b: ok=69 changed=1 failed=0. On the VPS:
  governance at 8a7f7ba and clean; `readPublicAllowlist` ok with 18 repositories, all 17
  `remote.json` projects in it; hub and runner active, no warning; no `ledger_unavailable` since
  08:45. A real ChatGPT conversation is still the last check (AC-A1).
- E-06 (T-Z1, 2026-10-18 10:00 Paris): memo-bridge#169 merged by Mergify (9dd71f6) after CI
  test (22) and test (24) green. Offline: 11 tests in tests/implicit-workspace.test.mjs through the
  runtime tool handlers (open on first task_claim, reuse by claim, worktree, Issue, project; refusal
  for another conversation, no session hint, non-opening tools, Issues outside the allowed
  projects; one workspace for parallel first calls; enforce binding). The Mac routing session
  (memo-bridge#171, merged right after) routes implicit calls to the Mac runtime for Mac-only
  projects (`bridge/workspace-host-router.mjs` implicitDestination). Not yet deployed, not yet
  seen from a real ChatGPT conversation (AC-Z1 live half).
- E-07 (T-Z2, T-Z3, 2026-10-18): `pnpm run remote:toolsize` before (f1a066e) and after: read
  22 978 to 22 967 bytes, write 53 289 to 50 057, write with operator tools 96 129 to 91 328;
  remote server instructions 6 631 to 3 931 bytes. Every remote tool description starts with
  "Use this" and every parameter is described (tests/tool-metadata.test.mjs). openWorldHint set
  false on delegation_join, delegation_report and delegation_end (store only, no ledger call).
  Golden set: 38 prompts (13 direct, 12 indirect, 4 chains, 9 negative), `node
  scripts/golden-prompts.mjs --check` ok; protocol in docs/golden-prompts/PROTOCOL.md. The owner
  run (AC-Z3) waits for the deploy.
- E-08 (T-H1, 2026-10-18 10:44 to 10:50 Paris): on the owner's go in chat, memolabs-dev/.github#63
  merged (ff63ce8: the ledger reads the owner's home from the account, not `$HOME`) and
  lab-infra#245 merged (4904ae7: `memo_bridge_mac_runtime_routing: true`, `memo_bridge_version`
  9125909 = memo-bridge main with #171, #169, #172; governance pin unchanged at 8a7f7ba, since #63
  only matters on a macOS runtime). R-6 before merging: memo-bridge 9125909
  `coordinator.test.mjs` 31/31 on 8a7f7ba and on #63's head; `parsePublicAllowlist` of 9125909
  and of the deployed 93e3bed read 18 repositories from both. Before the deploy: online backup of
  the coordinator store (`coordinator.sqlite.pre-9125909`, user_version 7, integrity ok, 0600)
  and of the hub state (`/root/memo-bridge-hub-state.pre-9125909.tgz`); a scoped dry run
  (ok=102 changed=6 failed=0). `make deploy-memo-operator` from a clean detached worktree of
  4904ae7: ok=103 changed=7 failed=0. On the VPS: hub and runner restarted 10:49 and active, no
  warning or error in their journals, store migrated to user_version 8, `remote.json` with the
  17 projects and `mac_runtime_routing: enabled`, `readPublicAllowlist` ok with 18, the 17
  projects registered, available, in the allowlist and allowed for the owner principal (deployed
  modules, live files), 0 `ledger_unavailable` since 08:45, governance 8a7f7ba clean, the Mac
  probe agent connected. Operator agents not restarted: operator, agent and protocol code are
  identical between 93e3bed and 9125909. Rollback: revert lab-infra#245, stop the runner,
  `PRAGMA user_version = 7` on the store (the v8 tables are additive), redeploy from the revert
  commit. Still open: the Mac runtime agent install (owner) and AC-H1 from a real ChatGPT
  conversation.
- E-09 (T-H1, 2026-10-18 11:13 to 11:40 Paris): Mac runtime agent installed on the owner's Mac
  (`deploy/mac/install-runtime-agent.sh --install`, memo-bridge 9125909, governance ff63ce8, 23
  private projects enrolled). The first `--install` hit a launchd race (`Bootstrap failed: 5`)
  that left the agent unloaded about 48 s; bootstrapped by hand, `runtime_ready` with 57 ops,
  accepted by the hub (`agent_hello` host mac, ignored 0); fixed in memo-bridge#174. From a real
  ChatGPT conversation (Memo Bridge connector): `workspace_open` on
  clinical-data-knowledge-foundation answered machine Mac (`ws_Bl8BU71Ki2Z_zlEV`, route `mac` in
  the hub's `workspace_routes.json`); `batch_create` then `task_claim` created and claimed CDKF#14;
  `worktree_create` gave `~/memolabs/workspace/worktrees/clinical-data-knowledge-foundation/agent-14-bl8bu71k`
  on branch `agent/14-bl8bu71k`, README written (checked on disk). AC-H1 passed. CDKF has no
  root test recipe (`unknown_recipe`), so a second canary on horslot (private, Go): horslot#1
  claimed, Mac worktree, `jobs_submit test` ran `go test ./...` on the Mac in the sandbox
  (`job_E5CIx0laJU7K0HGd`, host mac): packages without dependencies passed, the ones needing
  `gopkg.in/yaml.v3` failed because the sandbox has no network (`lookup proxy.golang.org: no such
  host`). Gap found: `task_status` on an Issue with no workspace went to the VPS and answered
  `project_not_allowed`; fixed in memo-bridge#175 (calls naming a project or an Issue placed like
  implicit ones), not deployed yet. Cleanup: `task_release` and `workspace_close` from ChatGPT
  (both workspaces closed on the Mac); `worktree_remove` is not on the remote surface, so the two
  canary worktrees and branches were removed locally; CDKF#14 and horslot#1 closed. Nothing
  pushed. Still open: a test job that passes on the Mac (dependencies reachable offline), PR
  merged by Mergify on a private repository (none has Mergify yet).
- E-10 (T-H1, 2026-10-18 11:34 to 11:49 Paris): on the owner's go, lab-infra#246 pins memo-bridge
  fb463c3 (merge of #175; the only file the VPS runs that changed is
  `bridge/workspace-host-router.mjs`, no store or hub state change). R-6: `coordinator.test.mjs`
  31/31 on governance 8a7f7ba, 18 repositories parsed; router tests 15/15; `./scripts/tests.sh`
  116/116; scoped dry run changed=2 failed=0. Store and hub state backed up
  (`coordinator.sqlite.pre-fb463c3`, user_version 8). Merged after CI 4/4 (b926808),
  `make deploy-memo-operator` from a clean detached worktree: ok=100 changed=2 failed=0. Hub and
  runner restarted 11:46:52, no warning, Mac runtime reconnected (57 ops); remote.json 17 projects
  with routing on, allowlist 18, 17/17 projects allowed and available. From ChatGPT, `task_status`
  on CDKF#14 with no workspace: hub journal `outcome: ok` (was `project_not_allowed` from the VPS
  in E-09). Rollback: revert lab-infra#246 and redeploy (no database step).
- E-11 (T-H1, 2026-10-18 11:55 to 12:04 Paris): the whole loop on a private repository.
  memolabs-dev/memo-founder-skills (private, zero dependencies, `node --test`) adopted the fleet
  Mergify policy: memo-founder-skills#11 (template, checks `check (22)` and `check (24)`,
  sensitive-paths workflow) merged by the agent on the owner's explicit authorization in chat,
  6e15f58. Mergify Free covers private repositories up to 5 users (https://mergify.com/pricing),
  which clears U-02. From ChatGPT, one message: `batch_create` memo-founder-skills#12, claim on
  the Mac, worktree `agent-12-2gys1440`, README line, `jobs_submit test` on the Mac in the
  sandbox (`job_tt3GppVWQnbKHbT0`, succeeded, exit 0), commit 5a9fdfd, push, PR
  memo-founder-skills#13 (README only, CI check (22) and (24) green). Mergify queued it on its own
  (12:01:30 Paris) and merged it via the merge queue at 12:03:41 (`mergedBy`
  app/mergify, squash 4dae04a); #12 closed as completed. Before that, `task_status` on CDKF#14 from
  ChatGPT returned the lease (`state: released`, worker `mb.mac.ws_Bl8BU71Ki2Z_zlEV`) through the
  deployed #175. Gap left: the Mac executor has no dependency install phase (the VPS one has,
  network on, scripts off), so Node projects without `node_modules` and Go projects with modules
  fail offline in the sandbox (horslot, E-09).
- E-12 (T-A2, 2026-10-18, offline): `project_create` implemented (memo-bridge PR feat/project-create).
  `tests/project-create.test.mjs` 10/10 (owner only, Mac only, name validation, refused
  combinations, idempotence, refusal paths, registry writer under its lock, no DELETE),
  `tests/project-template.test.mjs` 2/2, `tests/github-app.test.mjs` 17/17 (purposes
  repo_create and repo_admin, App only, purpose gate), `tests/runtime-mac-install.test.mjs` 4/4
  (`--app-key`, plist App variables, key removed without the flag), router test (always the
  Mac). Full suite 817 tests: 816 pass, 0 fail, 1 skipped; `test:deploy` 124 OK; build and smoke ok (67 tools).
  `remote:toolsize` write 51 451 bytes (budget 53 289), operator 92 722 (budget 96 129).
  R-6 regression: `coordinator.test.mjs` 31/31 with governance 8a7f7ba, its literal parsed (18).
  Not run against GitHub: the template repository is not published and nothing was deployed.
- E-13 (T-A1b, 2026-10-18, offline): the four repository-scoped reads take only `repo`
  (`server/tools/github-tools.mjs`) and `resolveRepo` consults the registry of the host that
  received the call, so on the VPS a private repository answered `repo_not_registered` from ChatGPT
  (seen after E-11). `bridge/workspace-host-router.mjs` now places them on the local registry
  answer: `repo_not_registered` from the receiving host and only that sends the read to the Mac,
  which re-runs `resolveRepo`, `remoteRepoAllowed` against the owner policy and the owner enrolment.
  No repository to project map is built: `server/catalog-snapshot.mjs` deliberately exports no git
  origin, and exporting one would put private origins on the VPS. A policy refusal is never
  retried, `github_create_pr` is untouched, a Mac that is offline or probe-only leaves the local
  refusal standing, and the retry is journaled `repo_scoped_read_routed_to_mac`. Four cases added to
  `tests/workspace-host-router.test.mjs` (18/18); full suite 821 tests, 820 pass, 0 fail, 1 skipped;
  `test:deploy` 124 ok; build ok; smoke 67 tools with `roundTrip` and `multiHost`; `coordinator.test.mjs`
  31/31 with `MEMO_BRIDGE_GOVERNANCE_ROOT` on the pinned 8a7f7ba (R-6); `remote:toolsize` unchanged
  (read 22 967, write 51 451, operator 92 722). Not deployed; the VPS still runs fb463c3.
- E-14 (T-A1b, 2026-10-18 13:07 UTC): the routing fix merged on its own. memo-bridge#181 merged by
  `app/mergify` without the owner acting (Mergify `land_conditions`: base main, not a draft or a
  fork, author `guillaume-flambard`, checks `@github-actions/test (22)` and `(24)` green, no hold
  label, no sensitive path), main at `2909e4cdadc75dbf0b8e9e84d630d81d8ac6863f`. lab-infra#249
  pins `memo_bridge_version` at that sha, one file (`ansible/group_vars/lab.yml`), and carries #179
  and #180 with it; the pinned release has the four bridge files the roles preflight
  (`operator-root-cli.mjs`, `hub-state.mjs`, `public-listener.mjs`, `remote-config.mjs`) and
  `./scripts/tests.sh` is green (116 verts, 0 rouges) before the push. The PR is open without the
  `safe-automerge` label, and on this PR that label would change nothing: `ansible/` is a protected
  path there, so the gate skips it and only a human merges it (measured in E-15, which also corrects
  what a merge would do). Rollback is the previous pin, `fb463c3`. AC-A1b closes with one
  `github_pull_requests` call from ChatGPT on a private repository, once this pin runs.

- E-15 (T-A1b and T-A2, 2026-10-18 15:05 to 15:25 Paris, on the owner's go, the three steps of
  R-A2, before the VPS deploy):
  - lab-infra#249 (branch `chore/memo-bridge-pin-181`, commit f4a4f24) pins `memo_bridge_version` at
    2909e4c in one file and carries #179 and #180 with it. CI is green (`tests`: `hors-ligne` and
    `ansible-dry-run` on disposable infrastructure; GitGuardian). Correction of E-14: merging that PR
    is NOT the deploy, and `autodeploy` does not apply the pin. `/usr/local/bin/autodeploy` only
    restarts docker stacks under /opt/stacks whose images start with our GHCR or local-registry
    prefixes; the memo-bridge pin reaches the VPS only through `make deploy-memo-operator`. And no
    bot can merge that PR at all: `ansible/` is a protected path in this repository's own
    `scripts/private_merge_gate.py` (`PROTECTED`) and in `memolabs-dev/.github` `scripts/land.py`
    (`^ansible/`), where the contract says those changes stay merged by a human; the `safe-automerge`
    label is inert on it, and every earlier pin PR (#240 to #246) was in fact merged by
    `guillaume-flambard` himself. Pre-deploy dry runs, from a detached worktree at f4a4f24:
    `ansible-playbook --check --diff --tags memo-bridge,memo-operator` ok=100 changed=2 failed=0
    (the `bridge` and `server` app dirs, then the two units), and the full `make check` ok=671
    changed=13 failed=0, the other 11 being drift outside this pin. Store and hub state backed up
    before anything: `coordinator.sqlite.pre-2909e4c` (online `.backup`, user_version 8, integrity
    ok, 0600) and `/root/memo-bridge-hub-state.pre-2909e4c.tgz`.
  - `memolabs-dev/project-template` published, from 2909e4c with the owner's `gh` login
    (`node scripts/project-template.mjs publish --execute`): public, `is_template: true`,
    `delete_branch_on_merge: true`, 8 files including the two workflows, first commit a6da972.
    `check` was green before (8 files, `sensitive-paths.yml` byte-identical to memo-bridge's, one
    required check named `check`).
  - Mac runtime switched to 2909e4c with the App key, 15:23:39 to 15:24:29 (50 s, no launchd race):
    `deploy/mac/install-runtime-agent.sh --owner-sub b31f467f-... --governance-ref 8a7f7ba
    --from-registry --app-key <the App key path> --install`, 23 private projects re-enrolled,
    `runtime_ready` with 58 ops, executor local, process running from
    `runtime-releases/2909e4c...`, the probe plist kept as `.probe` for `--rollback`. The hub
    accepted the hello with `ignored: 1`: the VPS still runs fb463c3, which does not know
    `project_create`, and unknown agent ops are ignored (`bridge/hub.mjs`). The other conversation
    that was working on CDKF through the Mac was not broken: its `task_release` (15:24:35) and
    `workspace_close` (15:24:41) answered ok, and the hub journal has no error since 15:23.
  - Wart found, behaviour unchanged: `runtime_ready` now reports
    `github_auth: {app: configured, ledger: app, push: app}` because `startupCheck` names the App as
    the source for ledger and push as soon as the App key is configured, without consulting
    `MEMO_BRIDGE_GITHUB_APP_PURPOSES` (`server/integrations/github-app.mjs`). The call path itself
    still refuses the App for those purposes and falls back to the owner's `gh` token, which is what
    D-A2-2 wants (before the switch: `app_token_failed purpose ledger code app_config_invalid`, then
    `app_token_fallback credential ledger-gh`). Candidate T-A3d: make that report honour the
    purposes gate, so the log stops claiming `app` for a purpose that will fall back.
  - Still to do after this entry: the owner merges lab-infra#249 (protected path, human only), then
    `make deploy-memo-operator` from a clean worktree at the merged commit, then AC-A1b from ChatGPT
    (`github_pull_requests` on a private repository) and R-A2 steps 4 to 7 for AC-A2.
- E-16 (incident, 2026-10-18 15:49 to 16:05 Paris; the owner reported `lease_denied` on CDKF#22):
  after the E-15 switch the Mac runtime refused every private repository. The Mac journal carries
  `task_claim` denied `lease_denied` at 15:49:30 and 15:53:57 with issue
  `memolabs-dev/clinical-data-knowledge-foundation#22` (`via: hub`), while the same conversation had
  claimed CDKF#21 at 15:23:11, 26 minutes earlier, before the restart.
  - Cause: the E-15 install command passed `--governance-ref 8a7f7ba`, the **VPS** pin, to the Mac.
    8a7f7baf is `.github#62`, i.e. before `.github#63` (ff63ce8), which fixes exactly this case:
    Memo Bridge runs `issue_preflight.py` as its ledger child with `HOME` pointed at a private gh
    configuration directory (`server/coordinator/credentials.mjs` `ghChildEnv`), which is active
    because the App key sets `CREDENTIALS_DIRECTORY` and the runtime then keeps the ledger in
    credential mode. On 8a7f7baf, `private_owner_allowlist.py` resolves the owner's home from
    `$HOME`, so it names the gh configuration directory, and `MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE`
    can never equal the expected path: every enrolled repository answers False, and the ledger's
    message (`Repository privacy or enrollment mismatch`) is not in the coordinator's denial map,
    so it surfaces as the generic `lease_denied`. ff63ce8 reads the account home from
    `pwd.getpwuid(uid).pw_dir` instead; the two files differ only by that change.
  - Reproduced offline with the ledger child's own environment (owner sub, Mac flags, private repos
    file, `HOME` redirected): `private_owner_allowlist.allowed('memolabs-dev/
    clinical-data-knowledge-foundation')` answers False on 8a7f7baf and True on ff63ce8.
  - Fix, on the spot: the same install command with `--governance-ref
    ff63ce8d43971bdf368892569f35d9f2147f5a4f` (the `memolabs-dev/.github` main head, #63), the same
    bridge 2909e4c, the same App key and `--from-registry`. Staged first, the staged plist read
    before `--install` (governance root, bridge ref, 23 projects), and the governance directory was
    reused, not re-cloned. `runtime_ready` and `hello_accepted` at 16:04:09 Paris, 58 ops, executor
    local; the launchd plist now names `governance/ff63ce8d...`; the probe plist is untouched.
  - Verified after the restart, offline and read-only: the full preflight
    `issue_preflight.assess('memolabs-dev/clinical-data-knowledge-foundation', 22)` returns clean
    (privacy, enrollment and labels) with the exact child environment; `readPublicAllowlist()` from
    the installed release answers ok with 18 repositories, `memolabs-dev/memo-bridge` included
    (the R-6 regression check for a governance change); the runtime log shows `runtime_ready`, not a
    launchd race.
  - Lesson: the Mac governance pin is not the VPS pin. The VPS serves public repositories only,
    where the privacy branch is never reached, so 8a7f7baf stays correct there; the Mac must run
    the account-home fix or it refuses every enrolled private repository. R-A2 step 3 said "the
    pinned governance" without saying which pin: corrected in section 09. Candidate T-A3e: the
    installer refuses a `--governance-ref` whose `private_owner_allowlist.py` still resolves the
    home from `$HOME`, so the mistake cannot be repeated silently.
  - Separate family, not this incident: `workspace_open` answered `project_not_allowed` for a
    **public** project asked on the Mac (`project="drop", host="mac"`), because the Mac
    `remote.json` `projects` come from private enrollment only. The owner's ChatGPT conversation
    reproduced it and opened draft memo-bridge#184 for #114; no second writer here.

## 09. Design: `project_create` (T-A2, REQ-A2)

Written 2026-10-18 before the code, from the code and the configuration as they run (memo-bridge
main a89c7a2, lab-infra b926808, governance 8a7f7ba, App installation 170927025).

### What the tool does

`project_create({name, visibility?, host?, area?, template?, description?})`, owner only. In order,
every step idempotent, so a second call with the same name converges on the same project:

1. Validate: `name` kebab-case, `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, 2 to 50 characters, not a
   reserved name (`.github`, `project-template`); `visibility` `private` (default) or `public`;
   `host` defaults by visibility (private: `mac`, public: `vps`); `area` one of the six registry
   areas (`os|lab|products|research|clients|studio`, default `products`); `template` `default`
   (the only one today). Two combinations are refused before anything is touched:
   `private` + `vps` (`private_on_vps_refused`, the CDKF rule: no private source on the VPS) and
   `public` + `mac` (`public_on_mac_unsupported`: the Mac runtime serves only enrolled private
   repositories, `deploy/mac/runtime-mac.mjs enroll`).
2. Registry: a `PROJECTS.md` row with that name whose checkout's origin is not
   `memolabs-dev/<name>` refuses (`name_taken`). A row for the same origin is the idempotent case.
3. GitHub: read `memolabs-dev/<name>`.
   - Absent: generate it from the template repository
     (`POST /repos/memolabs-dev/project-template/generate`, `owner`, `name`, `description`,
     `private`, `include_all_branches: false`), then wait (bounded) until its default branch
     has the template commit. Journaled `project_repo_created` at once, so a failure after it is
     visible.
   - Present, generated from that template (`template_repository.full_name`), same visibility,
     not archived: the same project (`existing: true`). Anything else refuses (`repo_exists`,
     `visibility_mismatch`, `repo_archived`) and touches nothing: the tool never edits a
     repository it did not create.
   - Then `PATCH /repos/memolabs-dev/<name>` `delete_branch_on_merge: true` (safe to repeat).
4. Clone on the Mac into `$MEMOLABS_ROOT/<area>/<name>` (`git clone` with the runtime's own
   network credentials, `networkGit`, hooks off). An existing folder must already be a checkout
   of that origin (`path_occupied` otherwise). The Mac clone exists for both hosts: the registry
   row then always points at a real checkout.
5. Registry row, under the registry lock: `| <name> | <area>/<name> | repo | lab | à qualifier |
   <stack> | - |`, inserted in alphabetical order in the main table.
6. Readiness: `ready_for_batch_create` is true only when the runtime that will serve the project
   already allows it. Otherwise `owner_steps` lists exactly what is missing (next subsection).
   The answer always carries `repo`, `url`, `project`, `host`, `local_path`, `existing`, `steps`
   (what this call did) and `next`.

Never deletes: the module has no DELETE call and no rollback that removes; a failure leaves what
was made, and the next call goes on from there.

### Decisions

- D-A2-1, where it runs: the Mac runtime, because `PROJECTS.md` lives there and is the source of
  truth (`~/memolabs/AGENTS.md`). The hub's router sends `project_create` to the Mac when
  `mac_runtime_routing` is on (`bridge/workspace-host-router.mjs`, like `workspace_open host=mac`);
  an offline or probe-only Mac answers `host_offline`. Any other runtime answers
  `project_create_mac_only` with one `next_step`. Rejected: running the GitHub part on the VPS
  runner and the registry part on the Mac, which needs a two-runtime transaction in the hub for
  no gain (both deploys are needed either way).
- D-A2-2, credentials: GitHub App installation tokens only, no PAT fallback, two new purposes in
  `server/integrations/github-app.mjs`:
  `repo_create` `{administration: write, contents: read}` for the generate call and the
  existence read, minted for the organization (no `repositories` list: the repository does not
  exist yet, so it cannot be named there); and
  `repo_admin` `{administration: write}`, narrowed to the one new repository, for the settings
  PATCH. Required permissions from GitHub's table "Permissions required for GitHub Apps"
  (https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps, read
  2026-10-18): generate needs Administration write and Contents read; PATCH a repository needs
  Administration write. The installation has `administration: write` (checked 2026-10-18 with
  `gh api orgs/memolabs-dev/installations`). On the Mac the App is opt-in and narrow: the
  installer copies the App key into the runtime's credential directory and sets
  `MEMO_BRIDGE_GITHUB_APP_PURPOSES=repo_create,repo_admin`, so ledger, push and pull requests
  keep the owner's `gh` token exactly as today; without that variable every purpose may use the
  App, as on the VPS.
- D-A2-3, template repository, not files written by the tool: the installation has no
  `workflows` permission (same listing: actions read, administration write, contents write,
  issues write, metadata read, organization_projects write, pull_requests write,
  repository_projects write), and GitHub refuses to create or update `.github/workflows/*`
  through the contents or refs API without it (same table: those endpoints list Workflows
  write). Generation copies the template's files server side with Administration write and
  Contents read only. The template source is versioned in memo-bridge `templates/project/`
  (README, AGENTS.md, a zero-dependency `node --test` package, `.github/workflows/ci.yml` with one
  required check `check`, `.github/workflows/sensitive-paths.yml` byte-identical to memo-bridge's,
  `.mergify.yml` from `docs/MERGIFY_FLEET_ADOPTION.md` in the quoted pattern style with
  `check-success = @github-actions/check`), checked by `tests/project-template.test.mjs`. The
  owner publishes it once as `memolabs-dev/project-template` (public, `is_template: true`) with
  `scripts/project-template.mjs publish`: every file in it is a gate file, so the owner does it.
- D-A2-4, idempotence on name without a new table: GitHub and `PROJECTS.md` are the state. Same
  name, repository generated from the template, same visibility: same project, the remaining
  steps converge. No coordinator store migration.
- D-A2-5, registry writer: one function, under the `proj` CLI's own lock (`mkdir
  /tmp/proj-registry.lock`, ~/bin/proj), so `proj heal` and `project_create` serialize; read,
  insert and atomic rename all inside the lock, a backup copy in `~/.home/proj-backups/` first
  (same place as `proj`). Lock not obtained in 20 s: `registry_locked`, nothing written; a lock is
  never broken by the tool. Never a row edit or removal.
- D-A2-6, owner only and journaled: capability `github:write`, and the principal must be the
  owner: `oidc:<owner_sub>` of this runtime's remote.json, `hub:owner` or the local stdio owner.
  Rows: `project_create` (ok with code `created` or `existing`, denied, error) and
  `project_repo_created`; the `issue_ref` column carries `memolabs-dev/<name>` for these rows
  (there is no Issue), so `audit_events` finds them.
- D-A2-7, an exception to "Memo Bridge never writes outside its worktrees": `project_create` writes
  exactly two places outside them, one `PROJECTS.md` row and the new checkout folder, both under
  `MEMOLABS_ROOT` on the Mac, for the owner principal only.
- D-A2-8, Mergify on the first PR: the template's `.mergify.yml` lists the bot and the owner as
  authors, the `check` check and the gate paths. A worker PR that touches none of them lands
  without the owner (the E-11 loop). `delete_branch_on_merge` is set at creation (fleet step 7).

### What still stands between `project_create` and `batch_create` (the gaps)

- G-1, private on the Mac: the Mac runtime serves a private repository only when the owner
  enrolled it (`owner-policy/private-repos.json`, read by the coordinator and by the governance
  ledger, and the Mac `remote.json` `projects`, read once at start). Both are owner trust files;
  the tool does not write them. `owner_steps` gives the one command that re-enrolls from the
  registry and restarts the agent (`deploy/mac/install-runtime-agent.sh ... --from-registry
  --install`); ChatGPT can run it through `operator_run` on the Mac with the owner's approval.
  Proposal T-A3c: the Mac runtime enrolls the repositories `project_create` made itself (append to
  both files, same checks), and re-reads them on change instead of once at start.
- G-2, public on the VPS: the VPS runner's registry, clones and `remote.json` `projects` come from
  lab-infra (`memo_runner_pilot_repos`, `memo_bridge_remote_projects`, identical, max 50), and the
  deployed coordinator's pre-filter reads the `PUBLIC_ALLOWLIST` literal of
  `memolabs-dev/.github scripts/issue_preflight.py`. The App is not installed on
  `guillaume-flambard/lab-infra`, and both changes need a deploy, which waits for the owner's go.
  `owner_steps` gives the exact lines. Proposals: T-A3a, memo-bridge reads `ORG_REPO` from
  issue_preflight.py (pre-filter = registered `memolabs-dev` origins; the Python ledger already
  checks public and not archived through GitHub since .github#61), then the literal goes (owner,
  R-6); T-A3b, the VPS runner learns projects from a runtime-owned list written by a VPS-side
  `project_register` the hub calls after a `host=vps` creation, cloning on demand, with lab-infra
  rendering `remote.json` to include that list once.

### Tests (offline, GitHub stubbed)
`tests/project-create.test.mjs`: owner only (read-only principal, another OIDC sub, hub:readonly
refused and journaled), name validation and reserved names, refused combinations, idempotence (a
second call returns the same project, no second generate call), refusal paths (`repo_exists`,
`visibility_mismatch`, `name_taken`, `path_occupied`, `registry_locked`, `template_unavailable`,
`project_create_mac_only`), registry row inserted once and in order under the lock, never a
DELETE request, App token purposes and the purpose gate. `tests/project-template.test.mjs`:
template files and their agreement with memo-bridge's workflow and the fleet policy.

### Runtime step R-A2 (what the owner does, in this order, after the T-A2 PR merges)

1. Publish the template once, from a memo-bridge checkout at the merged commit, under his own
   `gh` login (it needs the `workflow` scope): `node scripts/project-template.mjs publish`, read
   the plan, then `node scripts/project-template.mjs publish --execute`. Check:
   `gh api repos/memolabs-dev/project-template --jq .is_template` answers `true`.
2. VPS deploy (his go): lab-infra PR pinning `memo_bridge_version` to the merged commit (the hub
   lists `project_create` and routes it to the Mac). No governance pin change, so R-6 is the
   regression check only: `coordinator.test.mjs` with `MEMO_BRIDGE_GOVERNANCE_ROOT` on 8a7f7ba.
   Back up the store and the hub state as in E-08; no store migration in T-A2.
3. Mac runtime at the same commit, with the App key:
   `deploy/mac/install-runtime-agent.sh --owner-sub <sub> --governance-ref <mac governance ref>
   --from-registry --app-key "$HOME/.config/memolabs/secrets/github-app/memo-labs-automation.private-key.pem" --install`.
   The Mac governance ref is **not** the VPS pin of step 2: it must carry `.github#63` (read the
   owner's home from the account, not from `$HOME`), because the ledger child runs with `HOME` set to
   a private gh configuration directory. Passing the VPS pin `8a7f7ba` here refuses every private
   repository with `lease_denied` (incident E-16). Use
   `ff63ce8d43971bdf368892569f35d9f2147f5a4f`, or the `memolabs-dev/.github` main head at the time
   when it is later than that.
4. ChatGPT, Memo Bridge connector, Refresh. "Crée un projet privé <name>" -> `project_create`
   (expected: `repo_created`, `cloned`, `registry_row_added`, `owner_steps: enroll_on_mac`).
5. Enrollment (G-1): the `enroll_on_mac` command it returns, in a terminal or through
   `operator_run` on the Mac with his approval. The agent restarts with the project enrolled.
6. Same conversation or a new one: "crée la tâche : <one small change>" -> `batch_create`, then a
   worker chat ("travaille sur l'issue 1 de <name>") -> claim, Mac worktree, `jobs_submit test`,
   PR -> Mergify merges it (`gh pr view 1 -R memolabs-dev/<name> --json mergedBy`).
7. `project_create` again with the same name: `existing: true`, same `local_path`, no second
   repository (`gh repo list memolabs-dev | grep <name>` one line). AC-A2 passes on 6 and 7.
