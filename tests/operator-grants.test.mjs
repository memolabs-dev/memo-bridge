// Repatriation (spec .agent/project/repatriate, RR-4 to RR-7, D-R4, D-R5): standing approvals.
// The store alone, then a real hub, a real operator agent and the Telegram bot behind a fake
// client: one owner approval, then a family of commands runs without asking, the destructive
// list still asks, /approvals lists, /revoke ends it, and the agent refuses a standing id that a
// hub bug would send for a hard call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGrantStore, checkGrantRequest } from '../bridge/operator-grants.mjs';
import { createApprovalStore } from '../bridge/operator-approvals.mjs';
import { createOperatorBot, parseGrantCommand } from '../bridge/operator-telegram.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { makePrincipal, CAPABILITIES } from '../server/coordinator/policy.mjs';
import { makeHost, operatorKeys, signingPair } from './helpers/operator-fixture.mjs';

const OWNER_CHAT = 424242;
const OWNER = makePrincipal('oidc:owner', Object.values(CAPABILITIES));
const WS = 'ws_grantsTests00001';
const verifyWorkspace = async (principal, id) => ({ ok: true, workspace: { workspace_id: id, status: 'active', session_tag: null, project: 'drop' } });
const HOMES = { mac: '/Users/memo' };

test('RR-4 store: a grant covers its programs, under its prefixes, on its host, for its TTL; never T3, never a hard call', () => {
  const clock = { t: 1_800_000_000_000 };
  const g = createGrantStore({ now: () => clock.t, homes: HOMES });
  const req = g.request({ host: 'mac', programs: ['git', 'node', 'pnpm', 'python3', 'make', 'ssh'], cwd_prefixes: ['~/memolabs'], ttl_hours: 8 }, 'oidc:owner');
  assert.equal(req.ok, true);
  const id = req.grant.id;
  assert.match(id, /^ap_st_[A-Za-z0-9_-]{22}$/);
  const call = (argv, extra = {}) => g.covers({ host: 'mac', op: 'operator_run', principal: 'oidc:owner', args: { argv, cwd: '/Users/memo/memolabs/os/app', ...extra } });
  assert.equal(call(['git', 'status']), null, 'pending covers nothing');
  assert.equal(g.decide(id, 'approve').ok, true);
  assert.equal(call(['git', 'status']), id);
  assert.equal(call(['pnpm', 'test']), id);
  assert.equal(call(['ssh', 'lab', 'uptime']), id);
  assert.equal(call(['git', 'status'], { cwd: '/Users/MEMO/Memolabs/x' }), id, 'case folded on the Mac');
  assert.equal(call(['git', 'status'], { cwd: '~/memolabs/x' }), id);
  assert.equal(call(['git', 'status'], { cwd: '/Users/memo/Documents' }), null, 'another directory');
  assert.equal(call(['git', 'status'], { cwd: '/Users/memo/memolabs-evil' }), null, 'a sibling prefix is not inside');
  assert.equal(call(['git', 'status'], { cwd: undefined }), null, 'no cwd, no grant');
  assert.equal(call(['bash', '-c', 'id']), null, 'bash is not named');
  assert.equal(call(['timeout', '5', 'ssh', 'lab', 'id']), null, 'timeout is not named');
  assert.equal(call(['git', 'push', '--force']), null, 'hard: force push');
  assert.equal(call(['gh', 'pr', 'merge', '1']), null, 'hard: merge');
  assert.equal(call(['ssh', 'lab', 'rm', '-rf', '/srv']), null, 'hard: rm');
  assert.equal(call(['git', 'status'], { as_root: true }), null, 'never T3');
  assert.equal(g.covers({ host: 'vps', op: 'operator_run', principal: 'oidc:owner', args: { argv: ['git', 'status'], cwd: '/Users/memo/memolabs' } }), null, 'other host');
  assert.equal(g.covers({ host: 'mac', op: 'operator_run', principal: 'oidc:other', args: { argv: ['git', 'status'], cwd: '/Users/memo/memolabs' } }), null, 'other principal');
  assert.equal(g.covers({ host: 'mac', op: 'operator_script', principal: 'oidc:owner', args: { interpreter: 'python3', content: 'x', cwd: '/Users/memo/memolabs' } }), id);
  assert.equal(g.covers({ host: 'mac', op: 'operator_script', principal: 'oidc:owner', args: { interpreter: 'bash', content: 'x', cwd: '/Users/memo/memolabs' } }), null);
  assert.equal(g.covers({ host: 'mac', op: 'operator_delete', principal: 'oidc:owner', args: { path: '/Users/memo/memolabs/x', recursive: true } }), null);
  assert.equal(g.list('oidc:owner').length, 1);
  clock.t += 8 * 3600_000 + 1;
  assert.equal(call(['git', 'status']), null, 'expired after its TTL');
  // The owner's own grant: active at once, any principal; revocable.
  const own = g.grantByOwner({ host: 'mac', programs: ['git'], cwd_prefixes: ['/Users/memo/work'], ttl_hours: 2 });
  assert.equal(g.covers({ host: 'mac', op: 'operator_run', principal: 'oidc:other', args: { argv: ['git', 'log'], cwd: '/Users/memo/work/a' } }), own.grant.id);
  assert.equal(g.revoke(own.grant.id).ok, true);
  assert.equal(g.covers({ host: 'mac', op: 'operator_run', principal: 'oidc:other', args: { argv: ['git', 'log'], cwd: '/Users/memo/work/a' } }), null);
  // What can never be granted.
  assert.equal(checkGrantRequest({ host: 'mac', programs: ['git'], cwd_prefixes: ['/'] }, { homes: HOMES }).error, 'prefix_too_broad');
  for (const p of ['sudo', 'rm', 'dd', 'mkfs.ext4', 'su']) {
    assert.equal(checkGrantRequest({ host: 'mac', programs: [p], cwd_prefixes: ['~/x'] }, { homes: HOMES }).error, 'program_not_grantable', p);
  }
  assert.equal(checkGrantRequest({ host: 'mac', programs: ['git'], cwd_prefixes: ['~/x'], ttl_hours: 13 }, { homes: HOMES }).error, 'invalid_arguments');
  assert.equal(checkGrantRequest({ programs: ['git'], cwd_prefixes: ['~/x'] }, { homes: HOMES }).error, 'host_required');
  assert.equal(checkGrantRequest({ host: 'mac', programs: ['git'], cwd_prefixes: ['relative'] }, { homes: HOMES }).error, 'invalid_arguments');
});

