# Dependency install phase for Mac jobs (local executor)

Whole Project Protocol, short form. Branch: memo-bridge `feat/mac-job-install-phase`.
Started 2026-10-18 12:12 CEST. Refs memolabs-dev/memo-bridge#114.

## Intent

Jobs routed to the owner's Mac (owner-console T-H1, E-08 to E-11) run their recipe directly in
the Seatbelt sandbox, which has no network. A fresh worktree has no `node_modules` and no Go
module cache, so `npm test` fails with `ERR_MODULE_NOT_FOUND` and `go test ./...` fails with
`lookup proxy.golang.org: no such host` (live: horslot `job_E5CIx0laJU7K0HGd`). The VPS
executor solved the same problem with two phases (`.agent/project/job-two-phase`): a pinned
install argv with network and scripts off, then the recipe offline. The Mac executor gets the
same two phases, without weakening the sandbox: jobs are code a model can write.

## Requirements and acceptance

| Id | Requirement | Acceptance | Evidence |
|---|---|---|---|
| R1 | Same install decision and argv as the VPS for Node: `pnpm install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts`, only with a lockfile and no `node_modules`; never a shell | `planLocalInstall` uses `detectInstall`; the argv must be in `LOCAL_INSTALL_ARGV`, which contains `INSTALL_ARGV` unchanged | tests/job-install-local.test.mjs "plan" |
| R2 | Go covered by the same pinned-argv model: `go mod download` when the recipe is a Go one, `go.mod` is a regular file and there is no `vendor` entry | `LOCAL_INSTALL_ARGV.go`, skip reasons `no_go_mod`, `vendored` | test "plan"; live Go job below |
| R3 | An argv outside the pinned list is refused before anything runs | status `failed`, summary and event `rejected` `install_not_allowed` | test "plan" (pure), runner refusal test |
| R4 | Install sandbox: outbound TCP/UDP to port 443 only, DNS through mDNSResponder, no loopback, writes to the worktree and the job folder only, the owner's home unreadable except toolchain roots taken from `PATH`, the private-data denylist still applied, the state directory still denied | profile text; Seatbelt probes on macOS: https fetch works, port 80 and loopback 443 refused, `~/x` unreadable, worktree readable, denylisted file unreadable even under a tool root | tests/job-install-local.test.mjs "install profile" |
| R5 | Recipe profile byte-for-byte unchanged | `sandboxProfile({denyReadCount, gitCommon})` equals the text of `origin/main` | test "recipe profile unchanged" |
| R6 | Order: install, then recipe; recipe never runs after a failed, timed-out or cancelled install | events `install_started`, `install_exit`, `started`, `exit`; failed install: status `failed`, `status_reason` `install_failed` / `install_timeout`, exit code of the install | tests "phase order", "failed install", "install timeout", "cancel during install" |
| R7 | Caches per job, nothing shared: corepack, pnpm store, npm cache, XDG folders and `GOMODCACHE` in the job folder, deleted after the job; Go writes its module cache read-write (`-modcacherw`) so it can be deleted | `localPhaseEnvironment` asserts; job folder gone after the job | tests "environment", "phase order" |
| R8 | Recipe phase reads the same caches offline: `COREPACK_ENABLE_NETWORK=0`, `GOPROXY=off`, same `COREPACK_HOME` and `GOMODCACHE`; `GOTOOLCHAIN=local` in both phases; `GOFLAGS` never `-mod=mod` | env asserts | test "environment" |
| R9 | The runtime follows the install like the recipe: cancel, claim loss and runner SIGTERM stop it; the job's pid is the current phase's group; the deadline safety net adds the install bound (600 s, same as the VPS) when an install ran | `leaderStartOf` and `runnerPidOf` read `install_started`; `reconcileLocalJob` deadline | tests "cancel during install", "deadline adds install bound" |
| R10 | Existing local jobs keep their contract | `pnpm test` green, `submitted, started, exit` for a job without install | full suite |
| R11 | Docs say what the install phase can do | SECURITY.md, docs/RUNNER.md, README.md, docs/RUNNER_VPS.md updated, residual risks listed | job-sandbox "finding 4" still green; review |

