# Security policy

Memo Bridge is a local proof of concept. It is not designed for exposure to the public internet.
- No merges and no deployment. The development tools run no admin operations; the operator tools of Phase 6 do, by design and under their own rules (section "Operator access" below, `docs/OPERATOR.md`). Since v0.4 the runner writes files, commits and pushes through its tools, only inside its own worktrees and under a live task claim, and runs the repository's own test/build/lint scripts as jobs inside a macOS sandbox (see below: a job is code a model can write, and the sandbox is what bounds it).
- Project metadata is read only from the local canonical register; project IDs and resolved paths are validated.
- The local stdio plugin assumes a trusted OS user. These tools must not be exposed publicly until strong user authentication, per-tool authorization and audit logs are implemented. Since v0.5 they can be reached on the VPS through the loopback-only private hub (owner and read-only bearers, write tools gated, see below).
- No credentials in the repository, logs, test fixtures, or plugin archive.
- VPS access uses the operator's existing SSH alias and host-key trust; do not distribute SSH keys.
- Report vulnerabilities privately to the maintainers before publishing exploit details.
- Future remote deployment requires OAuth 2.1, explicit per-host authorization, audit logs, TLS, and rate limiting.

## Coordinator writes (v0.3)

Up to v0.3, the Coordinator (`docs/COORDINATOR.md`) was the only component that wrote. The owner approved this on 2026-10-13. It writes in exactly two places:

- **Its private SQLite store.** A 0700 directory and a 0600 file. Opening is refused for relative paths, Git repositories (bare ones included), iCloud (`Mobile Documents`), `~/Library/CloudStorage`, and any existing directory readable by others. A folder that a third-party tool syncs silently cannot be detected, so do not point `MEMO_BRIDGE_STATE_DIR` there.
- **Lease refs in `memolabs-dev/.github`** (`refs/heads/star-lease-v1/*`). They are written only by running the canonical `scripts/issue_lease.py`, with fixed arguments and no shell, under the operator's `gh` login.
  - The ledger stores no Issue titles or bodies, only a digest.
  - It never closes Issues and never deploys.

Further rules:
- **Identity.** The principal is derived by the server (`local:<OS user>` over stdio), and the ledger worker is derived from the workspace. Neither ever comes from tool arguments. Every operation requires a capability. Authorization runs before validation, so every refusal is journaled.
- **Checkpoints.** They use fixed, read-only `git` invocations: no fetch, no push.
- **Audit journal.** It holds identifiers, operation names and result codes, never tool payloads or secrets.
- **No remote exposure.** These tools are not on the hub. Exposing them requires the OIDC validation of `bridge/oidc.mjs`, a capability mapping per scope, and isolation of the root CI runners on the VPS.

## Runner writes and execution (v0.4)

Phase 3 adds a Mac runner (`docs/RUNNER.md`). It runs over the local stdio transport only and is not on the hub. It brings three new capabilities, separate from `coordinator:*` so a future remote principal can be granted reading without them:

| Capability | Allows | Tools |
|---|---|---|
| `repo:write` | Create a worktree of a registered repository on a new branch; write files inside it; commit under the owner's own Git identity; push that branch to origin; remove a clean, pushed worktree. | `worktree_create`, `worktree_write_file`, `worktree_commit`, `worktree_push`, `worktree_remove` |
| `runner:execute` | Run the `test`, `build` or `lint` recipe the repository itself declares, in one of its worktrees; cancel such a job. | `jobs_submit`, `job_cancel` |
| `github:write` | Open a pull request from a pushed worktree branch. | `github_create_pr` |

The local owner principal (`local:<OS user>`) holds all of them. Reads of worktrees, files, jobs, hosts, GitHub and the journal need `coordinator:read`.

What the file and Git tools never do (these guarantees hold for the tools themselves; jobs are covered below):
- **No shell.** (Development tools. The operator tools differ: `operator_run` takes an argv and never a shell line, and only `operator_script` at T3 runs a shell, through a root helper, see below.) Every process Memo Bridge starts is started with `execFile`/`spawn` and a fixed argument array. The model chooses a recipe name, never a command; the command comes from the repository's manifests (`server/runners/recipes.mjs`).
- **No merge, no deployment, no service change.** Pull requests are opened, never merged and never set to auto-merge; the landing contract of `memolabs-dev/.github` lands them.
- **No write to a default branch, no force-push.** `main`, `master`, the local `origin/HEAD` and the remote's own default branch (read with `git ls-remote --symref` before creating and before pushing) are refused, all compared without case: on APFS `refs/heads/Main` is the file `refs/heads/main`. A new branch may not match any local or remote branch without case either. A push uses an explicit refspec without `+`, and only creates the remote branch or moves it from a commit this worktree pushed itself (`push_rejected` otherwise).
- **No file access outside the worktrees.** Paths are relative, normalized and checked after `realpath`; `..`, absolute paths, `.git` and symlink escapes are refused, and reads never block on a FIFO. Before any Git command, the worktree's `.git` link must still point at the project's repository (`worktree_link_changed`). Filesystem paths are never returned to models.