test('single-use approval ids never take the standing prefix', () => {
  let n = 0;
  // A random source that first yields bytes encoding to "st_...", then normal ones.
  const forced = Buffer.from('st_AAAAAAAAAAAAAAAAAAAAAAAA', 'base64url');
  const store = createApprovalStore({ random: size => (n++ === 0 ? forced.subarray(0, size) : Buffer.alloc(size, 7)) });
  const out = store.request({ host: 'vps', op: 'operator_run', argsSha256: 'a'.repeat(64), principal: 'p' });
  assert.ok(!out.approval.id.startsWith('ap_st_'), out.approval.id);
  assert.equal(n, 2, 'it drew again');
});

test('/grant parsing', () => {
  assert.deepEqual(parseGrantCommand('/grant mac git,node,pnpm ~/memolabs,~/work 8h'),
    { host: 'mac', programs: ['git', 'node', 'pnpm'], cwd_prefixes: ['~/memolabs', '~/work'], ttl_hours: 8 });
  assert.equal(parseGrantCommand('/grant mac git ~/memolabs').ttl_hours, 8);
  assert.equal(parseGrantCommand('/grant mac git'), null);
  assert.ok(Number.isNaN(parseGrantCommand('/grant mac git ~/x forever').ttl_hours));
});

// ------------------------------------------------------------------------------------------
// Live: a real hub, a real operator agent on a temporary host, the bot behind a fake client.

function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-op-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
function fakeTelegram() {
  const sent = []; const answered = []; const queue = [];
  return { sent, answered, queue, client: {
    sendMessage: async p => { sent.push(p); return { message_id: sent.length }; },
    getUpdates: async () => queue.splice(0),
    answerCallbackQuery: async p => { answered.push(p); return true; },
    editMessageText: async () => true
  } };
}
async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

