# Session identity and the operator journal contract

Issue #291, under the umbrella #4; related to #263 (checkout collisions), #270 (lease-bound OpenCode for Orbit), #281 (verified outcome gate). Read with `docs/SESSION_BINDING_AND_CRASH_RECOVERY.md` (signed session binding) and `docs/POLICY_AUTHORITY.md` (#290).

This page states what is true in the code on 2026-10-25 and what is not done yet. Each action should be attributable to one session, and someone outside the conversation should be able to rebuild the order of events and detect a gap or an edit.

## Who has a session today

| Client | Path | Principal (who) | Session (which conversation) | Minted by | Absent or forged |
|---|---|---|---|---|---|
| ChatGPT | public listener (OAuth) to hub to agents | `oidc:<sub>` from the verified token, `client_type` from `remote.json` `allowed_client_ids`; tool arguments never change it | `client_session`: the first 32 hex of SHA-256 of `openai/session\|<hint>`, computed by the hub from `_meta["openai/session"]` (`bridge/forward.mjs`) | the hub, from a hint the client chooses | Workspace binding (`bridge/write-gate.mjs`): `warn` (default) accepts, `block` refuses a mismatch, `enforce` refuses an absent hint (`session_required`) and another conversation's workspace (`workspace_other_session`). Operator calls on the Mac: signed v2 with the session when `MEMO_BRIDGE_OPERATOR_SESSION_BINDING=enabled`; the agent refuses a swapped or dropped hint (`session_mismatch`) |
| Hub bearer (9443) | owner or read-only token | `hub:owner`, `hub:readonly` | none | | |
| Claude Code, Codex, OpenCode (stdio) | local MCP server on the Mac | the local owner (`localOwnerPrincipal`) | **none**. The coordination handle is the `workspace_id` that `workspace_open` returns | | A claim is looked up in its own workspace only: another workspace presenting its `claim_id` and fence gets `unknown_claim` |
| Orbit (OpenCode supervised, #270) | `scripts/with-checkout-lease.mjs`, Mac checkout authority | the local owner | the lease's session hash in the Mac checkout ledger | the supervisor | `session_required`; an expired lease answers `checkout_recovery_required` for its former holder and for anyone else |

The hint is not proof: the hub signs the hash it received, so it cannot be changed after signing, but the client chose it. A session never grants a right; the principal and the host policy do.

**Not done.** A stdio process has no session id of its own: two Claude Code windows of the owner are two workspaces, not two sessions, and nothing stops one from using the other's `workspace_id`. One session model across stdio, the remote hub and the Mac runtime (scope step 1 of #291) still needs a design: who mints a stdio session (the MCP server per process is the obvious candidate), how it binds to a workspace, how it ends.

## The operator host journal

One JSON line per operator call, refusals included, hash-chained (`bridge/operator-audit.mjs`). Lab: `/var/log/memo-operator/audit.jsonl`, owned by the root helper, the agent appends through its socket. Mac: `~/Library/Logs/memo-operator/audit.jsonl`, written by the agent as the owner, plus the root helper's own chain for root calls. The hub asks each agent for its head every 15 minutes and freezes operator access when an anchored line changed.

| Field | Meaning |
|---|---|
| `seq` | 1, 2, 3... one monotonic sequence per journal file |
| `at` | ISO time of the line |
| `prev` | `hash` of the previous line; 64 zeros for the first |
| `hash` | SHA-256 of the canonical JSON of the line without `hash` |
| `source` | `agent` or `root-helper`: who reported the line |
| `host` | `vps` or `mac` (**new**). On lab the root helper writes its own host, never the agent's claim |
| `session` | the `client_session` the hub signed (v2) once the signature checked out, else `null` (**new**). Root calls are signed v1: `null` |
| `session_claimed` | only when it differs from `session`: the hint the unsigned request metadata carried (**new**). A forged or replayed hint shows here and is never trusted |
| `principal` | the principal id the hub signed |
| `request_id`, `ref` | the wire request id; the caller's trace reference |
| `op`, `tier` | operation and tier (0 to 3) |
| `args_sha256`, `args` | hash of the exact arguments; arguments redacted and cut |
| `approval` | approval or grant id the signature carried, or `null` |
| `outcome`, `code` | `ok` or `denied`, and the refusal code |
| `ms`, `output_sha256` | duration; hash of the bounded output (the output itself is never kept) |

Lines written before this change have no `host` and no `session` and still verify: the hash covers the fields a line has.

## The verifier

```bash
node scripts/audit-verify.mjs /var/log/memo-operator/audit.jsonl --anchor 1234:<sha256>
```

It prints one JSON document and exits 0 for a clean chain, 1 for a broken one, 2 for unusable arguments or file. It reads with `O_NOFOLLOW` and never writes. On lab the journal is root-only, so the command runs as root.

- `ok`, `lines`, `head`; on a break `first_broken_line` and `reason`: `unparsable`, `sequence` (a line deleted or inserted), `prev_mismatch` (a line rewritten and rehashed), `hash_mismatch` (a line edited), `truncated` (fewer lines than the anchor), `anchor_mismatch` (another line at the anchor's seq).
- `sessions`: for each session hash (and `null`), its principals, its number of lines, the seq of its first and last line. A session with two principals is visible here.
- A cut tail leaves a valid chain. Only an anchor shows it: keep one (the hub's anchors, or a `seq:hash` copied off the host).

## What other journals do not carry yet

- **The coordinator store** (`events` table in `coordinator.sqlite`): `seq`, `at`, `principal`, `workspace_id`, `issue_ref`, `op`, `outcome` (`ok`, `denied`, `error`), `code`. No session, no host, no hash chain. A foreign `claim_id` is journaled with outcome `error` and code `unknown_claim`, under the workspace that sent it.
- **The hub's own audit** (JSON lines on stderr, journald on lab): events with `host` and the principal, no chain, no sequence.

## What Cuesheet and Orbit need

A search of both checkouts on 2026-10-25 found no reader of the operator journal or of `client_session` in either: neither keeps its own journal format to replace yet. What each would need from the contract above:

- **Orbit** (#270): a session per supervised run that survives a crash (the Mac checkout ledger's lease session), the same hash written in the operator journal for the calls of that run, and `scripts/audit-verify.mjs` output to show, per run, the ordered calls and any gap.
- **Cuesheet**: read-only use of `sessions` from the verifier (who did what, in which order) and the `session_claimed` field to show refused, unbound or forged attempts. It needs no write access to any journal.

## Tests

`tests/session-journal.test.mjs`: two sessions act concurrently and every line names its session, principal and host, the verifier reports a clean ordered chain; a swapped, dropped or replayed session id is refused (`session_mismatch`, `replayed`) and journaled with the claimed hint kept apart; deleting, editing, rehashing or cutting a line is detected by the command. `tests/coordinator.test.mjs`: an expired claim replayed by its former holder (`stale_lease`) or by another workspace (`unknown_claim`), on renew, release and checkpoint, is refused and journaled under the workspace that sent it. Expiry of a checkout lease for its holder and for another session: `tests/checkout-leases.test.mjs`.