## Decisions

- D1 Port 443 only in the install phase. Registries (npm, pnpm through corepack, the Go proxy and
  checksum database) are HTTPS. Seatbelt filters remote hosts only as `*` or `localhost`, so
  private LAN addresses on port 443 stay reachable: listed as a residual risk.
- D2 The install phase cannot read the owner's home, unlike the recipe phase. The recipe has no
  network, so whatever it reads can only reach the model through its own log; the install phase
  has the network and may run repository-controlled code (`.pnpmfile.cjs`, `configDependencies`
  in `pnpm-workspace.yaml`: `--ignore-scripts` does not stop them). Reading is limited to
  system paths, the worktree, the job folder and toolchain roots derived from `PATH`.
  A tool root is the parent of a `PATH` folder under home when that parent is at least two
  levels below home (`~/.nvm/versions/node/v24/bin` gives `~/.nvm/versions/node/v24`),
  otherwise the `PATH` folder itself (`~/.local/bin` stays `~/.local/bin`, never `~/.local`).
  The private-data denylist is applied after the tool roots, so a tool root never re-opens it.
- D3 Go module cache in the job folder, not in the worktree. A worktree-local cache would show up
  in `git status` and in `worktree_commit`, and Go makes it read-only, which breaks worktree
  removal. Cost: one download per Go job (the VPS also downloads per job, by choice).
- D4 Go: `GOPROXY=https://proxy.golang.org` (no `direct`), so no VCS tool runs in the install;
  `GOSUMDB` stays the default (sum.golang.org verifies). Private modules are not covered.
- D5 Install bound 600 s (`INSTALL_TIMEOUT_MS`, equal to the VPS `INSTALL_TIMEOUT_SECONDS`); the
  recipe keeps the job's whole timeout from its own start, as on the VPS.
- D6 `MEMO_BRIDGE_JOB_SANDBOX=off` runs the install unsandboxed too (owner-equivalent, as before).

## Work graph

| Id | Pri | Task | Depends | State |
|---|---|---|---|---|
| T1 | P0 | recipes.mjs: `LOCAL_INSTALL_ARGV`, `detectGoInstall`, `detectLocalInstall`, `planLocalInstall` | | see state.json |
| T2 | P0 | sandbox.mjs: install profile, `toolRoots`, `HOME` and `MDNS_SOCKET` params, `localPhaseEnvironment` | | |
| T3 | P0 | job-runner.mjs: two phases in `execute`, outcomes, events | T1 T2 | |
| T4 | P0 | executor-local.mjs: leader and runner pid from `install_started`, deadline adds install bound | T3 | |
| T5 | P0 | tests/job-install-local.test.mjs | T1-T4 | |
| T6 | P1 | docs: SECURITY.md, docs/RUNNER.md, README.md, docs/RUNNER_VPS.md, recipes.mjs/sandbox.mjs headers | T3 | |
| T7 | P1 | live check on this Mac: real `npm ci`, `pnpm install` through corepack, `go mod download` in the install profile, then the recipe offline | T3 | |
| T8 | P1 | PR, Refs #114 | T5 T6 | |
| T9 | ext | owner reinstalls the runtime (`deploy/mac/install-runtime-agent.sh`), ChatGPT test job on a Mac-only project with dependencies | T8 merged | owner |

## Risks

- Medium: the install phase reaches any host on port 443, LAN included (D1).
- Medium: repository-controlled package-manager configuration runs with the network
  (`.npmrc` registry, lockfile `resolved` URLs, `.pnpmfile.cjs`), same as the VPS. Bounded by D2:
  it cannot read the owner's files, only the worktree (already on GitHub), toolchains and system files.
- Low: tool roots from `PATH` expose the toolchain folders (no secrets expected; the denylist still wins).
- Low: a `PATH` without the package manager (the runtime agent's plist puts the node folder,
  which holds corepack's `pnpm` shim, and Homebrew first) fails the install with `spawn_failed`.
