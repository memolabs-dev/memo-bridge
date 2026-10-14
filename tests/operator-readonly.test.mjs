// Repatriation (spec .agent/project/repatriate, RR-16, RR-17, D-R13, D-R14), from the live bench of
// 2026-10-14 19:57: "the 5 most CPU-hungry processes on the Mac" failed with workspace_required.
// Read-only commands need no workspace, no lock and no approval, with their paths checked by the
// agent; a remote write without a workspace gets the conversation's own (or a new one) and a lock
// on what it touches, or one explicit next step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dangerReason, readOnlyCommand } from '../bridge/operator-dangerous.mjs';
import { createOperatorExecTools, hardenReadOnlyGit } from '../bridge/operator-exec.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { makeHost, operatorKeys } from './helpers/operator-fixture.mjs';

const CHAT = makePrincipal('oidc:owner-sub', Object.values(CAPABILITIES), { client_type: 'chatgpt', via: 'hub' });
const SA = 'a'.repeat(32);
const SB = 'b'.repeat(32);

test('RR-16 classifier: read-only shapes pass, anything that can write or start a program does not', () => {
  const ro = [['ps', '-Ao', 'pid,pcpu,comm', '-r'], ['top', '-l', '1', '-o', 'cpu', '-n', '5'], ['uptime'], ['vm_stat'], ['df', '-h'], ['du', '-sh', '.'],
    ['ls', '-la'], ['stat', 'x'], ['file', 'x'], ['wc', '-l', 'x'], ['head', '-n', '5', 'x'], ['tail', 'x'], ['cat', 'x'], ['grep', '-rn', 'x', '.'],
    ['rg', 'x'], ['find', '.', '-name', '*.md'], ['git', 'status'], ['git', 'log', '-5', '--oneline'], ['git', 'diff', 'HEAD~1'], ['git', 'show', 'HEAD'],
    ['git', 'branch', '-a'], ['git', '-C', '/repo', 'status'], ['gh', 'pr', 'view', '1'], ['gh', 'run', 'list'], ['gh', 'api', 'repos/o/r'],
    ['uname', '-a'], ['sw_vers'], ['system_profiler', 'SPHardwareDataType'], ['launchctl', 'list'], ['launchctl', 'print', 'gui/501/x'],
    ['systemctl', 'status', 'ssh'], ['journalctl', '-u', 'x', '-n', '50'], ['docker', 'ps'], ['docker', 'logs', 'x'], ['free', '-m'],
    ['ip', 'addr'], ['ss', '-tlnp'], ['hostname'], ['date', '+%s'], ['sysctl', 'hw.ncpu']];
  for (const argv of ro) {
    assert.ok(readOnlyCommand(argv), argv.join(' '));
    assert.equal(dangerReason('operator_run', { argv }), null, argv.join(' '));
  }
  const not = [['top'], ['sed', '-i', 's/a/b/', 'f'], ['find', '.', '-delete'], ['find', '.', '-exec', 'rm', '{}', ';'], ['git', 'push'],
    ['git', 'commit', '-m', 'x'], ['git', '-c', 'core.pager=sh -c id', 'log'], ['git', 'diff', '--ext-diff'], ['git', 'branch', '-D', 'x'],
    ['git', 'branch', 'newbranch'], ['git', 'tag', 'v1'], ['git', 'config', 'user.name', 'x'], ['git', 'stash'], ['git', 'grep', '-O', 'x'],
    ['gh', 'pr', 'merge', '1'], ['gh', 'pr', 'view', '1', '--web'], ['gh', 'api', 'repos/o/r/issues', '-f', 'title=x'], ['gh', 'api', '-X', 'POST', 'x'],
    ['launchctl', 'kickstart', '-k', 'gui/501/x'], ['systemctl', 'restart', 'x'], ['journalctl', '--vacuum-size=1M'], ['docker', 'run', 'x'],
    ['docker', 'compose', 'up'], ['ip', 'addr', 'add', '1.2.3.4/32', 'dev', 'lo'], ['ss', '-K', 'dst', '1.2.3.4'], ['hostname', 'evil'],
    ['date', '010100002030'], ['sysctl', '-w', 'a=1'], ['system_profiler'], ['rg', '--pre', 'sh', 'x'], ['sort', '-o', 'out', 'in'], ['tree', '-o', 'out'],
    ['bash', '-c', 'ps'], ['python3', '-c', 'print(1)'], ['curl', 'https://x']];
  for (const argv of not) assert.equal(readOnlyCommand(argv), null, argv.join(' '));
  assert.notEqual(dangerReason('operator_run', { argv: ['git', 'push'] }), null, 'mutating git stays a wrapper');
  assert.notEqual(dangerReason('operator_run', { argv: ['ps'], as_root: true }), 'unrelated');
});

