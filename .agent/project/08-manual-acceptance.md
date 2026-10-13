# Manual acceptance

1. Install the rebuilt plugin (`npm run package:plugin`) in Claude Code or Codex, then open two sessions.
2. Session A: `workspace_open` on a project, `task_create`, then `task_claim`. Keep the fencing token.
3. Session B: `workspace_open` on the same project, then `task_claim` on the same task. Expect `lease_held`.
4. Session A: push a commit, then `task_checkpoint` with the branch and the full SHA. Expect `durability: remote`.
5. Session A: `task_complete`. Session B: `tasks_list` with status `completed` shows the task.
6. Restart both clients and check that `task_status` still shows the task and its checkpoint.
7. Ask yourself whether the flow feels right for running parallel ChatGPT, Claude and Codex sessions.
