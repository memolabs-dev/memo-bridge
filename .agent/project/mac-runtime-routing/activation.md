# Mac runtime activation: state, owner steps, end-to-end proof (issues #110, #114, #147)

Status: READY_FOR_MANUAL_ACCEPTANCE once the three PRs below are green. Nothing is deployed and
the Mac agent is still in probe mode until the owner runs the steps of section 3.

## 1. What makes a private project executable from ChatGPT

```
ChatGPT ── workspace_open(project) ──> hub remote surface (VPS, remote.json mac_runtime_routing)
             no host:  router asks the VPS runtime's projects_list; a row that is metadata_only
                       with source_host mac (known only from the Mac catalog snapshot) goes to
                       the Mac, anything else to the VPS, as before
             host mac: Mac
           ── task_claim / task_next / worktree_create ... with no workspace_id (implicit
              workspaces, #169) ──> same router: the Mac when this conversation already has a
              Mac workspace on the hinted project (args.project, else the Issue's repository),
              or when that project is registered on the Mac only
        ──> hub sendAgent('mac') ──> Mac agent in runtime mode (launchd, owner's account)
             Mac remote policy  ~/.local/share/memo-bridge/owner-policy/remote.json
                                (owner sub, enrolled project names, writes, enforce, routing)
             private enrollment ~/.local/share/memo-bridge/owner-policy/private-repos.json
             registry, origin   ~/memolabs/PROJECTS.md, `git remote get-url origin` of the checkout
             ledger             pinned governance scripts, private_owner_allowlist.py
        <── workspace host mac; the hub keeps workspace, worktree and job ids bound to the Mac
            (workspace_routes.json in the hub state dir), so every later call goes back there
```

Fail-closed paths: Mac offline or connected in probe mode answers `host_offline` (never a VPS
fallback, never a binding); a foreign principal cannot follow a Mac route; a project outside the
Mac policy, a wrong origin, a public or archived repository, a non-owner principal and the VPS
itself never get a private enrollment.

Discovery only places a workspace. Authorization stays on the Mac: registry, Git origin, remote
policy, owner-private file, ledger, claim, worktree and sandboxed jobs.

## 2. Delivered (this change set)

| ID | What | Where | Evidence |
|---|---|---|---|
| T-R1 | host inference for `workspace_open` without host; probe-only Mac answers `host_offline` with a reason | `bridge/workspace-host-router.mjs`, `bridge/remote-surface.mjs` | `tests/workspace-host-router.test.mjs` |
| T-R4 | implicit workspace calls (#169) placed on the Mac for Mac-only projects; the workspace the Mac opens is bound to the owner and the conversation | `bridge/workspace-host-router.mjs` | same file, 12 tests |
| T-R2 | installer: full pinned bundle (`git archive` + `pnpm install --prod`), pinned governance scripts, `push-gh`, multi-repo enrollment from the registry checked against GitHub, Mac remote policy, every variable the runtime and the ledger read in the plist, `--rollback` | `deploy/mac/install-runtime-agent.sh`, `deploy/mac/runtime-mac.mjs` | `tests/runtime-mac-install.test.mjs` (real dry run on macOS) |
| T-R3 | installer bug from #148: the token check `{20,2048}` is refused by macOS `/bin/bash` 3.2 (RE_DUP_MAX 255), so the old script always died there | same | same test |
| T-G1 | governance: `private_owner_allowlist.allowed()` read `Path.home()`, which the ledger child sets to its private gh directory, so every private repository was refused | memolabs-dev/.github#63 | its unit test; R-6 check below |
| T-L1 | hub: `memo_bridge_mac_runtime_routing: true` and a `memo_bridge_version` that carries #117, #146, #148 and T-R1 | lab-infra PR (held for the owner) | lab-infra tests; R-6 check |

Before this change the installer also left the Mac runtime unusable even when run: its plist did
not set `MEMO_BRIDGE_REMOTE_CONFIG`, `MEMO_BRIDGE_OWNER_SUB` or
`MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE` (so the coordinator refused every remote call and every
private repository), wrote no `push-gh`, and pointed launchd at a bundle from 2026-10-13 that has
`bridge/` only (runtime mode imports `server/runtime.mjs`).

Enrollment preview on the owner's Mac (read-only, 2026-10-18): 71 registered projects, 23 private
memolabs-dev repositories enrolled, none skipped: aurago, calendar-prototype,
clinical-data-knowledge-foundation, cra-clock, emargo, gtm, horslot, infrastructure-guardian,
jp-petit-website, kollio-v3, lab-console, lautre-voix, marketplace-kit, medsharing,
memo-founder-skills, merge-gate, mobile-explorer, music-lab, odoo-safety-parts, podintel,
rebuild-radar, reprisette, vulnforge.

## 3. Owner steps (in this order; each one needs the owner's go)

Values: `M` = the memo-bridge merge commit of this change, `G` = the memolabs-dev/.github merge
commit of #63, owner sub `b31f467f-7326-49c7-91f1-3659a177ec9e` (lab-infra
`memo_bridge_remote_owner_sub`).