test('RR-16 agent: read-only paths go through the read roots and the denylist; read-only git runs hardened', async t => {
  const h = makeHost(t, { policy: { max_tier: 'exec' } });
  const tools = createOperatorExecTools(h.policy, { platform: 'linux', projects: async () => [] });
  const ok = await tools.operator_run({ argv: ['cat', h.p('srv/app/notes.md')] });
  assert.equal(ok.ok, true);
  assert.equal((await tools.operator_run({ argv: ['cat', h.p('srv/app/.env')] })).error, 'path_secret');
  assert.equal((await tools.operator_run({ argv: ['cat', '.env'], cwd: h.p('srv/app') })).error, 'path_secret', 'relative to cwd');
  assert.equal((await tools.operator_run({ argv: ['head', h.p('home/op/innocent')] })).error, 'path_secret', 'a symlink into .ssh');
  assert.equal((await tools.operator_run({ argv: ['grep', '-r', 'x', h.p('outside')] })).error, 'path_not_allowed');
  assert.equal((await tools.operator_run({ argv: ['grep', '--file=' + h.p('home/op/keys/server.pem'), 'x'] })).error, 'path_secret');
  assert.equal((await tools.operator_run({ argv: ['wc', '-l', 'missing.txt'], cwd: h.p('srv/app') })).ok, true, 'a missing file is the program\'s to report');
  const g = hardenReadOnlyGit(['git', '-C', '/r', 'diff', 'HEAD'], { A: '1' });
  assert.deepEqual(g.argv, ['git', '-C', '/r', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepEqual([g.env.GIT_CONFIG_KEY_0, g.env.GIT_CONFIG_VALUE_0, g.env.GIT_OPTIONAL_LOCKS, g.env.A], ['core.fsmonitor', 'false', '0', '1']);
  assert.deepEqual(hardenReadOnlyGit(['git', 'status'], {}).argv, ['git', 'status']);
});

function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-op-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

// A hub with a fake Mac operator agent that records what reaches it, and a stubbed runtime.
async function hubWith(t, { sessionWorkspace } = {}) {
  const { tlsKey, tlsCert } = tls(t);
  const id = generateAgentIdentity();
  const audit = []; const reached = []; const opened = [];
  const verifyWorkspace = async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'ops' } });
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey, 'operator-mac': id.publicKey },
    operator: { signingKeyPem: operatorKeys().privateKeyPem, anchorIntervalMs: 0, verifyWorkspace,
      sessionWorkspace: sessionWorkspace ?? (async (principal, session) => { opened.push(session); return { ok: true, workspace_id: `ws_auto${session.slice(0, 12)}`, opened: true, project: 'ops' }; }) } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const record = op => async args => { reached.push({ op, args }); return { ok: true, op }; };
  const agent = createAgent({ host: 'operator-mac', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-mac', online: true }), operator_run: record('operator_run'), operator_edit: record('operator_edit') } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('operator-mac')?.version === 2);
  const call = (op, args, session) => hub.requestOperator(undefined, op, { args, principal: CHAT, clientSession: session });
  return { hub, audit, reached, opened, call };
}

test('RR-16 hub: ps on the Mac from a remote chat needs no workspace and no lock, and is journaled as a read', async t => {
  const s = await hubWith(t);
  const out = await s.call('operator_run', { argv: ['ps', '-Ao', 'pid,pcpu,comm', '-r'] }, SA);
  assert.deepEqual(out, { ok: true, op: 'operator_run', host: 'mac' });
  assert.equal(s.reached.length, 1);
  assert.equal(s.opened.length, 0, 'no workspace opened for a read');
  assert.equal(s.hub.operatorLocks.size, 0);
  assert.ok(s.audit.some(e => e.event === 'operator_call' && e.op === 'operator_run' && e.read_only === true && e.tier === 2));
  // Another conversation's global lock does not block a read either.
  assert.equal((await s.hub.requestOperator('mac', 'operator_lock', { args: { host: 'mac', workspace_id: 'ws_holder0000000001', kind: 'global' }, principal: CHAT, clientSession: SB })).ok, true);
  assert.equal((await s.call('operator_run', { argv: ['git', 'status'], cwd: '/Users/memo/memolabs' }, SA)).ok, true);
  // A command that can write is not a read: it is locked out by the global lock.
  assert.equal((await s.call('operator_run', { argv: ['touch', '/Users/memo/x'], cwd: '/Users/memo' }, SA)).error, 'locked_by_other_session');
});

test('RR-17 hub: a remote write without a workspace gets the chat\'s workspace and a lock, journaled; conflicts and global needs stay explicit', async t => {
  const s = await hubWith(t);
  const out = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'x' }, SA);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.auto.workspace_id, `ws_auto${SA.slice(0, 12)}`);
  assert.equal(out.auto.workspace_opened, true);
  assert.equal(out.auto.locks_taken.length, 1);
  assert.ok(s.audit.some(e => e.event === 'workspace_auto_open' && e.workspace_id === out.auto.workspace_id));
  assert.ok(s.audit.some(e => e.event === 'operator_lock_auto' && e.kind === 'path'));
  assert.equal(s.reached[0].args.workspace_id, undefined, 'the workspace never reaches the agent');
  // A second conversation on the same file: locked out, with the holder.
  const other = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'y' }, SB);
  assert.equal(other.error, 'locked_by_other_session');
  // A command without cwd would need a global lock: never taken automatically, one explicit step.
  const global = await s.call('operator_run', { argv: ['touch', '/Users/memo/y'] }, SA);
  assert.equal(global.error, 'lock_required');
  assert.match(global.next_step, /pass a cwd|kind":"global/);
  // With a cwd it is locked on that path and runs.
  assert.equal((await s.call('operator_run', { argv: ['touch', 'y'], cwd: '/Users/memo/notes' }, SA)).ok, true);
  // No session hint: no binding possible, one explicit next step.
  const blind = await s.call('operator_edit', { path: '/Users/memo/other/b.md', mode: 'append', new_text: 'x' }, undefined);
  assert.equal(blind.error, 'workspace_required');
  assert.match(blind.next_step, /workspace_open/);
});

test('RR-17 hub: when the runtime cannot give a workspace, the answer is one explicit step', async t => {
  const s = await hubWith(t, { sessionWorkspace: async () => ({ ok: false, error: 'not_allowed' }) });
  const out = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'x' }, SA);
  assert.equal(out.error, 'workspace_required');
  assert.match(out.next_step, /^workspace_open \{"project":"ops"\}/);
  assert.equal(s.reached.length, 0);
});
