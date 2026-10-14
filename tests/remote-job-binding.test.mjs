// Phase 5 fix F4 (REQ-P5-11, D8): jobs_submit and job_cancel apply the session binding of the
// workspace like every other write, and journal the hub's request_id. Private temporary state,
// a stub ledger and no job ever runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { registerJobTools } from '../server/tools/job-tools.mjs';
import { parseRemotePolicy } from '../bridge/write-gate.mjs';
import { stubLedger, tempStateDir } from './helpers/coordinator-fixture.mjs';

const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);

async function fixture(t, mode) {
  const rt = createRuntime({ stateDir: await tempStateDir(t), principal: CHAT, ledger: stubLedger(), host: 'mac' });
  t.after(() => rt.close());
  const tools = {};
  registerJobTools({ registerTool(name, def, handler) { tools[name] = { def, handler }; } }, () => rt,
    { remotePolicy: parseRemotePolicy({ projects: ['drop'], session_binding: mode }) });
  const call = async (name, args, meta) => JSON.parse((await tools[name].handler(tools[name].def.inputSchema.parse(args), meta ? { meta } : undefined)).content[0].text);
  const ws = `ws_${randomBytes(12).toString('base64url')}`;
  const job = `job_${randomBytes(12).toString('base64url')}`;
  await rt.store().transaction(r => {
    r.insertWorkspace({ id: ws, principal: CHAT.id, client_type: 'chatgpt', project_id: 'drop', host: 'mac', status: 'active',
      created_at: Date.now(), updated_at: Date.now(), client_session: S1 });
    r.insertWorktree({ id: 'wt_1', workspace_id: ws, project_id: 'drop', host: 'mac', path: '/nonexistent', branch: 'agent/7-x',
      base_ref: 'origin/main', base_commit: 'c'.repeat(40), issue_ref: null, created_at: Date.now(), updated_at: Date.now() });
    r.insertJob({ id: job, workspace_id: ws, worktree_id: 'wt_1', project_id: 'drop', host: 'mac', recipe: 'test', argv_json: '[]',
      timeout_ms: 1000, log_path: '/l', created_at: Date.now() });
  });
  const status = () => rt.store().transaction(r => r.getJob(job).status, { write: false });
  const events = () => rt.store().transaction(r => r.listEvents({ limit: 50 }), { write: false });
  return { rt, call, ws, job, status, events };
}

test('fix F4 block: jobs_submit and job_cancel from another conversation are refused and journaled with the request id', async t => {
  const f = await fixture(t, 'block');
  const submit = await f.call('jobs_submit', { workspace_id: f.ws, worktree_id: 'wt_AAAAAAAAAAAAAAAA', recipe: 'test' },
    { client_session: S2, request_id: 'rq_submit_0001' });
  assert.deepEqual(submit, { ok: false, error: 'session_mismatch' });
  const cancel = await f.call('job_cancel', { job_id: f.job }, { client_session: S2, request_id: 'rq_cancel_0001' });
  assert.deepEqual(cancel, { ok: false, error: 'session_mismatch' });
  assert.equal(await f.status(), 'queued', 'the job was not cancelled');
  const journal = await f.events();
  for (const [op, rq] of [['jobs_submit', 'rq_submit_0001'], ['job_cancel', 'rq_cancel_0001']]) {
    assert.ok(journal.some(e => e.op === op && e.outcome === 'denied' && e.code === 'session_mismatch' && JSON.stringify(e).includes(rq)),
      `${op}: ${JSON.stringify(journal)}`);
  }
  // The bound conversation itself still cancels.
  const own = await f.call('job_cancel', { job_id: f.job }, { client_session: S1 });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.session_warning, undefined);
});

test('fix F4 warn: job_cancel from another conversation goes on with session_warning; no session presented, no check', async t => {
  const f = await fixture(t, 'warn');
  const res = await f.call('job_cancel', { job_id: f.job }, { client_session: S2 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.session_warning, 'session_mismatch');
  const g = await fixture(t, 'block');
  assert.equal((await g.call('job_cancel', { job_id: g.job })).ok, true, 'stdio: no session, no check');
});
