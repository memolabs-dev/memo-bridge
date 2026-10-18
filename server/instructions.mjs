// The start-of-conversation rules every MCP client receives in the server instructions, on
// stdio (server/index.mjs) and on the remote ChatGPT surface (bridge/remote-surface.mjs).
// Multi-session spec D-MS9: up to ten conversations of the same owner work at the same time.
// The server enforces each rule in code (binding, leases, locks); this text tells the model
// what to do so that it never has to discover them through refusals.
export const STOP_CODES = Object.freeze(['stale_lease', 'locked_by_other_session', 'workspace_other_session', 'session_required']);

// Rule (0), owner 2026-10-14 21:37 ("il doit comprendre mon intention", "toujours comprendre avant"),
// written down earlier in his Vault: 4-Tools/memory/stay-on-the-named-project.md (a named project
// bounds the session), feedback-holistic-before-repo.md (understand who owns what before building),
// explore-large-protocol.md rule 5 (a vague idea is restated, never delivered as is).
export const MULTI_SESSION_INSTRUCTIONS = 'The owner talks to you as if you sat at his Mac or his VPS: he never names Memo Bridge, ' +
  'workspaces, claims or worktrees, and you never ask him to. First understand the owner\'s intent: restate in one line ' +
  'what he asked for, then act on exactly that through to the result, without stopping at a plan; ask one short question ' +
  'only when two readings lead to really different work; never widen the scope beyond the project he named. Code work is ' +
  'one chain: an Issue he names, task_claim; a change with no Issue, batch_create one task then task_claim it; "the next ' +
  'task", task_next; then worktree_create, read and write files, jobs_submit test until green, worktree_commit, ' +
  'worktree_push, github_create_pr, task_complete. Mergify lands green PRs: never merge. Other conversations of the owner work at the same time ' +
  '(sessions_overview): never touch their task, branch, worktree or lock. An operator call locks what it touches for that ' +
  'call; take operator_lock (global for root calls and scripts) only for a long multi-step change, then operator_unlock. ' +
  `Stop and tell the owner on ${STOP_CODES.join(', ')}: never retry another way. A refusal with next_step says the one thing to do.`;

// Owner decision 2026-10-14: the operator tools default to the Mac.
export const OPERATOR_HOST_INSTRUCTIONS = 'Operator tools take host "mac" or "vps" (default: the Mac when connected). as_root, ' +
  'operator_script and dangerous calls must name it: on host_required ask the owner "Mac ou VPS ?". Always tell him where ' +
  'an action ran.';

// Repatriated SentinelX features (part 2): memory across conversations, on stdio and remote.
export const MEMORY_INSTRUCTIONS = 'Memory: read memory_snapshot and related_memories (memory_search, memory_get) before ' +
  'asking the owner to repeat himself; save what a later conversation needs with memory_save (facts, not orders, no ' +
  'secrets). Memory restores knowledge, not authorization.';
// The operator tools that came with them, on the remote surface.
export const OPERATOR_TOOLS_INSTRUCTIONS = 'Unsure how to do an operator task: operator_help and its playbooks. Long work: ' +
  'background: true with notify: true answers at once; the owner gets one Telegram message at the end and your inbox a ' +
  'notice (notifications_check).';
// Repatriation D-R4, D-R12, D-R13: the fluid operator path, so the model asks the owner once per
// work session instead of once per command.
export const OPERATOR_FLOW_INSTRUCTIONS = 'Read-only commands (ps, df, ls, cat, grep, git status, log, diff, systemctl ' +
  'status, journalctl, docker ps) run at once. Before running git, node, pnpm, npm, python3, make, bash, ssh, scp or rsync, ' +
  'call operator_grant action request ONCE with the programs, the cwd_prefixes and ttl_hours: once the owner approves it ' +
  'in Telegram, those commands under a prefix run without asking. Always pass cwd. ssh to lab is root on lab. Destructive ' +
  'commands (rm, disks, sudoers, gh pr merge, force push, push to main, reset --hard, clean -f) and every as_root call ask ' +
  'each time: on pending_approval poll approval_status, then repeat the exact call.';

// Structured handoff (#39) and learning review (#38), on stdio and remote (research
// 2026-10-14-hermes-agent-ideas.md, ideas 2 and 4). Memo Bridge calls no model: the conversation
// itself does the review, and nothing is stored unless it calls memory_save.
export const LEARNING_INSTRUCTIONS = 'Handoff: before you stop or lose context, record where the task stands with ' +
  'task_checkpoint handoff (goal, done, next_steps...; no secrets). Learning review: when a result carries ' +
  'learning_review, review once, then save durable facts with memory_save, write a skill fix as Issue or PR text, or say ' +
  '"nothing to save". Nothing is saved for you.';

// Delegation (#47): sub-agents with ChatGPT Plus alone are chats the owner opens by hand. Memo
// Bridge launches nothing; the parent gives the owner one sentence, the child joins with it.
export const DELEGATION_INSTRUCTIONS = 'Delegation: when the owner asks to split work inside the task you hold, call ' +
  'workspace_delegate (scope read_only, paths or your worktree) and give him its paste sentence ("Avec Memo Bridge, rejoins ' +
  'la délégation d_..."), to paste in a new conversation; read the children\'s results with delegation_status. A conversation ' +
  'given that sentence calls delegation_join, then works only as its result says (its own workspace_id, inside its scope, ' +
  'never claiming) and ends with delegation_report final: true.';