Mac (installs a persistent launchd agent in the owner's account):

```bash
git -C ~/memolabs/os/core/bridge fetch origin
git -C ~/memolabs/os/core/bridge worktree add ~/memolabs/workspace/worktrees/memo-bridge/mac-runtime-install M
cd ~/memolabs/workspace/worktrees/memo-bridge/mac-runtime-install && pnpm install --frozen-lockfile
deploy/mac/install-runtime-agent.sh --owner-sub b31f467f-7326-49c7-91f1-3659a177ec9e --governance-ref G --from-registry --bridge-ref M
deploy/mac/install-runtime-agent.sh --owner-sub b31f467f-7326-49c7-91f1-3659a177ec9e --governance-ref G --from-registry --bridge-ref M --install
```

The first run stages everything and prints the enrolled list; the second keeps the probe plist,
installs the runtime one and waits for `runtime_ready` in `~/Library/Logs/memo-bridge/stderr.log`.
Rollback: `deploy/mac/install-runtime-agent.sh --rollback`.

VPS (after the lab-infra PR is merged by the owner): `make check`, then `make deploy-memo-bridge`
from a clean lab-infra checkout. Rollback: `memo_bridge_mac_runtime_routing: false` and the previous
`memo_bridge_version`, then the same deploy.

Either side can go first: with routing on and the Mac still in probe mode, a Mac workspace
answers `host_offline` with the reason; with the Mac runtime on and routing off, nothing reaches it.

## 4. End-to-end proof (next step, from a real ChatGPT conversation)

Precondition: one enrolled private repository has Mergify adopted (none has yet; emargo and
clinical-data-knowledge-foundation already have CI), and an Issue there labelled `agent:ready`
and exactly one `priority:*`.

1. Zero ceremony: `task_claim(issue="memolabs-dev/emargo#N")` with no workspace: lease taken
   on the Mac, `implicit_workspace.opened = true` (the ledger accepts the private repo).
2. Explicit variant in a second conversation: `workspace_open(project="emargo")` with no host
   answers `workspace.host = "mac"`, `placement.reason = "project_registered_on_mac_only"`.
3. `worktree_create`: a worktree under `~/memolabs/workspace/worktrees/emargo/` on the Mac.
4. `worktree_write_file`, `jobs_submit test`, `job_results`: the sandboxed job ran on the Mac.
5. `worktree_commit`, `worktree_push`, `github_create_pr`, `task_complete`: PR merged by Mergify.
6. Negative canaries: Mac agent stopped gives `host_offline`; a public project with no host stays
   on the VPS; `workspace_open(project="cuesheet", host="mac")` is refused by the Mac policy.

Record the answers (ids, SHAs, PR link) in `evidence.md`; do not close #114 before that.

## 5. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-M1 | The pin bump carries every memo-bridge commit since 93e3bed (42 on 2026-10-18) | lab-infra PR lists them; R-6 run on the candidate; deploy only on the owner's go |
| R-M2 | Owner's gh token used for ledger and pushes on the Mac | 0600 files under a 0700 dir, never in env or plist; the App replaces it once configured on the Mac |
| R-M3 | Discovery snapshot stale or wrong | it only places the workspace; the Mac authorizes again and refuses what it does not serve |
| R-M4 | Two enrolled projects are registered under a name that is not their repository's (calendar-prototype is acadomia-calendrier, merge-gate is github-merge-gate) | an implicit call hinted only by the Issue goes to the VPS and is refused there; name the project (`project`) or open the workspace first |
