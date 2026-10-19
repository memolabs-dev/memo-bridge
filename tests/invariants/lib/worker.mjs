// Child process of the multi-process invariants: one process = one MCP client session with its
// own SQLite connection, racing through the canonical ledger (issue_lease.py on the offline gh).
// Derived from tests/helpers/claim-worker.mjs, which the invariants must not import.
//
// argv: stateDir githubState [clockOffsetMs] [project]
// The ledger script reads the real wall clock; clockOffsetMs shifts only Bridge's own clock
// (`now: () => Date.now() + offset`), which is how a test puts a reclaimer past expires_at + 60 s.
//
// messages in  { type: 'claim', issue, ttl }                                 -> { type: 'claimed', claim }
//              { type: 'renew', issue, claim_id, fence, ttl }                -> { type: 'renewed', renew }
//              { type: 'write', op, args }                                   -> { type: 'wrote', result }
//              { type: 'insert_claim', issue, claim_id, fence }              -> { type: 'inserted', ok, error?, code? }
//              { type: 'insert_worktree', id, branch, path }                 -> { type: 'inserted_worktree', ok, error?, code? }
//              { type: 'worktree_prepare', projectsRoot, worktreesRoot, issue, ttl } -> { type: 'prepared', claim }
//              { type: 'worktree_create', args }                             -> { type: 'created', result }
//              { type: 'exit' }
// `insert_claim` bypasses the coordinator and the ledger: it inserts a 'claimed' row for this worker's
// workspace straight through the store repository, in one write transaction, as production does. It is how
// a test reaches the store's own UNIQUE live-claim index.
// `worktree_prepare` builds, in this process, a full runtime (its own store connection) on the git project
// whose PROJECTS.md is under `projectsRoot`, opens a workspace on it and claims `issue`; `worktree_create`
// then calls the worktree_create tool with `args` (workspace_id and issue filled in), so a test can release
// every process at once. The claim is the real one (issue_lease.py on the offline gh): one Issue per session.
// `insert_worktree` inserts an active worktree row for this worker's workspace straight through the store
// (project `project`, host mac), to reach the UNIQUE live-branch and live-path indexes without git.
// `write` runs a coordinator operation named by `op` (task_checkpoint, task_complete, task_release,
// task_renew) for this worker's own workspace; `args.workspace_id` is filled in when absent.
import { createIssueLeaseClient } from '../../../server/coordinator/issue-lease.mjs';
import { createRuntime } from '../../../server/runtime.mjs';
import { registerWorktreeTools } from '../../../server/tools/worktree-tools.mjs';
import { FAKE_GH_DIR, GOVERNANCE_ROOT, OWNER, coordinatorOn } from './fixture.mjs';

const [stateDir, githubState, offsetArg = '0', project = 'drop'] = process.argv.slice(2);
const offset = Number(offsetArg);
const OPS = { task_checkpoint: 'taskCheckpoint', task_complete: 'taskComplete', task_release: 'taskRelease', task_renew: 'taskRenew' };

const ledger = createIssueLeaseClient({ root: GOVERNANCE_ROOT, timeoutMs: 30000,
  env: { ...process.env, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: githubState } });
const { store, coordinator } = coordinatorOn(stateDir, { ledger, now: () => Date.now() + offset, repos: { [project]: null } });
const opened = await coordinator.workspaceOpen({ project, client_type: 'chatgpt', client_label: `worker ${process.pid}` });
const workspace_id = opened.workspace?.workspace_id;
process.send({ type: 'ready', workspace: opened });

let git = null; // { rt, call, workspace_id, issue } once worktree_prepare has run
async function prepareGit({ projectsRoot, worktreesRoot, issue, ttl }) {
  process.env.MEMO_BRIDGE_WORKTREES_ROOT = worktreesRoot;
  const rt = createRuntime({ stateDir, principal: OWNER, ledger, catalogOptions: { projectsRoot }, host: 'mac', now: () => Date.now() + offset,
    projectRemote: async () => 'memolabs-dev/drop' }); // an allowlisted origin: the public ledger refuses the rest
  const tools = new Map();
  registerWorktreeTools({ registerTool(name, def, handler) { tools.set(name, { def, handler }); } }, () => rt);
  const call = async (name, args = {}) => {
    const { def, handler } = tools.get(name);
    return JSON.parse((await handler(def.inputSchema.parse(args))).content[0].text);
  };
  const coord = rt.coordinator();
  const opened = await coord.workspaceOpen({ project: 'demo', client_type: 'cli', client_label: `git worker ${process.pid}` });
  const workspace_id = opened.workspace?.workspace_id;
  const claim = await coord.taskClaim({ workspace_id, issue, ttl_seconds: ttl ?? 600 });
  git = { rt, call, workspace_id, issue };
  return claim;
}

process.on('message', async message => {
  if (message.type === 'claim') {
    const claim = await coordinator.taskClaim({ workspace_id, issue: message.issue, ttl_seconds: message.ttl ?? 600 });
    process.send({ type: 'claimed', claim });
  }
  if (message.type === 'renew') {
    const renew = await coordinator.taskRenew({ workspace_id, issue: message.issue, claim_id: message.claim_id, fence: message.fence,
      ttl_seconds: message.ttl ?? 600 });
    process.send({ type: 'renewed', renew });
  }
  if (message.type === 'write') {
    const method = OPS[message.op];
    const result = method ? await coordinator[method]({ workspace_id, ...message.args }) : { ok: false, error: 'unknown_op' };
    process.send({ type: 'wrote', result });
  }
  if (message.type === 'insert_claim') {
    const at = new Date().toISOString();
    try {
      await store.transaction(repo => repo.insertClaim({ claim_id: message.claim_id, workspace_id, issue_ref: message.issue,
        fence_sha: message.fence, epoch: 1, expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: at }));
      process.send({ type: 'inserted', ok: true });
    } catch (error) {
      process.send({ type: 'inserted', ok: false, error: String(error?.message ?? error), code: error?.code ?? error?.errcode ?? null });
    }
  }
  if (message.type === 'insert_worktree') {
    const at = Date.now();
    try {
      await store.transaction(repo => repo.insertWorktree({ id: message.id, workspace_id, project_id: project, host: 'mac', path: message.path,
        branch: message.branch, base_ref: 'origin/main', base_commit: 'a'.repeat(40), issue_ref: null, created_at: at, updated_at: at }));
      process.send({ type: 'inserted_worktree', ok: true });
    } catch (error) {
      process.send({ type: 'inserted_worktree', ok: false, error: String(error?.message ?? error), code: error?.code ?? error?.errcode ?? null });
    }
  }
  if (message.type === 'worktree_prepare') {
    process.send({ type: 'prepared', claim: await prepareGit(message) });
  }
  if (message.type === 'worktree_create') {
    const result = await git.call('worktree_create', { workspace_id: git.workspace_id, issue: git.issue, ...message.args });
    process.send({ type: 'created', result });
  }
  if (message.type === 'exit') {
    await git?.rt.close();
    await store.close();
    process.exit(0);
  }
});
