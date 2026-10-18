// Phase 6, TODO-P6-09 (R-P6-03, R-P6-12, R-P6-13; AC-P6-01, AC-P6-12 background part): T2
// operator_run as the agent user, argv without a shell, environment allowlist, working directory
// guard, timeouts, and background runs stored on disk and read back by a new agent instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRun, createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { parseOperatorPolicy } from '../bridge/operator-policy.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { makeHost } from './helpers/operator-fixture.mjs';

function exec(t, extra = {}) {
  const h = makeHost(t, { policy: { max_tier: 'exec', run_env_allow: ['MY_FLAG'], units: ['traefik.service'] } });
  const jobs = createJobStore({ dir: h.p('state/jobs') });
  return { ...h, jobs, tools: createOperatorExecTools(h.policy, { jobs, platform: 'linux', ...extra }) };
}
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 50)); }
}

test('AC-P6-01: argv ["echo", "a;id"] prints a;id and runs no id', async t => {
  const { tools } = exec(t);
  const out = await tools.operator_run({ argv: ['echo', 'a;id'] });
  assert.equal(out.ok, true);
  assert.equal(out.exit_code, 0);
  assert.equal(out.untrusted_content.stdout, 'a;id\n');
  const more = await tools.operator_run({ argv: ['echo', '$(id)', '|', 'id', '`id`', 'x\nid'] });
  assert.equal(more.untrusted_content.stdout, '$(id) | id `id` x\nid\n');
  assert.doesNotMatch(more.untrusted_content.stdout, /uid=/);
  // A shell line as argv[0] is a program name that does not exist, never a shell.
  assert.equal((await tools.operator_run({ argv: ['echo a; id'] })).error, 'program_not_found');
  assert.equal((await tools.operator_run({ argv: ['./relative'] })).error, 'invalid_program');
});

test('environment allowlist, timeouts, working directory guard', async t => {
  const { tools, p, raw } = exec(t);
  const env = await tools.operator_run({ argv: ['/usr/bin/env'], env: { MY_FLAG: 'on', LANG: 'C' } });
  assert.match(env.untrusted_content.stdout, /MY_FLAG=on/);
  assert.doesNotMatch(env.untrusted_content.stdout, /CREDENTIALS_DIRECTORY|GH_TOKEN/);
  for (const name of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'OTHER']) {
    assert.equal((await tools.operator_run({ argv: ['true'], env: { [name]: 'x' } })).error, 'env_not_allowed', name);
  }
  assert.equal((await tools.operator_run({ argv: ['true'], timeout_s: 601 })).error, 'timeout_too_long');
  const slow = await tools.operator_run({ argv: ['sleep', '5'], timeout_s: 1 });
  assert.deepEqual([slow.ok, slow.timed_out], [true, true]);
  // cwd: inside the read roots, a directory, not a default-branch checkout (D11).
  assert.equal((await tools.operator_run({ argv: ['pwd'], cwd: p('outside') })).error, 'path_not_allowed');
  assert.equal((await tools.operator_run({ argv: ['pwd'], cwd: p('home/op/.ssh') })).error, 'path_secret');
  const ok = await tools.operator_run({ argv: ['pwd'], cwd: p('srv/app') });
  assert.equal(ok.untrusted_content.stdout.trim(), p('srv/app'));
  const checkout = p('srv/rw/project');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(p('srv/rw/PROJECTS.md'), ['# r', '## Projets appartenant à Memo Labs', '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
    '|---|---|---|---|---|---|---|', '| project | project | repo | active | infra | Node.js | - |', '## Dépôts de référence'].join('\n'));
  const guarded = createOperatorExecTools(parseOperatorPolicy({ ...raw, max_tier: 'exec', repositories: { projects_root: p('srv/rw'), layout_root: p('srv/rw') } }));
  // D11: a write-capable command in a default-branch checkout goes to the worktree flow.
  assert.equal((await guarded.operator_run({ argv: ['git', 'commit', '-m', 'x'], cwd: checkout })).error, 'use_dev_flow');
  // A read-only command cannot edit tracked code: it runs, with the read roots and the secret
  // denylist applying exactly as everywhere else (2026-10-18, owner console golden prompt D13).
  const inspected = await guarded.operator_run({ argv: ['pwd'], cwd: checkout });
  assert.equal(inspected.untrusted_content.stdout.trim(), checkout);
  // as_root never runs here: the agent sends it to the root helper (or answers this on the Mac).
  assert.equal((await tools.operator_run({ argv: ['id'], as_root: true })).error, 'root_unavailable_on_host');
  assert.equal(checkRun({ argv: ['x'], timeout_s: 3600, background: true }, { runEnvAllow: [] }).ok, true);
  assert.equal(checkRun({ argv: ['x'], timeout_s: 3601, background: true }, { runEnvAllow: [] }).ok, false);
  assert.equal(OPERATOR_SCHEMAS.operator_run.safeParse({ host: 'vps', argv: [] }).success, false);
  assert.equal(OPERATOR_SCHEMAS.operator_run.safeParse({ host: 'vps', argv: ['a'], timeout_s: 3601 }).success, false);
});

