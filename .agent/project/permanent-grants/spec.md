# Permanent grants in the host policy (issue #48)

Branches `feat/permanent-grants` (memo-bridge) and `feat/operator-permanent-grants` (lab-infra).

Intent (owner decision 2026-10-14 21:29): too many Telegram approvals for everyday programs. A
permanent grant is a standing approval (`bridge/operator-grants.mjs`) with no TTL and no
principal, written by the owner in the host policy file, never by a tool.

Defaults: Mac `python3, node, bash, zsh, git, pnpm, npm, make` under `~/memolabs`
(`deploy/mac/operator-mac.mjs` `macPolicy`); lab the same under `/srv` and `/opt` (lab-infra
`memo_operator_permanent_*`, switch `memo_operator_permanent_grants`).

Non-goals: any way for the model to add, extend or revoke one; Telegram `/approvals` listing them
(they are listed in `operator_policy` and `sessions_overview`); a root-owned Mac policy.

## Design

| ID | Decision |
|---|---|
| D-PG1 | `permanent_grants: [{host, programs, cwd_prefixes}]` in the policy file, parsed by `parseOperatorPolicy`. Unknown keys refused (so `as_root`, `root`, `ttl_hours` are). At most 8 entries, 16 programs, 4 prefixes. Programs: bare names, `programGrantable` (not the hard list, not sudo, su, doas, pkexec, runuser, chroot, nsenter). Prefixes: `policyPath` rules, never `/`. Host: the file's. |
| D-PG2 | Coverage `permanentCovers` = a standing grant's `covers` without TTL and principal: `operator_run`/`operator_script`, not `as_root`, a `cwd` under a prefix (lexical, case folded on the Mac), classification grantable (not hard), every program named. Shared `grantableCall`. |
| D-PG3 | Id `ap_pm_` + 22 chars of sha256(host, sorted programs, sorted prefixes): stable, the hub and the agent name the same entry with no shared state. Fits `APPROVAL_ID_RE`. |
| D-PG4 | The agent is the authority: an `ap_pm_` id passes only when its own file's grant with that id covers the call (`approval_scope` otherwise). The root helper refuses any `ap_pm_` id. Single-use ids never take `ap_st_` or `ap_pm_`. |
| D-PG5 | The hub learns the entries from the agent's `operator_policy` (signed T0, hub:owner), lazily when a call would otherwise ask Telegram, cached 5 minutes per agent connection (a reconnect refetches), refreshed whenever `operator_policy` passes, dropped on an `approval_scope` refusal. Order: single-use, permanent, standing. |
| D-PG6 | Journals: hub `operator_call` gets `approval_source` (`single_use`, `permanent`, `standing`); host journal carries the `ap_pm_` id. `policySummary` lists `permanent_grants` (source permanent, expires_at null); `sessions_overview` gets `permanent_grants` of both hosts. |
| D-PG7 | lab-infra renders the entry behind the switch and refuses, before any change, a pinned `memo_bridge_version` whose `operator-policy.mjs` lacks `permanent_grants` (an old loader would refuse the whole file and the agent and root helper would not start). |

## Requirements and acceptance

