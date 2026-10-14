// Repatriation (spec .agent/project/repatriate, RR-8, RR-9, RR-11, D-R6 to D-R8): user scripts on
// both hosts, process groups killed at the timeout and at exit for every user run, and the user
// run environment (HOME, run_path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createOperatorExecTools, userRunEnv } from '../bridge/operator-exec.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { parseOperatorPolicy } from '../bridge/operator-policy.mjs';
import { runArgv } from '../bridge/operator-tools.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorCallTier } from '../server/coordinator/policy.mjs';
import { operatorTargets } from '../bridge/operator-locks.mjs';
import { makeHost } from './helpers/operator-fixture.mjs';

function exec(t, host = 'vps', extra = {}) {
  const h = makeHost(t, { host, policy: { max_tier: 'exec', run_env_allow: ['MY_FLAG'] } });
  const jobs = createJobStore({ dir: h.p('state/jobs') });
  return { ...h, jobs, tools: createOperatorExecTools(h.policy, { jobs, platform: host === 'mac' ? 'darwin' : 'linux', ...extra }) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 50)); }
}

test('RR-9: a grandchild dies with its run, at the timeout and when the program exits (foreground)', async () => {
  const timed = await runArgv(['/bin/bash', '-c', 'sleep 300 & echo $!; wait'], { timeoutMs: 800 });
  assert.equal(timed.timedOut, true);
  const pid1 = Number(timed.stdout.trim());
  assert.ok(pid1 > 0);
  await until(() => !alive(pid1), 3000);
  const exited = await runArgv(['/bin/bash', '-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { timeoutMs: 10_000 });
  assert.equal(exited.timedOut, false);
  const pid2 = Number(exited.stdout.trim());
  await until(() => !alive(pid2), 3000);
});

test('RR-9: background user runs kill their group too, and say so in the job', async t => {
  const { tools, jobs } = exec(t);
  const started = await tools.operator_run({ argv: ['/bin/bash', '-c', 'sleep 300 & echo $!; wait'], timeout_s: 1, background: true });
  assert.equal(started.status, 'running');
  const done = await until(async () => { const s = await tools.operator_job_status({ job_id: started.job_id }); return s.status === 'done' ? s : null; });
  assert.equal(done.timed_out, true);
  const pid = Number(done.untrusted_content.stdout.trim());
  await until(() => !alive(pid), 3000);
  assert.ok(jobs);
});

test('RR-8: operator_script as the agent user: bash, sh, python3, node; args, cwd, env allowlist; the file is removed', async t => {
  const { tools, p } = exec(t);
  const bash = await tools.operator_script({ interpreter: 'bash', content: 'echo "$1|$PWD|$MY_FLAG|$(id -un)"', args: ['a b'], cwd: p('srv/rw'),
    env: { MY_FLAG: 'on' } });
  assert.equal(bash.ok, true, JSON.stringify(bash));
  assert.equal(bash.untrusted_content.stdout.trim().split('|').slice(0, 3).join('|'), `a b|${p('srv/rw')}|on`);
  const sh = await tools.operator_script({ interpreter: 'sh', content: 'echo sh-ok' });
  assert.equal(sh.untrusted_content.stdout, 'sh-ok\n');
  const py = await tools.operator_script({ interpreter: 'python3', content: 'import sys\nprint(sys.argv[1:])', args: ['x'] });
  assert.equal(py.untrusted_content.stdout, "['x']\n");
  const node = await tools.operator_script({ interpreter: 'node', content: 'console.log(40 + 2)' });
  assert.equal(node.untrusted_content.stdout, '42\n');
  assert.deepEqual(readdirSync(p('state/scripts')), [], 'scripts removed after the run');
  // Refusals: an env name the policy does not allow, a cwd outside the roots, root here.
  assert.equal((await tools.operator_script({ interpreter: 'bash', content: 'id', env: { PATH: '/tmp' } })).error, 'env_not_allowed');
  assert.equal((await tools.operator_script({ interpreter: 'bash', content: 'id', cwd: p('outside') })).ok, false);
  assert.equal((await tools.operator_script({ interpreter: 'bash', content: 'id', as_root: true })).error, 'root_unavailable_on_host');
  assert.equal((await tools.operator_script({ interpreter: 'bash', content: 'exit 0', timeout_s: 601 })).error, 'timeout_too_long');
  // The timeout kills the script's whole group and keeps the partial output.
  const slow = await tools.operator_script({ interpreter: 'bash', content: 'echo started; sleep 300 & echo $!; wait', timeout_s: 1 });
  assert.equal(slow.timed_out, true);
  const [first, pid] = slow.untrusted_content.stdout.trim().split('\n');
  assert.equal(first, 'started');
  await until(() => !alive(Number(pid)), 3000);
});

test('RR-8: a background user script returns its result and its file is removed by the supervisor', async t => {
  const { tools, p } = exec(t, 'mac');
  const started = await tools.operator_script({ interpreter: 'bash', content: 'echo bg-$1', args: ['done'], background: true, timeout_s: 30 });
  assert.equal(started.status, 'running');
  const done = await until(async () => { const s = await tools.operator_job_status({ job_id: started.job_id }); return s.status === 'done' ? s : null; });
  assert.equal(done.untrusted_content.stdout, 'bg-done\n');
  await until(() => readdirSync(p('state/scripts')).length === 0, 3000);
});

test('RR-8: schema, tier and lock: user scripts are T2 with a path lock on cwd; as_root is T3 with a global lock', () => {
  const ok = OPERATOR_SCHEMAS.operator_script.safeParse({ host: 'mac', interpreter: 'zsh', content: 'print hi', cwd: '~/memolabs', env: { MY_FLAG: '1' } });
  assert.equal(ok.success, true);
  assert.equal(OPERATOR_SCHEMAS.operator_script.safeParse({ host: 'mac', interpreter: 'perl', content: 'x' }).success, false);
  assert.equal(OPERATOR_SCHEMAS.operator_script.safeParse({ host: 'mac', interpreter: 'bash', content: 'x'.repeat(64 * 1024 + 1) }).success, false);
  assert.equal(operatorCallTier('operator_script', { interpreter: 'bash' }), 2);
  assert.equal(operatorCallTier('operator_script', { interpreter: 'bash', as_root: true }), 3);
  assert.deepEqual(operatorTargets('operator_script', { host: 'mac', cwd: '~/memolabs/x' }).map(x => x.kind), ['path']);
  assert.deepEqual(operatorTargets('operator_script', { host: 'mac', cwd: '~/memolabs/x', as_root: true }).map(x => x.kind), ['global']);
  assert.deepEqual(operatorTargets('operator_script', { host: 'mac' }).map(x => x.kind), ['global']);
});

test('RR-11: user runs get HOME, USER and run_path first in PATH; run_path entries are absolute without ":"', async t => {
  const h = makeHost(t, { host: 'mac', policy: { max_tier: 'exec', run_path: ['~/bin-a', '/opt/homebrew/bin'] } });
  const env = userRunEnv(h.policy, { processEnv: { SSH_AUTH_SOCK: '/tmp/agent.sock', HOME: '/ignored' }, user: { homedir: '/Users/memo', username: 'memo' } });
  assert.equal(env.PATH.split(':')[0], h.p('home/op/bin-a'));
  assert.equal(env.PATH.split(':')[1], '/opt/homebrew/bin');
  assert.ok(env.PATH.endsWith('/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin:/usr/local/bin'));
  assert.deepEqual([env.HOME, env.USER, env.LOGNAME, env.SSH_AUTH_SOCK], ['/Users/memo', 'memo', 'memo', '/tmp/agent.sock']);
  assert.equal(userRunEnv(h.policy, { processEnv: { SSH_AUTH_SOCK: 'relative' }, user: null }).SSH_AUTH_SOCK, undefined);
  const out = await createOperatorExecTools(h.policy, { platform: 'darwin' }).operator_run({ argv: ['/usr/bin/env'] });
  assert.match(out.untrusted_content.stdout, /^HOME=\//m);
  for (const bad of [['relative/bin'], ['/a:/b'], ['/x/../y']]) {
    assert.throws(() => parseOperatorPolicy({ ...h.raw, run_path: bad }, { home: h.p('home/op') }), /invalid_operator_policy:run_path/, bad[0]);
  }
  assert.ok(!existsSync(h.p('state/scripts')));
});
