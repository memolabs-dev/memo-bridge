# VPS runner proof (issue memolabs-dev/memo-bridge#57)

- 2026-10-15 09:28 Paris: job `j338067fce6aa2c2cc8c56c39b48c9b2` failed before start with
  `226/NAMESPACE`: `jobs/<id>/cache` was missing when systemd built the mount namespace of
  `memo-job-install@`. Fixed by memo-bridge #58, deployed by guillaume-flambard/lab-infra#228
  (`memo_bridge_version` 2d909c0).
- 2026-10-15 10:34 Paris: job `job_jzUVCUXhVg88u91H` (unit `jbe99e88194017cf2506b8ff6a082031`)
  succeeded, exit 0. Install phase: `pnpm install --frozen-lockfile --ignore-scripts`, network
  on, 4 s. Recipe phase: `npm test` with `PrivateNetwork=yes` and `IPAddressAllow=localhost`
  only, 2 min, 595 tests, 0 failed, 33 skipped.
- 2026-10-15 10:40 Paris: this file was written, committed, pushed and opened as a pull request
  from ChatGPT through the VPS runner (worktree, GitHub App token, PR by memo-labs-automation).
  The Mac was still on, so this is not the Mac-off proof (AC-P4-01), which stays open.
- Open from this cycle: the `worktree_push` checkpoint failed with `session_required`, and
  `host_status mac` answered "unknown" from the VPS instead of online or offline.