Controls:
- **Claim gate.** Every repository write, job and pull request needs a live claim on the worktree's Issue in the local mirror. Commit, push, pull request creation and job submission also re-verify worker, claim and fence with the shared ledger immediately before acting, and refuse on any failure. Jobs are tied to the claim: `task_release`, `task_complete` and `workspace_close` cancel them, and the runner stops a job by itself within seconds once its claim expired or its workspace or worktree is gone. `worktree_remove` is refused while a job runs in the worktree.
- **Git hooks are disabled** on every Git call (`core.hooksPath=/dev/null`, `core.fsmonitor=false`). A hook path can point at a folder the model writes to, so running hooks would be arbitrary execution. The owner's own hooks are skipped too; CI is the gate.
- **Commit messages** with control or bidi characters, or with any AI attribution (a trailer such as `Co-authored-by`/`Assisted-by` naming an assistant, or prose such as "Written by Claude", "Made with Claude Code", "AI-generated"), are refused.
- **Removal keeps data.** `worktree_remove` is refused with uncommitted, untracked or unpushed work, and lists ignored files (`.env`, `node_modules`, build output) instead of deleting them unless the caller passes `discard_ignored: true`.
- **Bounds.** File reads 256 KiB per call, writes 512 KiB, diffs 200 KiB, job logs 5 MiB, job results 64 KiB, at most `MEMO_BRIDGE_MAX_JOBS` (default 2) jobs per host, job timeout at most 60 minutes. Text returned to models has control and bidi characters stripped or replaced.
- **Audit.** Every write and job submission journals its outcome (ok, denied, error) with workspace and Issue ids; every refusal is journaled.

### Jobs: the sandbox

A recipe runs the repository's own scripts, and a model can write those scripts with `worktree_write_file`. Combined, `runner:execute` and `repo:write` mean running code a model wrote. On macOS every job therefore runs inside a Seatbelt profile (`/usr/bin/sandbox-exec`, `server/runners/sandbox.mjs`):

