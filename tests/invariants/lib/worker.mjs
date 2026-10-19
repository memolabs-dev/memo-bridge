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
//              { type: 'exit' }
// `insert_claim` bypasses the coordinator and the ledger: it inserts a 'claimed' row for this worker's
// workspace straight through the store repository, in one write transaction, as production does. It is how
// a test reaches the store's own UNIQUE live-claim index.
// `write` runs a coordinator operation named by `op` (task_checkpoint, task_complete, task_release,
// task_renew) for this worker's own workspace; `args.workspace_id` is filled in when absent.
import { createIssueLeaseClient } from '../../../server/coordinator/issue-lease.mjs';
import { FAKE_GH_DIR, GOVERNANCE_ROOT, coordinatorOn } from './fixture.mjs';

const [stateDir, githubState, offsetArg = '0', project = 'drop'] = process.argv.slice(2);
const offset = Number(offsetArg);
const OPS = { task_checkpoint: 'taskCheckpoint', task_complete: 'taskComplete', task_release: 'taskRelease', task_renew: 'taskRenew' };

const ledger = createIssueLeaseClient({ root: GOVERNANCE_ROOT, timeoutMs: 30000,
  env: { ...process.env, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: githubState } });
const { store, coordinator } = coordinatorOn(stateDir, { ledger, now: () => Date.now() + offset, repos: { [project]: null } });
const opened = await coordinator.workspaceOpen({ project, client_type: 'chatgpt', client_label: `worker ${process.pid}` });
const workspace_id = opened.workspace?.workspace_id;
process.send({ type: 'ready', workspace: opened });

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
  if (message.type === 'exit') {
    await store.close();
    process.exit(0);
  }
});
