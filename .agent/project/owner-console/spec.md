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
  private source is copied to the other host.
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
| T-A2 | P0 | TODO | A2 | T-A1 | `project_create`: GitHub App needs Administration write on the org; template repository; registry writer under lock |
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
- U-1: GitHub App permission for repository creation in the org (Administration: write) is not
  granted today; adding it is an owner action in the App settings.
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
