# Owner scope: every owner project for the owner's principals (#257)

Owner decision of 2026-10-22: the owner reaches every project he owns through Memo Bridge, public
and private, from his remote connector and from his own local session. This page says who that
is, what "every project" means, and what stays out.

## Who

| Principal | Where | Private repositories |
|---|---|---|
| `oidc:<owner_sub>` (remote connector, through the hub) | the Mac runtime | enrolled ones |
| `local:<OS user>` (the stdio server the owner starts) | his Mac | enrolled ones |
| any other `oidc:` principal | anywhere | refused (`private_policy_owner_only`) |
| `reader:`, `hub:` and any other local principal | anywhere | none; public ones unchanged |
| anyone on the VPS | the VPS | none (enrollment is Mac only) |

The local principal is minted by the stdio server for the OS user running it; the hub can only
carry `hub:` and `oidc:` ids, so a remote caller can never present `local:`.

## What

- Namespaces: `memolabs-dev` and `guillaume-flambard`. Any other owner is refused by the
  coordinator pre-filter (`allowedRepo`) and by the ledger (`issue_preflight.ORG_REPO`).
- Public repositories: any one GitHub reports public and not archived. The coordinator no longer
  needs the `PUBLIC_ALLOWLIST` literal for them; the ledger decides.
- Private repositories: only those enrolled by the owner on his Mac, in one of two 0600 files of
  his uid at fixed paths under `~/.local/share/memo-bridge/owner-policy/`:
  - `private-repos.json` (`memolabs.owner-private-repos.v1`), up to 100 repositories;
  - `external-projects.json` (`memolabs.owner-external-projects.v1`), the owner's checkouts outside
    MEMOLABS_ROOT: `{name, path, repo}` rows. A row becomes a catalog project when its path is a
    real repository directory in the owner's home, outside `Documents`, `Downloads`, `Desktop`,
    `Library`, `.ssh`, `.aws`, `.gnupg`, `.config`, `.local` and the registry root, and its origin
    is `repo`. Enrolling the row enrolls the repository for the ledger.
- The remote project allowlist (`remote.json` `projects`) holds up to 100 names.

## How the stdio server takes part

The ledger accepts `MEMO_BRIDGE_AGENT_MODE=runtime` (with `MEMO_BRIDGE_MAC_RUNTIME_ENABLED=enabled`)
or `stdio`. The stdio server gives its ledger child `MEMO_BRIDGE_AGENT_MODE=stdio` and
`MEMO_BRIDGE_HOST=<this host>` unless the owner set them. The owner adds to the stdio server's
environment: `MEMO_BRIDGE_GOVERNANCE_ROOT`, `MEMO_BRIDGE_REMOTE_CONFIG`, `MEMO_BRIDGE_OWNER_SUB`,
`MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE`, `MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE` (the same values
as the Mac runtime's plist).

## Privacy of the lease ledger

The ledger repository `memolabs-dev/.github` is public. A lease on a private repository records
`subject` (the digest already used as the ref name) instead of `repo` and `issue`. Records written
before this change keep their clear form in history; a clear record of a private repository loses
it at its next heartbeat. The digest is unsalted: whoever guesses an exact `owner/repo#n` can
confirm that it was leased. A separate private ledger would close that too.

## What stays out

Private folders and secrets, `.env` values, arbitrary shell, default-branch writes, force push,
merge, deployment and other people's principals: unchanged. Worktrees of an external project go
under `$MEMOLABS_ROOT/workspace/worktrees/<name>/`; Memo Bridge only adds fetched refs and worktree
metadata to the external checkout's `.git`. Whatever an enrolled repository tracks can be read by
the owner's principals through `worktree_read_file`.
