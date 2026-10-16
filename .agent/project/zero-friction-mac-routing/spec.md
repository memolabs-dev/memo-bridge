# Zero-friction Mac project execution (P0, issue #110)

CDKF exposes the current gap: a Mac source is visible through metadata-only discovery, but a remote ChatGPT workspace is hard-gated to VPS. The snapshot must **never** authorize execution by itself.

## Intended invariant
1. An authenticated Mac operator reads its canonical PROJECTS.md and resolves a stable project ID to a **Mac-local checkout**.
2. The coordinator checks that the project is in the owner's allowed project set, the Git remote matches the registered repo and the chosen host is **mac**.
3. Only then may a workspace be created for the Mac host, followed by a lease, worktree and sandboxed job bound to that same host.
4. On host disconnect, fail with `host_offline` before creating a workspace or reservation; retry is idempotent.
5. Never transfer sources, corpus, absolute paths, keys or Vault notes into the discovery snapshot.
6. Never auto-promote `metadata_only` into `available`. Host attestation and authorization are separate.

`server/project-host-route.mjs` is a pure fail-closed policy primitive for the next integration step. It is **not wired into workspace_open yet**. Do not advertise CDKF as executable until end-to-end tests on Mac demonstrate it.

## Acceptance
`projects_list` -> verified Mac checkout -> `workspace_open` -> issue lease -> Mac worktree -> test job, plus denial on wrong host, missing authorization and host offline.
