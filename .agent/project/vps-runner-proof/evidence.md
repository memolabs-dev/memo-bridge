# VPS runner proof (issue memolabs-dev/memo-bridge#57)

- 2026-10-15 09:28 Paris: job `j338067fce6aa2c2cc8c56c39b48c9b2` failed before start with
  `226/NAMESPACE`: `jobs/<id>/cache` was missing when systemd built the mount namespace of
  `memo-job-install@`. Fixed by memo-bridge #58, deployed by guillaume-flambard/lab-infra#228
  (`memo_bridge_version` 2d909c0).
- 2026-10-15 10:34 Paris: job `job_jzUVCUXhVg88u91H` (unit `jbe99e88194017cf2506b8ff6a082031`)
  succeeded, exit 0. Install phase: `pnpm install --frozen-lockfile --ignore-scripts`, network
  on, 4 s. Recipe phase: `npm test` with `PrivateNetwork=yes` and `IPAddressAllow=localhost`
  only, 2 min, 595 tests, 0 failed, 33 skipped.

## Mac off (AC-P4-01)

This file was written, committed, pushed and opened as a pull request from ChatGPT through the VPS
runner while the Mac was asleep with its lid closed. Times in UTC:

| Time | Event | Source |
|---|---|---|
| 08:39:21 | Mac enters `Clamshell Sleep` | `pmset -g log` on the Mac |
| 08:39:40 | hub: `agent_ping_timeout` then `agent_disconnected` for `mac` and `operator-mac` | `journalctl -u memo-bridge-hub` on lab |
| 08:40:26 | commit `c034cce` | GitHub commit committer date |
| 08:40:41 | `app_token_minted` for memolabs-dev/memo-bridge on host `vps` | runner journal |
| 08:40:45 | PR #59 opened by `memo-labs-automation` | GitHub |
| 08:41:10 | Mac wakes (lid) | `pmset -g log` |
| 08:41:35 | hub: `agent_connected` for `operator-mac`, then `mac` at 08:41:38 | hub journal |

The Mac was asleep, not powered off: what matters is that no Mac agent was connected to the hub
from 08:39:40 to 08:41:35, and the whole write cycle ran in that window.

## Open from this cycle

- The `worktree_push` checkpoint failed with `session_required`; push and PR were not affected.
- `host_status mac` answered "unknown" from the VPS instead of offline, right after the
  disconnect.
