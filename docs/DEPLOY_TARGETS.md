# Deploy targets: where a merged commit goes, read from what deploys it

Autoloop T-D1 (`.agent/project/autoloop/spec.md`, REQ-D01), Issue #149. Measured 2026-10-17.

## Decision: derived, not declared

REQ-D01 asked for a deploy-target column in `PROJECTS.md` or the Memo Bridge catalog. Neither is
done, on purpose:

- The truth already exists where the deploy happens. For `vps-image`, it is the compose files under
  `/opt/stacks` on the VPS: autodeploy (lab-infra `ansible/roles/autodeploy/files/autodeploy`)
  redeploys any stack whose image starts with `ghcr.io/guillaume-flambard/`, `ghcr.io/memolabs-dev/`
  or `127.0.0.1:5000/`. A column would be a second copy of that, and it would drift.
- `PROJECTS.md` is read by at least eight tools (`proj`, `projects-lint`, `gitsync`, `wtree`,
  `cue`, `portfolio-owners`, the Memo Bridge catalog, cuesheet's frontier adapter) and written by
  several sessions with no lock. A new column is a change to all of them at once.

So the deploy receipt (T-D2) derives the target at run time from those sources, and this page is a
dated snapshot of what the derivation gives, for planning only.

| Target | Source of truth | How to read it |
|---|---|---|
| `vps-image` | `/opt/stacks/*/docker-compose.y*ml` on the VPS, own image prefixes | `ssh lab` then `grep -E '^\s*image:'` in each compose file; `autodeploy --status` |
| `vps-stack` | lab-infra `stacks/` on `main` | `make deploy-stack` from the Mac (manual today, T-D3) |
| `vps-role` | lab-infra `ansible/` (memo-bridge pinned SHA) | manual bump today (T-D4) |
| `mac-runtime` | memo-bridge `install-local` on the Mac | manual today (T-D5) |
| `release` | a `release.yml` workflow in the repository | `gh api repos/<r>/actions/workflows` |
| `none` | none of the above | |

## Snapshot of 2026-10-17

`vps-image`, from the VPS compose files (read-only), matched to `PROJECTS.md` by name:

| Stack | Image | Registry project | GitHub origin | Merge engine |
|---|---|---|---|---|
| drop | `ghcr.io/memolabs-dev/drop` | drop | memolabs-dev/drop | GitHub merge queue (not adopted, U-03) |
| emargo | `127.0.0.1:5000/emargo` | emargo | memolabs-dev/emargo (private) | `auto-merge.yml` (U-02). Stack currently **held** (`/var/lib/autodeploy/emargo.hold`) |
| factura | `127.0.0.1:5000/factura` | factura | guillaume-flambard/factura | personal (U-01) |
| foldready | `ghcr.io/guillaume-flambard/foldready` | foldready | guillaume-flambard/foldready | personal (U-01) |
| kollio | `127.0.0.1:5000/kollio-{api,web,worker,litellm}` | kollio-web, probably (parked; Docker stack) | guillaume-flambard/kollio | personal (U-01) |
| lab-hub | `ghcr.io/memolabs-dev/lab-hub` | lab-hub-public | memolabs-dev/lab-hub | none; no PR has ever been opened |
| paykit | `ghcr.io/guillaume-flambard/paykit` | paykit | guillaume-flambard/paykit | personal (U-01) |
| relay-api | `127.0.0.1:5000/relay-api` | relay | guillaume-flambard/relay | personal (U-01) |
| usine | `127.0.0.1:5000/usine` | usine | guillaume-flambard/usine | personal (U-01) |
| veilleur | `127.0.0.1:5000/veilleur` | veilleur | guillaume-flambard/veilleur | personal (U-01) |
| world-lab | `ghcr.io/guillaume-flambard/world-lab` | world-lab | guillaume-flambard/world-lab | personal (U-01) |
| fluxa, knockport, memo-ui, opendots, plm, portfolio, triagepath, weave-api, weave-web | own images | **not in `PROJECTS.md`** | | |

Repositories adopted by the Mergify policy (memo-bridge, cuesheet, problem-intelligence-engine,
uni-protocol):

| Repository | Target |
|---|---|
| memo-bridge | `vps-role` (pinned SHA in lab-infra) and `mac-runtime`; both manual |
| cuesheet | `none` (only `ci.yml`) |
| problem-intelligence-engine | `none` (only `ci.yml`) |
| uni-protocol | `release` (`release.yml`, on tags) |

## What this means for the loop

No adopted repository deploys an image on merge. The completion sentence of the autoloop spec
needs one that does, so T-D2's canary depends on an owner decision first:

- **lab-hub-public** (memolabs-dev/lab-hub) is public, in the org where Mergify is installed, and
  its image is autodeployed. It is the publish target of the private site, so a PR there has to be
  the way changes reach it, not a fork of the private source.
- **drop** after U-03.
- **emargo** after U-02, once its hold is lifted.
- the personal repositories after U-01.

Also found: nine running images have no row in `PROJECTS.md`.
