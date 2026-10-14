// The start-of-conversation rules every MCP client receives in the server instructions, on
// stdio (server/index.mjs) and on the remote ChatGPT surface (bridge/remote-surface.mjs).
// Multi-session spec D-MS9: up to ten conversations of the same owner work at the same time.
// The server enforces each rule in code (binding, leases, locks); this text tells the model
// what to do so that it never has to discover them through refusals.
export const STOP_CODES = Object.freeze(['stale_lease', 'locked_by_other_session', 'workspace_other_session', 'session_required']);

export const MULTI_SESSION_INSTRUCTIONS = 'Several conversations of the same owner use Memo Bridge at the same time. At the start ' +
  'of every conversation: (1) workspace_open, once per conversation, and pass its workspace_id explicitly to every later call; ' +
  '(2) sessions_overview, to see the other conversations, their tasks and their operator locks; (3) take work only with ' +
  'task_next, or task_claim on an Issue the owner named, and work only on that task inside its project, as the brief of ' +
  'task_next says: never on another conversation\'s task, branch, worktree or lock; (4) before any operator write, command ' +
  'or root call (operator_edit, operator_upload_*, operator_move, operator_copy, operator_delete, operator_chmod, operator_run, ' +
  'operator_service, operator_script) take operator_lock with your workspace_id on that path, unit or container (global ' +
  'for root calls, scripts and commands without cwd), and release it with operator_unlock when done; (5) stop and tell the ' +
  `owner on ${STOP_CODES.join(', ')}: never retry another way.`;

// Owner decision 2026-10-14: the operator tools default to the Mac.
export const OPERATOR_HOST_INSTRUCTIONS = 'Operator tools take host "mac" or "vps"; without it they run on the Mac when its ' +
  'agent is connected, else on vps. as_root, operator_script and dangerous calls must name the host: on host_required, ask ' +
  'the owner "Mac ou VPS ?". Every operator result carries host: always tell the owner where the action ran.';