async function stack(t) {
  const host = makeHost(t, { policy: { max_tier: 'exec', approval_mode: 'dangerous' } });
  mkdirSync(host.p('srv/rw/proj'), { recursive: true });
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const id = generateAgentIdentity();
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey, 'operator-vps': id.publicKey },
    operator: { signingKeyPem: opKeys.privateKeyPem, approvalModes: { vps: 'dangerous' }, anchorIntervalMs: 0, verifyWorkspace } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const tg = fakeTelegram();
  const bot = createOperatorBot({ client: tg.client, ownerChatId: OWNER_CHAT, approvals: hub.operatorApprovals, grants: hub.operatorGrants,
    hub: { freeze: by => hub.setOperatorFrozen(true, by), unfreeze: async () => '', status: () => 'ok' } });
  hub.attachOperatorBot(bot);
  const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  const chain = createAuditChain({ store: fileAuditStore(host.policy.auditFile) });
  const tools = { ...createOperatorTools(host.policy, { guard, chain, projects: async () => [], platform: 'linux' }),
    ...createOperatorExecTools(host.policy, { jobs: createJobStore({ dir: host.p('state/jobs') }), projects: async () => [], platform: 'linux' }) };
  const verifier = createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: 'vps' });
  const { handlers } = createOperatorOperations({ policy: host.policy, verifier, guard, chain, tools });
  const agent = createAgent({ host: 'operator-vps', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-vps', online: true }), ...handlers } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('operator-vps')?.version === 2);
  const locked = await hub.requestOperator('vps', 'operator_lock', { args: { host: 'vps', workspace_id: WS, kind: 'global', reason: 'grant tests' }, principal: OWNER });
  assert.equal(locked.ok, true);
  const call = (op, args) => hub.requestOperator('vps', op, { args: { host: 'vps', workspace_id: WS, ...args }, principal: OWNER });
  const owner = (text, update_id = 1) => bot.handleUpdate({ update_id, message: { chat: { id: OWNER_CHAT }, from: { id: OWNER_CHAT }, text } });
  return { host, hub, tg, bot, call, owner, audit, handlers, opKeys };
}

test('RR-5, RR-6: one Telegram approval, then git and python3 under the prefix run without asking; hard calls and other dirs still ask; /revoke ends it', async t => {
  const s = await stack(t);
  const proj = s.host.p('srv/rw/proj');
  // Without a grant, every git call asks, and the answer says how to stop asking.
  const before = await s.call('operator_run', { argv: ['git', '--version'], cwd: proj });
  assert.equal(before.error, 'pending_approval');
  assert.match(before.standing_approval_hint, /operator_grant/);
  assert.equal(s.tg.sent.length, 1);
  // A hard call gets no hint.
  assert.equal((await s.call('operator_run', { argv: ['git', 'push', '--force'], cwd: proj })).standing_approval_hint, undefined);
  const sentBefore = s.tg.sent.length;
  // The conversation asks for a standing approval: host is required, one Telegram message, then the owner approves.
  assert.equal((await s.hub.requestOperator(undefined, 'operator_grant', { args: { action: 'request', programs: ['git'], cwd_prefixes: [proj] }, principal: OWNER })).error,
    'host_required');
  const asked = await s.call('operator_grant', { action: 'request', programs: ['git', 'python3'], cwd_prefixes: [proj], ttl_hours: 8, reason: 'work session' });
  assert.deepEqual([asked.ok, asked.status], [true, 'pending']);
  assert.equal(s.tg.sent.length, sentBefore + 1);
  const msg = s.tg.sent.at(-1);
  assert.match(msg.text, /standing approval request/);
  assert.match(msg.text, /can run ANY command as the agent user/);
  assert.deepEqual(msg.reply_markup.inline_keyboard.flat().map(b => b.callback_data), [`sg:a:${asked.grant_id}`, `sg:d:${asked.grant_id}`]);
  assert.ok(msg.reply_markup.inline_keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64));
  // A stranger pressing Approve changes nothing.
  await s.bot.handleUpdate({ update_id: 2, callback_query: { id: 'x', from: { id: 999 }, data: `sg:a:${asked.grant_id}`, message: { message_id: 2, chat: { id: OWNER_CHAT } } } });
  assert.equal((await s.call('operator_grant', { action: 'list' })).standing_approvals[0].status, 'pending');
  await s.bot.handleUpdate({ update_id: 3, callback_query: { id: 'y', from: { id: OWNER_CHAT }, data: `sg:a:${asked.grant_id}`, message: { message_id: 2, chat: { id: OWNER_CHAT }, text: 'req' } } });
  const listed = await s.call('operator_grant', { action: 'list' });
  assert.deepEqual(listed.standing_approvals.map(g => [g.grant_id, g.status, g.programs]), [[asked.grant_id, 'active', ['git', 'python3']]]);
  assert.deepEqual((await s.call('operator_policy', {})).standing_approvals.map(g => g.grant_id), [asked.grant_id], 'operator_policy lists it');
  const sentAfterGrant = s.tg.sent.length;
  // Now: no message, the calls run, the journals carry the grant id.
  const a = await s.call('operator_run', { argv: ['git', '--version'], cwd: proj });
  const b = await s.call('operator_run', { argv: ['git', 'status'], cwd: proj });
  const c = await s.call('operator_script', { interpreter: 'python3', content: 'print(6*7)', cwd: proj });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true);
  assert.deepEqual([c.ok, c.untrusted_content?.stdout], [true, '42\n'], JSON.stringify(c));
  assert.equal(s.tg.sent.length, sentAfterGrant, 'no Telegram message while the grant covers the calls');
  const hubLines = s.audit.filter(e => e.event === 'operator_call' && e.outcome === 'ok' && ['operator_run', 'operator_script'].includes(e.op));
  assert.ok(hubLines.length >= 3 && hubLines.every(e => e.approval_id === asked.grant_id));
  const hostLines = readFileSync(s.host.policy.auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(hostLines.some(l => l.op === 'operator_run' && l.outcome === 'ok' && l.approval === asked.grant_id));
  // Still asking: hard calls, another directory, a program the grant does not name.
  assert.equal((await s.call('operator_run', { argv: ['git', 'reset', '--hard'], cwd: proj })).error, 'pending_approval');
  assert.equal((await s.call('operator_run', { argv: ['git', '--version'], cwd: s.host.p('srv/app') })).error, 'pending_approval');
  assert.equal((await s.call('operator_run', { argv: ['node', '--version'], cwd: proj })).error, 'pending_approval');
  // /approvals lists it; /revoke from a stranger is ignored; the owner's /revoke ends it.
  await s.owner('/approvals', 10);
  assert.match(s.tg.sent.at(-1).text, new RegExp(asked.grant_id));
  await s.bot.handleUpdate({ update_id: 11, message: { chat: { id: 999 }, from: { id: 999 }, text: `/revoke ${asked.grant_id}` } });
  assert.equal((await s.call('operator_run', { argv: ['git', '--version'], cwd: proj })).ok, true);
  await s.owner(`/revoke ${asked.grant_id}`, 12);
  assert.match(s.tg.sent.at(-1).text, /Revoked/);
  assert.equal((await s.call('operator_run', { argv: ['git', '--version'], cwd: proj })).error, 'pending_approval');
  // The owner's own /grant is active at once; /revoke all ends everything.
  await s.owner(`/grant vps git ${proj} 2h`, 13);
  assert.match(s.tg.sent.at(-1).text, /Standing approval active/);
  assert.equal((await s.call('operator_run', { argv: ['git', '--version'], cwd: proj })).ok, true);
  await s.owner('/grant vps sudo /srv 2h', 14);
  assert.match(s.tg.sent.at(-1).text, /program_not_grantable/);
  await s.owner('/revoke all', 15);
  assert.match(s.tg.sent.at(-1).text, /Revoked 1/);
  assert.equal((await s.call('operator_grant', { action: 'list' })).standing_approvals.length, 0);
  // While the hub is frozen nobody can ask for a grant.
  s.hub.setOperatorFrozen(true, 'test');
  assert.equal((await s.call('operator_grant', { action: 'request', programs: ['git'], cwd_prefixes: [proj] })).error, 'frozen');
});