test('AC-P6-12 (background): the job is on disk before the answer, the result is written before it is read, a restarted agent reads it', async t => {
  const { tools, jobs, p, policy } = exec(t);
  const started = await tools.operator_run({ argv: [process.execPath, '-e', 'setTimeout(() => console.log("done after a while"), 800)'],
    background: true, timeout_s: 900 });
  assert.equal(started.status, 'running');
  const dir = p('state/jobs', started.job_id);
  assert.equal(existsSync(join(dir, 'job.json')), true, 'job.json written before the answer');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')).argv[0], process.execPath);
  assert.equal((await tools.operator_job_status({ job_id: started.job_id })).status, 'running');
  // "Restart": a new store and a new tool set over the same state directory.
  const restarted = createOperatorExecTools(policy, { jobs: createJobStore({ dir: p('state/jobs') }) });
  const done = await until(async () => { const s = await restarted.operator_job_status({ job_id: started.job_id }); return s.status === 'done' ? s : null; });
  assert.equal(done.exit_code, 0);
  assert.equal(done.untrusted_content.stdout, 'done after a while\n');
  assert.equal(existsSync(join(dir, 'result.json')), true);
  // Unknown and malformed ids.
  assert.equal((await restarted.operator_job_status({ job_id: 'j_' + 'a'.repeat(22) })).error, 'unknown_job');
  assert.equal((await jobs.status('rj_' + 'a'.repeat(22))).error, 'unknown_job', 'root job ids are not the agent store\'s');
});

test('a job whose supervisor is gone without a result is reported lost; a job that times out says so', async t => {
  const { p } = exec(t);
  const store = createJobStore({ dir: p('state/jobs'), launch: () => {}, now: () => Date.now() + 60_000 });
  const { job_id: id } = await store.start({ op: 'operator_run', argv: ['true'], cwd: '/', env: {}, timeout_s: 5 });
  writeFileSync(p('state/jobs', id, 'pid'), '999999');
  assert.equal((await store.status(id)).status, 'lost');
  const real = createJobStore({ dir: p('state/jobs') });
  const { job_id: slow } = await real.start({ op: 'operator_run', argv: ['sleep', '10'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, timeout_s: 1 });
  const s = await until(async () => { const v = await real.status(slow); return v.status === 'done' ? v : null; });
  assert.equal(s.timed_out, true);
});

test('operator_service: declared units only, fixed argv, linux only', async t => {
  const calls = [];
  const { tools } = exec(t, { run: async argv => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal((await tools.operator_service({ unit: 'ssh.service', action: 'stop' })).error, 'unit_not_declared');
  assert.equal((await tools.operator_service({ unit: 'traefik.service; reboot', action: 'restart' })).error, 'unit_not_declared');
  assert.equal((await tools.operator_service({ unit: 'traefik.service', action: 'restart' })).ok, true);
  assert.deepEqual(calls, [['systemctl', '--no-ask-password', 'restart', 'traefik.service']]);
  const mac = createOperatorExecTools(exec(t).policy, { platform: 'darwin' });
  assert.equal((await mac.operator_service({ unit: 'traefik.service', action: 'restart' })).error, 'systemd_unavailable_on_host');
});

test('rate limits per tier: T2 and T3 have their own per-minute budgets (policy rate_limits)', async t => {
  const { createOperatorGuard } = await import('../bridge/operator-guard.mjs');
  const h = makeHost(t, { policy: { max_tier: 'exec', rate_limits: { exec: 2, root: 1, write: 5 } } });
  let now = 1_000_000;
  const guard = createOperatorGuard(h.policy, { now: () => now });
  assert.deepEqual([guard.admit(2), guard.admit(2), guard.admit(2)], [null, null, 'rate_limited']);
  assert.deepEqual([guard.admit(3), guard.admit(3)], [null, 'rate_limited']);
  assert.equal(guard.admit(1), null, 'tiers are counted apart');
  assert.equal(guard.admit(0), null);
  now += 60_001;
  assert.deepEqual([guard.admit(2), guard.admit(3)], [null, null]);
  // Defaults from spec D6: write 120, exec 60, root 20 per minute.
  assert.deepEqual({ ...makeHost(t).policy.rateLimits }, { write: 120, exec: 60, root: 20 });
});
