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
// operator_edit waits for `gate` when the test sets one, to observe a call in flight.
async function hubWith(t, { sessionWorkspace, runtime } = {}) {
  const { tlsKey, tlsCert } = tls(t);
  const id = generateAgentIdentity();
  const audit = []; const reached = []; const opened = [];
  const ctl = { gate: null };
  const verifyWorkspace = async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'ops' } });
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: runtime?.publicKey ?? generateAgentIdentity().publicKey, 'operator-mac': id.publicKey },
    operator: { signingKeyPem: operatorKeys().privateKeyPem, anchorIntervalMs: 0, verifyWorkspace,
      ...(sessionWorkspace === null ? {} : { sessionWorkspace: sessionWorkspace ?? (async (principal, session) => { opened.push(session); return { ok: true, workspace_id: `ws_auto${session.slice(0, 12)}` }; }) }) } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const record = op => async args => { reached.push({ op, args }); if (ctl.gate) await ctl.gate; return { ok: true, op }; };
  const agent = createAgent({ host: 'operator-mac', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-mac', online: true }), operator_run: record('operator_run'), operator_edit: record('operator_edit'),
      operator_script: record('operator_script') } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('operator-mac')?.version === 2);
  const call = (op, args, session) => hub.requestOperator(op === 'operator_script' ? 'mac' : undefined, op,
    { args: op === 'operator_script' ? { host: 'mac', ...args } : args, principal: CHAT, clientSession: session });
  return { hub, audit, reached, opened, call, ctl, port, tlsCert };
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
  // A command that can write is not a read: the other conversation's lock refuses it, with a next step.
  const refused = await s.call('operator_run', { argv: ['touch', '/Users/memo/x'], cwd: '/Users/memo' }, SA);
  assert.equal(refused.error, 'locked_by_other_session');
  assert.match(refused.next_step, /tell the owner/);
});

test('RR-17 hub: a remote write just works: the chat\'s existing workspace, an implicit lock held for the call only, journaled', async t => {
  const s = await hubWith(t);
  // Bench 20:04: "create ~/memolabs/workspace/bench-mb/note.md on the Mac" in one call.
  const out = await s.call('operator_edit', { path: '~/memolabs/workspace/bench-mb/note.md', mode: 'write', new_text: 'x', create: true }, SA);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.auto.workspace_id, `ws_auto${SA.slice(0, 12)}`);
  assert.equal(out.auto.workspace_opened, undefined);
  assert.ok(s.audit.some(e => e.event === 'lock_implicit' && e.kinds.includes('path')));
  assert.equal(s.hub.operatorLocks.size, 0, 'the implicit lock is released after the call');
  assert.equal(s.reached[0].args.workspace_id, undefined, 'the workspace never reaches the agent');
  // The same chat again: the workspace is remembered, not reopened.
  assert.equal((await s.call('operator_edit', { path: '~/memolabs/a.md', mode: 'write', new_text: 'y', create: true }, SA)).ok, true);
  assert.equal(s.opened.length, 1, 'looked up once per chat');
  // While a call is in flight, its target is held: another chat on it is refused, elsewhere it runs.
  let open; s.ctl.gate = new Promise(r => { open = r; });
  const slow = s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'x' }, SA);
  await until(() => s.hub.operatorLocks.size === 1);
  const blocked = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'y' }, SB);
  assert.equal(blocked.error, 'locked_by_other_session');
  s.ctl.gate = null;
  assert.equal((await s.call('operator_edit', { path: '/Users/memo/other/b.md', mode: 'append', new_text: 'y' }, SB)).ok, true);
  open();
  assert.equal((await slow).ok, true);
  assert.equal(s.hub.operatorLocks.size, 0);
  // Root calls, scripts and commands without cwd take the global lock implicitly, for the call.
  assert.equal((await s.call('operator_run', { argv: ['touch', '/Users/memo/y'] }, SA)).ok, true);
  // A script passes the lock gate and then waits for the owner (no bot here: fail closed), lock released.
  assert.equal((await s.call('operator_script', { interpreter: 'bash', content: 'echo hi' }, SA)).error, 'approval_unavailable');
  assert.equal((await s.hub.requestOperator('mac', 'operator_run', { args: { host: 'mac', argv: ['id'], as_root: true }, principal: CHAT, clientSession: SA })).ok, true);
  assert.ok(s.audit.filter(e => e.event === 'lock_implicit').some(e => e.kinds.includes('global')));
  assert.equal(s.hub.operatorLocks.size, 0);
  // An explicit lock stays available for long work, and is kept.
  assert.equal((await s.hub.requestOperator('mac', 'operator_lock', { args: { host: 'mac', workspace_id: out.auto.workspace_id, kind: 'path', target: '/Users/memo/long' },
    principal: CHAT, clientSession: SA })).ok, true);
  assert.equal((await s.call('operator_edit', { workspace_id: out.auto.workspace_id, path: '/Users/memo/long/f', mode: 'append', new_text: 'x' }, SA)).ok, true);
  assert.equal(s.hub.operatorLocks.size, 1);
  // No session hint (owner decision 2026-10-23): the call runs anyway, under a lock for this call only.
  const blind = await s.call('operator_edit', { path: '/Users/memo/other/b.md', mode: 'append', new_text: 'x' }, undefined);
  assert.equal(blind.ok, true, JSON.stringify(blind));
  assert.equal(s.hub.operatorLocks.size, 1, 'only the explicit lock remains');
});

