# First implementation cycle — Canonical project catalogue

Memo Bridge remains **read-only** and runs locally via stdio. The new MCP tools are:

- `projects_list` — search the canonical `$MEMOLABS_ROOT/PROJECTS.md` register (default `~/memolabs`) (not the Atlas snapshot).
- `project_info` — read registered metadata, including validated local path.
- `project_git_status` — bounded live Git branch/change/worktree counts for one registered repository.
- `projects_audit` — identify candidates absent from the canonical register using inventory and Memo Labs links, without granting them access.

All names are validated against a conservative identifier pattern. No user-selected file paths, arbitrary shell commands, service controls, or privileged operations are exposed. Registry paths must resolve inside the registry root (`MEMOLABS_ROOT`, or `MEMO_BRIDGE_PROJECTS_ROOT` on a host with its own layout); symlink escapes are rejected. Git uses fixed arguments and no shell.

This is a foundation for coordination, **not yet** a shared coordinator, VPS runner, remote HTTPS MCP, or a replacement for Sentinel X. A later cycle will implement the durable task state and multi-client locking on the authenticated service.

The canonical `PROJECTS.md` is preserved. The `~/memolabs/workspace/atlas` information remains a derived knowledge layer.

Run: `pnpm test && pnpm run build && pnpm run smoke`.

CI smoke uses a temporary Git repository and operator-controlled MEMO_BRIDGE_PROJECTS_ROOT environment variable, so the owner's local home directory is not required. This variable is set at process start, never by an MCP tool caller.

## Project Registry v2 — metadata-only Mac snapshot (pilot, 2026-10-16)

**Scope of this PR:** offline catalogue discovery only. The three existing VPS checkouts and
the Mac's canonical `$MEMOLABS_ROOT/PROJECTS.md` remain unchanged. No deployment or
automatic Mac → VPS transfer is included.

On the **Mac**, generate a private, path-free snapshot:

```sh
node scripts/export-project-catalog.mjs
```

It writes `$MEMOLABS_ROOT/workspace/data/memo-project-catalog.json` (mode 0600)
atomically. It includes exactly `name`, `kind`, `status`, `nature`, `stack` per
project, the schema/version and the timestamp. It does **not** include Git remotes,
absolute or relative paths, source code, availability, Vault notes or credentials.
Transfer the file to a private VPS path using an owner-authenticated mechanism
(e.g. the separate Memo Bridge operator transfer capability) after checking its
destination permissions. There is **no public catalogue upload endpoint**.

On the **VPS**, an operator may configure both environment variables and restart
the isolated runtime under the existing deployment/approval policy:

- `MEMO_BRIDGE_CATALOG_SNAPSHOT=/absolute/private/catalog.json` enables import
  into **projects_list only**; if missing/invalid, the local catalogue remains intact,
  and `snapshot.error=snapshot_unavailable` is reported.
- `MEMO_BRIDGE_CATALOG_DISCOVERY=enabled` explicitly allows the configured
  OIDC **owner only** to see snapshot-only names in `projects_list`.
  Without this opt-in, existing remote allowlist filtering is preserved.
  Other remote users are still limited to the configured project allowlist.

Snapshot rows not present in the local registry carry
`metadata_only=true`, `source_host=mac`, `available=false`, and
`catalog_stale` (true when older than 24 hours). The response also provides
`snapshot.generated_at` and `snapshot.stale`. These flags are informational:
offline/stale metadata is never evidence that code or a runner is available.

**Security boundary:** `readProjectRegistry`, `projectInfo`, the coordinator's
`catalogResolver`/`catalogRepos`, remote project allowlists, GitHub lease
preflight, claims, worktrees and jobs never consume the snapshot. A newly visible
project therefore cannot run a task until it is separately registered locally
and approved in the coordinator and remote allowlists.

**Operational follow-up:** automate the authenticated and atomic transfer (or
scheduled sync) separately, with observability, retention, backups and conflict
handling. Confirm the register's aliases independently (e.g. `uni` vs
`uni-protocol`) instead of silently merging identities.

**Rollback:** unset the two variables or remove the snapshot; live project
resolution and existing 3-runner-project semantics are unchanged.
