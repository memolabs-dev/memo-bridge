# Mac runtime: explicit public project enrollment

Issue: [memo-bridge#114](https://github.com/memolabs-dev/memo-bridge/issues/114).
First consumer: [drop#118](https://github.com/memolabs-dev/drop/issues/118).

## Why

The Mac runtime installer historically enrolled only `private=true` GitHub repositories.
Its generated `owner-policy/remote.json` therefore omitted public projects even when the
VPS remote allowlist included them and the Mac held a valid local checkout.
A remote `workspace_open(project="drop", host="mac")` then failed closed with
`project_not_allowed`.

## Policy after this change

- `--from-registry` continues to select **private** repositories only.
- `--repo memolabs-dev/drop` is an **explicit owner opt-in**, not an automatic discovery grant.
- Both forms require a registered, available Mac checkout whose Git origin matches
  `memolabs-dev/<name>`, plus a GitHub API verification that the repository is not archived.
- Private repositories enter `owner-policy/private-repos.json`; public ones do **not**.
- Both approved project names enter the Mac `owner-policy/remote.json`.
- The VPS allowlist, session ownership, GitHub ledger/preflight and per-task leases still
  independently enforce their authorization policies. No permission is inferred from a
  metadata-only snapshot.

## Activation (only after review and merge)

From the trusted **Mac** checkout at the reviewed commit, with the verified
Pocket ID owner-sub, reviewed governance commit and appropriate local credentials:

```bash
deploy/mac/install-runtime-agent.sh \
  --owner-sub <pocket-id-uuid> \
  --governance-ref <reviewed-governance-commit> \
  --from-registry --repo memolabs-dev/drop --install
```

This command intentionally retains the existing private registry enrollment while adding
exactly one public repository. Keep any already-approved optional installer flags (such as
`--app-key`) when redeploying, otherwise that credential is removed by the installer.
Do not paste credentials or private policy file contents into a chat or CI log.

After the runtime reports `runtime_ready`, verify an actual
`workspace_open(project="drop", host="mac")`, a Drop-owned Issue claim and isolated
worktree. Check wrong-owner/wrong-host and non-enrolled public repository denial.

**Rollback**: restore the previously staged/probe LaunchAgent using
`deploy/mac/install-runtime-agent.sh --rollback` if runtime activation fails. For a
policy-only rollback, redeploy the previously reviewed runtime and enrollment set. Do not
manually edit the protected 0600 owner policy files.

No production deployment or Mac end-to-end acceptance is implied by passing unit tests.
