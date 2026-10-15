# Hub durable state

Owner request (2026-10-15): make `/freeze`, locks, grants and the inbox durable (inventory P0,
`workspace/research/2026-10-14-inventaire-memo-bridge.md` §4.9: 20 hub restarts in 24 h, each
one dropping the emergency stop, the locks, the `/grant` approvals and the inbox).

## Facts

- The hub runs as `memo-bridge` under `ProtectSystem=strict` with no `StateDirectory=`: it has no
  writable place today (lab, `systemctl show memo-bridge-hub`, 2026-10-15).
- In memory before this change: `operatorFrozen` (`bridge/hub.mjs`), grants
  (`operator-grants.mjs`), locks, uploads and last calls (`operator-locks.mjs`), inbox and watches
  (`operator-notifications.mjs`), approvals (`operator-approvals.mjs`), transfers.

## Decisions

| ID | Decision | Why |
|---|---|---|
| D1 | One JSON document per table under one directory, atomic write (temporary file, fsync, rename), 0600, directory 0700 owned by the hub user. | Small bounded tables, rare writes; no new dependency; readable by hand when debugging. |
| D2 | Directory from `MEMO_BRIDGE_HUB_STATE_DIR`, else `$STATE_DIRECTORY` (systemd). Unset: memory only, as before. | Tests and hand-started hubs keep the old behaviour; lab sets `StateDirectory=`. |
| D3 | Kept: `/freeze` flag, grants (active and pending), explicit locks and delegation families, inbox with acks, watches of notify jobs. | They outlive the call that made them. |
| D4 | Not kept: pending approvals, implicit per-call locks, upload ids, last-call table, transfers. | They belong to a call or exchange that the restart ended; restoring them would grant nothing to anyone. |
| D5 | The freeze flag is saved before it is journaled; a restored freeze is journaled `operator_frozen` `by: restored`. | An emergency stop must not be lifted by the next deploy. |
| D6 | A corrupt or unknown-version document is renamed `<name>.json.corrupt-<ms>`, journaled `hub_state_corrupt`, and its table starts empty; a failed save is journaled `hub_state_save_failed` and the hub keeps its memory. | Never crash the hub on its own state; leave evidence. |
| D7 | Restored rows are revalidated (ids, hosts, sizes, expiry); a watch keeps only `{id, client_type}` of its principal. | The file is data, not trusted code; the wire needs no more (`bridge/protocol.mjs` makeRequest). |

## Requirements and acceptance

| ID | Requirement | Evidence |
|---|---|---|
| HS-R1 | A `/freeze` survives a hub restart; `/unfreeze` too | `tests/hub-state.test.mjs` "hub" |
| HS-R2 | An active `/grant` still covers its calls after a restart; a revoke survives | "grants" |
| HS-R3 | An operator lock still blocks another conversation after a restart; an unlock survives; implicit locks are not kept | "locks" |
| HS-R4 | Inbox, acks and watches survive; a restored watch is polled and notifies once | "notifications" |
| HS-R5 | 0600 files, 0700 directory, atomic writes, corrupt documents set aside | "state" tests |
| HS-R6 | No state directory: behaviour unchanged | "state", "hub" |
| HS-R7 | Whole suite, build, smoke green | evidence.md |
| HS-R8 | lab: `StateDirectory=memo-bridge-hub` (0700), hub logs `durable_state: true`, a live `/freeze` survives `systemctl restart memo-bridge-hub` | evidence.md, "Live on lab" |
