# System map

MCP client --stdio--> server/index.mjs (McpServer, SDK v2.3.1)
  -> server/probe.mjs (hosts, read-only)
  -> server/catalog.mjs (PROJECTS.md, read-only) <-- reused by coordinator for project ids + repo paths
  -> server/tools/coordinator-tools.mjs (NEW, shared registry; hub will reuse)
       -> server/coordinator/index.mjs (NEW, operations + audit)
            -> policy.mjs (authorize principal/op)
            -> leases.mjs (claim/renew/release/fence, generation token)
            -> checkpoints.mjs (git cat-file / merge-base --is-ancestor, read-only)
            -> store.mjs (only engine-aware module; node:sqlite WAL, BEGIN IMMEDIATE)
                 -> <state dir>/coordinator.sqlite (private)

One stdio process per client session; all processes on the Mac share one SQLite file.
Hub (PR #5, bridge/hub.mjs makeMcp) is NOT on main yet; it will call
registerCoordinatorTools with an OIDC-derived principal.
Build: esbuild bundles server/index.mjs -> plugin/server/dist/index.mjs (node built-ins external).
CI: ubuntu-latest Node 24: npm ci, npm test, npm run build, npm run smoke.