- **Writes** only to the worktree (never its `.git` link) and to a private per-job folder that is its `HOME` and `TMPDIR` and is deleted afterwards. The repository's `.git`, other worktrees, the state directory and everything else are read-only or unreadable.
- **No reading** of the contents of the private state directory (store, journal, job logs), other worktrees and the other repositories next to the project, `~/.agent`, `~/Vault` (and its iCloud target), iCloud and cloud storage, `~/Documents`, `~/Desktop`, `~/Downloads`, and credential stores: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.git-credentials`, `~/.gitconfig`, `~/.npmrc`, `~/.claude`, `~/.codex`, `~/Library/Keychains`, `~/Library/Application Support` and other app data. File metadata stays readable, because toolchains resolve paths through those folders.
- **Network**: loopback only (tests may start local servers); no remote address, no DNS.
- **Nothing started outside the sandbox**: no launchd jobs, no Launch Services (`open`), no Apple Events; no keychain service and no pasteboard.
- **Environment**: an allow-list (`PATH`, locale, terminal, user, toolchain locations). Every other variable is dropped, including secrets whose names do not look secret, such as `DATABASE_URL`. Git runs without the owner's global and system configuration, so no credential helper and no identity.
- **Lifetime**: the runner follows every process the job starts, including ones that leave its process group, and stops them on cancel, timeout, claim loss and when the job ends. It handles `SIGTERM` by stopping the job first. A job past its timeout plus 35 seconds is killed by the next read even if the runner died. Signals sent from outside the runner check the group leader's start time, so a reused process group id is never signalled.

There is no sandbox on Linux yet: jobs are refused there (`sandbox_unavailable`). **`MEMO_BRIDGE_JOB_SANDBOX=off`** runs jobs without the sandbox, on any platform. That is the owner's explicit choice, and a job is then **owner-equivalent**: it can do anything the owner's OS user can do, including pushing with the owner's credentials. Grant `runner:execute` with that switch only to principals you would let run code as yourself.

Residual risks, with the sandbox on:
- Process tracking polls `ps` every 250 ms. A process that leaves the job's group and whose parent exits between two polls can survive the job. It stays inside the sandbox (no network, no writes outside the worktree, no private data), but it no longer counts against `MEMO_BRIDGE_MAX_JOBS`.
- A job can read what the sandbox does not list: system files, toolchains, and the owner's other files under the home folder that are not in the list above. It can only show them to the model through its own log, which goes back to the session that submitted it.
- A job can modify anything inside its worktree, including files a later commit picks up; `worktree_status` reports edits Memo Bridge did not make (`external_edits`).
- Seatbelt (`sandbox-exec`) is deprecated by Apple, though present and working on macOS 27.
- File writes check the claim in the local mirror only (the mirror expires with the lease); commit, push, pull request creation and job submission ask the ledger.

Before any remote exposure, jobs need stronger isolation (a dedicated user or a VM), and the root CI runners on the VPS must be isolated first. Phase 4 provides the dedicated user on the VPS (below); the Mac keeps the Seatbelt sandbox and the local stdio transport.

## VPS runner (v0.5, Phase 4)

Details: `docs/RUNNER_VPS.md`, `docs/HUB_SECURITY.md`, `deploy/README.md`. Not deployed yet.

- **Three identities.** `memo-bridge` runs only the hub and holds no GitHub token. `memo-runner` runs the runtime (store, ledger, Git network calls) and holds the agent key and the two GitHub tokens, through systemd `LoadCredential=` only. `memo-job` runs recipe code and holds nothing. None is in `docker` or `sudo`.
- **GitHub write credentials come from the GitHub App `memo-labs-automation`**, never from an environment file, a log or `/etc/github.env`. The App's private key reaches the runner only as the `app-key` systemd credential (`LoadCredential=`, from the owner's Mac at deploy time, never in Git). The runtime (`server/integrations/github-app.mjs`) signs a short RS256 JWT (9 minutes) and mints installation tokens valid one hour, each narrowed to one repository and the minimal permissions: `contents: write` on `memolabs-dev/.github` for the ledger, `contents: write` on the worktree's origin for Git, plus `pull_requests: write` for `github_create_pr`. A token is refused unless GitHub confirms exactly that scope, is cached in memory until 5 minutes before expiry, and is never logged, journaled or returned: errors are short codes. The ledger token is handed only to the `issue_lease.py` child as `GH_TOKEN`, with a fresh private `GH_CONFIG_DIR`; the pull request token only to each gh child of that flow, the same way; the Git token reaches Git only through `GIT_ASKPASS`, from a per-call file (0600, in a 0700 state directory) removed after the operation's network calls, with every other credential helper switched off. Other credential variables are stripped from those children, `process.env` never holds a token, and no Git call sees `CREDENTIALS_DIRECTORY` or a token variable.
- **Fallback fine-grained tokens**, optional: `ledger-gh` (Contents RW on `memolabs-dev/.github`) and `push-gh` (Contents RW on the pilot repositories) are used the same way when the App is not configured or a mint fails (`app_token_fallback` in the journal). The runner refuses to start without either a usable App or `ledger-gh`. A missing credential fails closed (`ledger_unavailable`, `credential_unavailable`): there is no fallback to an ambient login.
- **Jobs as a systemd unit.** Only a root dispatcher starts or stops `memo-job@<id>.service`, after re-validating the spool request (dispatch id, strict schema, recipe allow-list, worktree path without symlink, at most one active job); unit properties come only from root-owned files. The unit runs as `memo-job` in `memo-dev.slice` with hard CPU, memory, task and duration caps, no credentials, no capability, the docker sockets, production data, runner state and credential stores inaccessible, loopback and private ranges denied, and only its worktree and output folder writable. Inside it the runner re-checks the instance, the working directory and the recipe, and runs only an allow-listed argv shape.
- **Status from systemd.** The final status is written by root from systemd's own result (`ExecStopPost=+`); job output can never set it.
- **Authorization in depth.** Hub bearer to principal, hub capability check, runtime grant ceiling and `authorize()` again, dispatcher validation. A read-only principal can read status but not submit, cancel, claim or push. Every refusal is journaled with principal, op and reason, never arguments.
- **Write gate.** Mutating ops are not forwarded by the hub until the root CI runners on the VPS are isolated (AC-P4-14). The runner is ready for them and authorizes every op again.

Residual risks on the VPS:
- A job can read other jobs' worktrees (shared group), but write only its own.
- A job has outbound internet (registries, GitHub) and could send out source code of an owner-controlled pilot repository; it holds no secret to send.
- Root agents on the VPS (opencode, claude remote control) can read `/etc/credstore`; token scope and expiry bound the damage (owner decision O-D7).
- The systemd semantics this relies on are read from the systemd 257 man pages and still to be exercised on the VPS (`docs/RUNNER_VPS.md`, "Still to verify").

## Remote surface for ChatGPT (v0.6, Phase 5)

Details: `docs/REMOTE_CHATGPT.md`, `docs/HUB_SECURITY.md`, `docs/OIDC_RESOURCE.md`. Not deployed yet.

On 2026-10-14 a ChatGPT Chat conversation on the owner's Plus account called a remote write tool without asking for confirmation (EV-P5-01). Every rule below is therefore enforced by the server; annotations and tool descriptions only inform the model.

- **One public endpoint, OAuth only.** `https://bridge.memolabs.dev/mcp`, through Traefik with mTLS to the OpenAI Connectors CA, to a separate hub listener on 127.0.0.1:9445 that accepts only Pocket ID access tokens (`typ: at+jwt`, exact issuer and audience, the owner's `sub`, an allowlisted `client_id`, bounded age). The static bearer, `/agent` and `/health` are not reachable from it.
- **Write gate in three layers.** Write tools are not listed while `remote_writes` is disabled; with writes enabled the hub refuses to start while a GitHub Actions runner runs as root; the runner grants the remote owner from the same `remote.json` and strips write capabilities while that file does not enable writes.
- **Invariants on every remote write.** Project allowlist; no write to `.github/workflows`, `.github/actions` or `.github/dependabot.yml` (also refused in commits and anywhere in pushed history, for every caller); push only the workspace branch, never with force, never the default branch; pull requests only on a head the workspace pushed; no merge tool; Mac workspaces refused.
- **Bounded and journaled.** Results at most 24 KiB (`result_too_large`, never cut), remote writes at most 96 KiB, request bodies at most 128 KiB, per-class rate limits and a 401 bucket per client address. One journal line per call and a runtime event sharing its `request_id`; neither holds arguments, tokens or file contents.

