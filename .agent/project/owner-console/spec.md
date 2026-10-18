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

## 04. Work graph

| ID | P | Status | Req | Depends | What |
|---|---|---|---|---|---|
| T-D1 | P0 | DONE | M1 | - | narrow the sensitive set (D-1): memo-bridge#165, cuesheet#85, problem-intelligence-engine#35, uni-protocol#38 merged; memo-bridge#156 (`deploy/` only) then merged by Mergify |
| T-T1 | P0 | DONE | T1 | - | lot 1: 26 repositories transferred, Mac remotes updated (E-01) |
| T-T2 | P1 | TODO | T1 | - | lot 2: VPS-image repositories, one at a time: transfer, CI image name, lab-infra stack image, autodeploy check |
| T-T3 | P1 | TODO | T1 | T-T2 | lot 3: lab-infra |
| T-M1 | P1 | TODO | M1 | T-D1 | adopt Mergify on transferred repositories that have CI (template + canaries) |
| T-M2 | P2 | TODO | M1 | T-M1 | minimal CI for repositories without one, then adopt |
| T-A1 | P0 | IN_PROGRESS (E-02 deployed; E-04 incident, ledger fix memolabs-dev/.github#62 open) | A1 | - | org rule in issue_preflight.py (.github#61); 17 public projects in the VPS runner, registry and remote.json (lab-infra#241, #242), deployed. Still a list in lab-infra: a new public repo needs one line there until T-A2 automates it |
| T-A2 | P0 | TODO | A2 | T-A1 | `project_create`: GitHub App needs Administration write on the org; template repository; registry writer under lock |
| T-H1 | P0 | IN_PROGRESS (other spec) | H1 | - | zero-friction Mac routing (#110, #114, #147, PR #148 held) |

## 05. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | A transfer breaks a deploy silently (GHCR packages stay with the user account) | lot 2 moves stack and CI together and checks autodeploy; lot 1 had no image, Pages or trusted publisher |
| R-2 | The org rule widens what ChatGPT can write | writes still need the OIDC owner, client certificate, claim, worktree, CI and Mergify; archived and foreign repos refused |
| R-3 | `project_create` makes repositories by mistake | idempotent on name, owner principal only, audit journal, delete stays manual |
| R-4 | Open PRs get absorbed by a wider policy | before each policy change, list newly eligible open PRs and hold them (done for #148, #132) |
| R-5 | Shared `PROJECTS.md` written concurrently | one writer path under a lock, never a hand edit |
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
