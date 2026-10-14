# Mutation checks, repatriation part 1

Run 2026-10-14 20:35 to 20:45 CEST on the rebased branch, by a scratch script that applies one source
change, runs the rule's test file with `node --test`, expects a failure, and restores the file (`git status` clean after).

| Mutation | Result | Test file |
|---|---|---|
| M01 gh pr merge hard | CAUGHT | tests/operator-classify.test.mjs |
| M02 gh api DELETE hard | CAUGHT | tests/operator-classify.test.mjs |
| M03 git reset --hard | CAUGHT | tests/operator-classify.test.mjs |
| M04 git push force | CAUGHT | tests/operator-classify.test.mjs |
| M05 hard before wrapper | CAUGHT | tests/operator-classify.test.mjs |
| M06 ssh remote program | CAUGHT | tests/operator-classify.test.mjs |
| M07 rsync --delete hard | CAUGHT | tests/operator-classify.test.mjs |
| M08 grant never covers hard | SURVIVED | tests/operator-grants.test.mjs |
| M09 grant cwd prefix | CAUGHT | tests/operator-grants.test.mjs |
| M10 grant TTL | CAUGHT | tests/operator-grants.test.mjs |
| M11 grant all programs named | CAUGHT | tests/operator-grants.test.mjs |
| M12 grant never sudo | CAUGHT | tests/operator-grants.test.mjs |
| M13 agent approval_scope | CAUGHT | tests/operator-grants.test.mjs |
| M14 helper refuses standing ids | CAUGHT | tests/operator-docker.test.mjs |
| M15 single-use ids never ap_st_ | CAUGHT | tests/operator-grants.test.mjs |
| M16 hub uses grants | CAUGHT | tests/operator-grants.test.mjs |
| M17 telegram /revoke | CAUGHT | tests/operator-grants.test.mjs |
| M18 process group kill | CAUGHT (hang until timeout) | tests/operator-userexec.test.mjs |
| M19 background group | CAUGHT | tests/operator-userexec.test.mjs |
| M20 supervisor cleanup | CAUGHT | tests/operator-userexec.test.mjs |
| M21 script removed after run | CAUGHT | tests/operator-userexec.test.mjs |
| M22 user HOME | CAUGHT | tests/operator-userexec.test.mjs |
| M23 run_path first | CAUGHT | tests/operator-userexec.test.mjs |
| M24 user script tier 2 | CAUGHT | tests/operator-userexec.test.mjs |
| M25 docker inspect never Env | CAUGHT | tests/operator-docker.test.mjs |
| M26 docker live list | CAUGHT | tests/operator-docker.test.mjs |
| M27 docker critical containers | CAUGHT | tests/operator-docker.test.mjs |
| M28 read-only find -delete | CAUGHT | tests/operator-readonly.test.mjs |
| M29 read-only git -c | SURVIVED | tests/operator-readonly.test.mjs |
| M30 read-only path check | CAUGHT | tests/operator-readonly.test.mjs |
| M31 read-only git hardened | CAUGHT | tests/operator-readonly.test.mjs |
| M32 hub read-only skips lock | CAUGHT | tests/operator-readonly.test.mjs |
| M33 implicit lock released | CAUGHT | tests/operator-readonly.test.mjs |
| M34 implicit lock conflicts | CAUGHT | tests/operator-readonly.test.mjs |
| M35 implicit workspace cached | CAUGHT | tests/operator-readonly.test.mjs |
| M36 workspace_open mac note | CAUGHT | tests/remote-surface.test.mjs |
| M37 Mac write roots home | CAUGHT | tests/operator-mac-install.test.mjs |
| M38 Mac denylist agent code | CAUGHT | tests/operator-mac-install.test.mjs |
| M39 instructions grant | CAUGHT | tests/operator-readonly.test.mjs |
| M40 lock for user script cwd | CAUGHT | tests/operator-userexec.test.mjs |
| M41 implicit locks know uploads (transfer) | CAUGHT | tests/operator-transfer.test.mjs |
| M42 restart_stack uses operator_docker | CAUGHT | tests/operator-snapshot-help.test.mjs |
| M43 Mac install root probe hermetic | CAUGHT | tests/operator-mac-install.test.mjs |

41 of 43 caught. The two survivors are equivalent mutants, kept as defence in depth:

- M08: `grants.covers` also returns null for a hard call because a hard classification carries no
  programs (`programs.length === 0`); the explicit `danger.hard` test is redundant by construction.
- M29: without the explicit `-c` refusal, `git -c ...` still falls on the generic rule that any
  unknown option before the subcommand is not read-only (`a.startsWith('-')` gives null).

M18 (group kill turned into a direct-child kill) hangs the test until its timeout: the grandchild
keeps the pipes open, which is the bug the rule fixes.