Residual risks:
- Tool results (code, Issues, logs of the allowlisted projects) go to OpenAI by design (R-P5-09).
- The mTLS certificate identifies OpenAI, not the owner: another ChatGPT user can reach the listener and is refused by the token checks (R-P5-05). Such a user, sharing OpenAI's egress addresses, can also spend the 401 bucket of those addresses and briefly lock the owner out; the bucket only counts invalid tokens.
- A prompt injection in an Issue or a file can steer a conversation within the write invariants above (for example a bad commit on the workspace branch). Pull requests still land only through the merge contract and human review for workflow and infrastructure changes.
- The Pocket ID token claims, ChatGPT's client certificate, `Origin` and timeout behaviour are documented or inferred, not yet observed (`docs/REMOTE_CHATGPT.md`, "Not verified yet").

## Operator access (Phase 6)

Details: `docs/OPERATOR.md`, spec `.agent/project/phase-6/spec.md`. The owner asked to read,
write and run commands on the Mac and the VPS from ChatGPT, root included on the VPS. These
tools are the exception to "no admin operations" above, and these rules bound them:

- **Separate tiers and scopes.** `operator:read` (T0), `operator:write` (T1), `operator:exec`
  (T2), `operator:root` (T3: lab, and the Mac once its root helper is installed). Opt-in: absent from the default remote ceiling, write
  tiers listed only with remote writes enabled.
- **Signed requests, local policy.** The hub signs every operator call (Ed25519 over op, host,
  tier, arguments hash, expiry, nonce, principal, approval). Each host agent, and the root
  helper on each host, checks the signature and then its own policy file (root-owned on lab,
  read-only on the Mac); the hub never sends policy.
- **No shell below T3.** `operator_run` spawns an argv. On lab, root runs only in transient
  `systemd-run` units started by a root helper with time, memory and task limits.
- **Secrets.** A denylist on read, list, search and write paths (keys, `.env`, credential
  stores, keychains, browser profiles, the agents' own configuration) and a token redactor on
  every output; content comes back marked untrusted.
- **Owner approval** in `dangerous` mode for scripts, destructive commands, shells and wrappers,
  sensitive paths and the agents' control files, bound to the exact arguments, through Telegram,
  fail closed without the bot.
- **Kill switch** from the phone (`/freeze`), FROZEN files on the hub and each host, key
  removal, auto-freeze on refusal bursts, rate limits per tier.
- **Journals.** The hub journals every call with redacted arguments and hashes; each host keeps
  a hash-chained journal (on lab written by the root helper, which `memo-operator` cannot
  rewrite), whose head the hub anchors every 15 minutes. The Mac root helper keeps its own
  root-owned chain, `/var/log/memo-operator/audit.jsonl`, for root calls.
- **Mac root** runs only through the LaunchDaemon `dev.memolabs.memo-operator-root`, from a
  root-owned copy of the code, node, policy and hub key under
  `/Library/Application Support/MemoBridge/operator-root`, never from the home folder; its socket
  is owned by `memo`, 0600; each call runs in its own process group, killed at the timeout, with a
  system-only `PATH`. No memory limit exists on macOS for it.

Residual risks, accepted by the owner:
- A root compromise of lab holds the hub signing key, hence everything the Mac policy allows,
  as the user `memo`, and as root once the Mac root helper is installed (owner decision 2026-10-14).
- T2 on the Mac is the owner's user: a command can do what `memo` can do; the read-only policy
  stops the agent's own write tools, not a command.
- An argv classifier does not see everything a program does; a prompt injection can still run
  a call that is not on the dangerous list.