| ID | Acceptance (issue #48) | Evidence |
|---|---|---|
| PG-A1 | Under the defaults, `python3` in ~/memolabs on the Mac runs without a Telegram request | `tests/operator-permanent-grants.test.mjs` PG-R3, PG-R6 (live hub and Mac agent: run and script ok, 0 messages) |
| PG-A2 | The same call in ~/Documents still asks | PG-R3, PG-R6 (`pending_approval`, one message) |
| PG-A3 | `rm -r` and `gh pr merge` still ask under ~/memolabs | PG-R3, PG-R6; also `bash -c "rm -r"`, force push, push to main, reset --hard |
| PG-A4 | An `as_root` call still asks | PG-R3, PG-R6 (run and script); root helper refuses `ap_pm_` (`tests/operator-docker.test.mjs`) |
| PG-A5 | The loader refuses a grant naming a hard-danger program, or root | PG-R2 (rm, dd, mkfs*, kill..., sudo, su, doas, pkexec..., `as_root`, `root`, `/`, other host, paths); lab-infra `test_permanent_grants_load_through_memo_bridge` |
| PG-A6 | lab-infra renders the lab defaults, the Mac installer renders the Mac defaults | lab-infra `PermanentGrantTests` (rendering byte-identical to ansible-playbook 2026-10-14); PG-R1, PG-R6 (`macPolicy`) |
| PG-A7 | Shown in `operator_policy` and `sessions_overview`; each use journaled with source permanent | PG-R1, PG-R6 |
| PG-A8 | No tool adds or extends one | PG-R4 (operator_grant schema, store ids, single-use ids); PG-R5 (agent refuses an id its file lacks, a stale copy) |
| PG-A9 | Tests and one mutation check per rule | table below |

## Mutation checks (2026-10-14 21:45 to 21:50 CEST)

One source change, the rule's test file, expect a failure, file restored (scratch script).

| Mutation | Result | Test |
|---|---|---|
| M01 loader refuses hard programs | CAUGHT | operator-permanent-grants |
| M02 privilege tools never grantable | CAUGHT | operator-permanent-grants |
| M03 no root key in an entry | CAUGHT | operator-permanent-grants |
| M04 "/" never a prefix | CAUGHT | operator-permanent-grants |
| M05 entry host is the file host | CAUGHT | operator-permanent-grants |
| M06 cwd under a prefix | CAUGHT | operator-permanent-grants |
| M07 every program named | CAUGHT | operator-permanent-grants |
| M08 never a hard call (hard reasons win over the wrapper) | CAUGHT | operator-permanent-grants |
| M09 never as_root | CAUGHT | operator-permanent-grants |
| M10 agent checks ap_pm_ against its file | CAUGHT | operator-permanent-grants |
| M11 root helper refuses ap_pm_ | CAUGHT | operator-docker |
| M12 single-use ids never ap_pm_ | CAUGHT | operator-permanent-grants |
| M13 hub uses permanent grants | CAUGHT | operator-permanent-grants |
| M14 hub journals approval_source | CAUGHT | operator-permanent-grants |
| M15 sessions_overview shows them | CAUGHT | operator-permanent-grants |
| M16 operator_policy shows them | CAUGHT | operator-permanent-grants |
| M17 Mac installer renders the defaults | CAUGHT | operator-permanent-grants |
| M18 hub copy cached, not fetched per call | CAUGHT | operator-permanent-grants |
| M20 lab renders the defaults | CAUGHT | lab-infra test_memo_operator.py |
| M21 lab release check | CAUGHT (after a test was added) | lab-infra test_memo_operator.py |
| M22 lab prefixes never "/" | CAUGHT | lab-infra test_memo_operator.py |
| M23 lab file through the memo-bridge loader | CAUGHT | lab-infra test_memo_operator.py |

Equivalent, not counted: `danger.hard` in `grantableCall` (classifyCall gives every hard call
`programs: []`, so the next test already returns null) and `tier < 3` in the hub (tier 3 is
`as_root`, which `grantableCall` refuses). Both stay as defense in depth.

## Risks

| Risk | Level | Handling |
|---|---|---|
| A permanent grant on an interpreter is owner power without a prompt under its prefixes (the cwd bounds where a call starts, not what it touches) | accepted (owner decision) | stated in OPERATOR.md Limits; hard list and root still ask |
| On the Mac the agent user owns the 0444 policy: a covered `python3` call can rewrite it for the agent's next start, extending a grant | medium | documented; a root-owned Mac policy (root helper installer) would close it; out of scope |
| Deploy order on lab: a release without #48 refuses the policy with `permanent_grants` | medium | lab-infra assert before any change; bump `memo_bridge_version` with this release, or switch off |
| Hub copy stale after a policy change without reconnect | low | agent refuses (`approval_scope`), hub drops the copy; the policy is read at agent start, which reconnects |

## Evidence

- memo-bridge: `pnpm test` 548/548 before the rebase (see state.json for the final run), `pnpm run build` ok, `pnpm run smoke` ok (56 tools).
- lab-infra: `bash scripts/tests.sh` 115 green, 0 red; `test_memo_operator.py` 36 tests OK with `MEMO_BRIDGE_SRC` on this branch (1 skip without it, the controller cache predates #48).
- Runtime on the hosts: pending deploy (memo-bridge merge, lab `memo_bridge_version` bump, Mac reinstall).