// Owner decision 2026-10-23 ("ça me crée un workspace"): an operator call never opens a workspace.
// The hub asks the runtime only whether the chat already has one.
test('RR-17 hub: a remote write never asks the runtime to open a workspace', async t => {
  const id = generateAgentIdentity();
  const asked = [];
  const s = await hubWith(t, { sessionWorkspace: null, runtime: id });
  const runtime = createAgent({ host: 'vps', url: `wss://127.0.0.1:${s.port}/agent`, privateKey: id.privateKey, ca: s.tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'vps', online: true }),
      sessions_overview: async () => { asked.push('sessions_overview'); return { ok: true, you: { workspaces: [] } }; },
      workspace_open: async () => { asked.push('workspace_open'); return { ok: true, workspace: { workspace_id: 'ws_opened00000001' } }; } } });
  t.after(() => runtime.stop());
  await until(() => s.hub.agentInfo('vps')?.version === 2);
  const out = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'x' }, SA);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(asked.includes('workspace_open'), false);
  assert.notEqual(out.auto.workspace_id, 'ws_opened00000001');
  assert.equal(s.audit.some(e => e.event === 'workspace_auto_open'), false);
});

test('RR-17 hub: when the runtime cannot give a workspace, the session still gets a coordination id and the call runs', async t => {
  const s = await hubWith(t, { sessionWorkspace: async () => ({ ok: false, error: 'not_allowed' }) });
  const out = await s.call('operator_edit', { path: '/Users/memo/notes/a.md', mode: 'append', new_text: 'x' }, SA);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.auto.workspace_id, /^ws_[A-Za-z0-9_-]{16}$/);
  assert.ok(s.audit.some(e => e.event === 'workspace_implicit' && e.code === 'not_allowed'));
  // A different chat gets a different id, so their implicit locks still conflict.
  const other = await s.call('operator_edit', { path: '/Users/memo/notes/b.md', mode: 'append', new_text: 'x' }, SB);
  assert.notEqual(other.auto.workspace_id, out.auto.workspace_id);
});

test('RR-14: instructions and skills teach approval-free execution, read-only paths and safety checks', async () => {
  const { OPERATOR_FLOW_INSTRUCTIONS } = await import('../server/instructions.mjs');
  const { REMOTE_INSTRUCTIONS } = await import('../bridge/remote-surface.mjs');
  const { readFileSync: read } = await import('node:fs');
  const skill = read(new URL('../plugin/skills/memo-bridge-operations/SKILL.md', import.meta.url), 'utf8');
  const doc = read(new URL('../docs/OPERATOR.md', import.meta.url), 'utf8');
  assert.ok(REMOTE_INSTRUCTIONS.includes(OPERATOR_FLOW_INSTRUCTIONS));
  // Owner decision 2026-10-23: approvals off, the model never asks first.
  for (const word of ['no approval step', 'Do not request an operator_grant', 'ps', 'git status', 'gh pr merge', 'force push', 'as_root', 'root on lab']) {
    assert.ok(OPERATOR_FLOW_INSTRUCTIONS.includes(word), word);
  }
  for (const word of ['operator_grant', 'operator_docker', 'read-only commands']) assert.ok(skill.includes(word), `skill: ${word}`);
  assert.ok(skill.includes('Approvals are off on both hosts'), 'no stale per-session Telegram approval instruction in skill');
  assert.ok(!skill.includes('Start a work session with ONE'), 'obsolete grant instruction must be removed');
  const guide = read(new URL('../docs/CHATGPT_GUIDE.md', import.meta.url), 'utf8');
  assert.ok(guide.includes("N'appelle pas operator_grant"), 'guide must explain approval-free workflow');
  assert.ok(!guide.includes('Je valide dans Telegram'), 'guide must not ask for Telegram confirmation');
  const security = read(new URL('../docs/HUB_SECURITY.md', import.meta.url), 'utf8');
  assert.ok(security.includes('80-operator.conf'), 'live hub override must be documented');
  for (const word of ['Standing approvals', '/grant', '/revoke', 'operator_docker', 'Read-only commands']) assert.ok(doc.includes(word), `doc: ${word}`);
  for (const text of [OPERATOR_FLOW_INSTRUCTIONS, skill, doc]) assert.equal(/[\u2013\u2014]/.test(text), false, 'no dashes');
});
