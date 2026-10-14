# First implementation cycle — Canonical project catalogue

Memo Bridge remains **read-only** and runs locally via stdio. The new MCP tools are:

- `projects_list` — search the canonical `~/projects/PROJECTS.md` register (not the Atlas snapshot).
- `project_info` — read registered metadata, including validated local path.
- `project_git_status` — bounded live Git branch/change/worktree counts for one registered repository.
- `projects_audit` — identify candidates absent from the canonical register using inventory and Memo Labs links, without granting them access.

All names are validated against a conservative identifier pattern. No user-selected file paths, arbitrary shell commands, service controls, or privileged operations are exposed. Registry paths must resolve inside `~/projects/`; symlink escapes are rejected. Git uses fixed arguments and no shell.

This is a foundation for coordination, **not yet** a shared coordinator, VPS runner, remote HTTPS MCP, or a replacement for Sentinel X. A later cycle will implement the durable task state and multi-client locking on the authenticated service.

The canonical `PROJECTS.md` is preserved. The `~/memolabs/workspace/atlas` information remains a derived knowledge layer.

Run: `pnpm test && pnpm run build && pnpm run smoke`.

CI smoke uses a temporary Git repository and operator-controlled MEMO_BRIDGE_PROJECTS_ROOT environment variable, so the owner's local home directory is not required. This variable is set at process start, never by an MCP tool caller.