test('RR-7 (D-R5): the agent refuses a standing approval id on a hard call even when the hub signed it', async t => {
  const host = makeHost(t, { policy: { max_tier: 'exec', approval_mode: 'dangerous' } });
  const pair = signingPair({ clock: { t: Date.now() } });
  pair.clock.t = Date.now();
  const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  let ran = 0;
  const tools = { operator_run: async () => { ran++; return { ok: true }; } };
  const { handlers } = createOperatorOperations({ policy: host.policy, verifier: pair.verifier, guard, chain: null, tools });
  const send = async (args, approval) => {
    const id = `req_${Math.random().toString(36).slice(2, 18).padEnd(16, '0')}`;
    return handlers.operator_run(args, { id, principal: { id: 'oidc:owner' }, operator: pair.signer.sign({ id, op: 'operator_run', host: 'vps', tier: 2,
      principal: 'oidc:owner', args, approval }) });
  };
  const st = 'ap_st_AAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(await send({ host: 'vps', argv: ['git', 'push', '--force'], cwd: host.p('srv/rw') }, st), { ok: false, error: 'approval_scope' });
  assert.deepEqual(await send({ host: 'vps', argv: ['rm', '-f', host.p('srv/rw/x')] }, st), { ok: false, error: 'approval_scope' });
  assert.equal(ran, 0);
  assert.equal((await send({ host: 'vps', argv: ['git', 'status'], cwd: host.p('srv/rw') }, st)).ok, true);
  assert.equal((await send({ host: 'vps', argv: ['git', 'push', '--force'], cwd: host.p('srv/rw') }, 'ap_AAAAAAAAAAAAAAAAAAAAAAAA')).ok, true, 'a single-use id still works');
  assert.equal(ran, 2);
});
