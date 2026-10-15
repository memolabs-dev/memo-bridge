# Evidence (2026-10-15, local)

- `node --test tests/hub-state.test.mjs`: 6 of 6 pass.
- Mutation checks, each applied alone then reverted: 8 of 8 caught. They removed the freeze save,
  the save after a grant revoke, after an unlock and after a new lock, after an ack and after a
  new watch, kept implicit locks in the saved table, and wrote files 0644.
- `pnpm test`: 603 of 603 pass. `pnpm run build` and `pnpm run smoke` pass (61 tools).

## Live on lab (2026-10-15)

- guillaume-flambard/lab-infra#229 merged, `make deploy-memo-bridge` `failed=0` (memo_bridge_version
  a8f5a60). `/var/lib/memo-bridge-hub` exists, owner memo-bridge, mode 0700. `hub_started` logs
  `durable_state: true`; no `hub_state_corrupt` or `hub_state_save_failed`. The four agents
  reconnected; public `/mcp` 401 and metadata 200.
- 09:12:08Z owner `/freeze` in Telegram: `freeze.json` written (0600, `frozen: true`, `by:
  telegram`), journal `operator_frozen`.
- 09:12:41Z `systemctl restart memo-bridge-hub`: `hub_state_loaded` `freeze`, then
  `operator_frozen` `by: restored`, `since` 09:12:08Z. The owner's `/status` showed the hub frozen.
- 09:13:08Z owner `/unfreeze`: `freeze.json` back to `frozen: false`, journal `operator_unfrozen`.
