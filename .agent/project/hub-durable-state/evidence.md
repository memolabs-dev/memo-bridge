# Evidence (2026-10-15, local)

- `node --test tests/hub-state.test.mjs`: 6 of 6 pass.
- Mutation checks, each applied alone then reverted: 8 of 8 caught. They removed the freeze save,
  the save after a grant revoke, after an unlock and after a new lock, after an ack and after a
  new watch, kept implicit locks in the saved table, and wrote files 0644.
- `pnpm test`: 603 of 603 pass. `pnpm run build` and `pnpm run smoke` pass (61 tools).
