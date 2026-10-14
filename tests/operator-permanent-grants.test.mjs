// Issue #48 (spec .agent/project/permanent-grants): permanent grants in the host policy file,
// owner-owned, no TTL. The loader, the coverage rule on the Mac and lab defaults, then a real hub,
// a real Mac operator agent on a temporary home and the bot behind a fake Telegram client:
// python3 under ~/memolabs runs without a request, ~/Documents, rm -r, gh pr merge and as_root
// still ask; the agent refuses any ap_pm_ id its own file does not cover; no tool makes one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOperatorPolicy, policySummary } from '../bridge/operator-policy.mjs';
import { permanentCovers, permanentGrantId, createGrantStore } from '../bridge/operator-grants.mjs';
import { approvalInScope, isGrantApproval } from '../bridge/operator-dangerous.mjs';
import { createApprovalStore } from '../bridge/operator-approvals.mjs';
import { macPolicy, PERMANENT_PROGRAMS } from '../deploy/mac/operator-mac.mjs';
import { createOperatorBot } from '../bridge/operator-telegram.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { makePrincipal, CAPABILITIES } from '../server/coordinator/policy.mjs';
import { basePolicy, makeHost, operatorKeys, signingPair } from './helpers/operator-fixture.mjs';

const HOME = '/Users/memo';
const OWNER_CHAT = 424242;
const OWNER = makePrincipal('oidc:owner', Object.values(CAPABILITIES));
const WS = 'ws_permanentTests01';
const parse = (raw, home = HOME) => parseOperatorPolicy(raw, { home, realpath: x => x });
const macBase = extra => basePolicy({ host: 'mac', ...extra });
const vpsBase = extra => basePolicy({ host: 'vps', ...extra });
// The lab defaults as lab-infra renders them (memo_operator_permanent_programs and _prefixes).
const LAB_GRANT = { host: 'vps', programs: [...PERMANENT_PROGRAMS], cwd_prefixes: ['/srv', '/opt'] };

test('PG-R1 loader: the Mac and lab defaults load; each entry gets a stable ap_pm_ id; operator_policy shows them', () => {
  const mac = parse(macPolicy(HOME));
  assert.deepEqual(PERMANENT_PROGRAMS, ['python3', 'node', 'bash', 'zsh', 'git', 'pnpm', 'npm', 'make']);
  assert.equal(mac.permanentGrants.length, 1);
  const [g] = mac.permanentGrants;
  assert.deepEqual([g.host, [...g.programs], [...g.cwd_prefixes]], ['mac', PERMANENT_PROGRAMS, [`${HOME}/memolabs`]]);
  assert.match(g.grant_id, /^ap_pm_[A-Za-z0-9_-]{22}$/);
  assert.equal(g.grant_id, permanentGrantId('mac', [...PERMANENT_PROGRAMS].reverse(), [`${HOME}/memolabs`]), 'order does not change the id');
  const lab = parse(vpsBase({ permanent_grants: [LAB_GRANT] }));
  assert.deepEqual([...lab.permanentGrants[0].cwd_prefixes], ['/srv', '/opt']);
  assert.notEqual(lab.permanentGrants[0].grant_id, g.grant_id);
  assert.deepEqual(policySummary(mac).permanent_grants, [{ grant_id: g.grant_id, host: 'mac', programs: PERMANENT_PROGRAMS,
    cwd_prefixes: [`${HOME}/memolabs`], source: 'permanent', expires_at: null }]);
  // Absent: none, and the summary says so.
  assert.deepEqual(policySummary(parse(vpsBase())).permanent_grants, []);
});

test('PG-R2 loader: refuses a hard-danger program, a privilege tool, a root flag, "/", another host, a bad shape', () => {
  const refuse = (grant, field, base = macBase) => assert.throws(() => parse(base({ permanent_grants: [grant] })),
    { message: `invalid_operator_policy:permanent_grants[0].${field}` }, JSON.stringify(grant));
  const ok = { host: 'mac', programs: ['git'], cwd_prefixes: ['~/memolabs'] };
  for (const p of ['rm', 'dd', 'mkfs', 'mkfs.ext4', 'diskutil', 'userdel', 'passwd', 'kill', 'shred', 'truncate']) {
    refuse({ ...ok, programs: ['git', p] }, 'programs[1]');
  }
  for (const p of ['sudo', 'su', 'doas', 'pkexec', 'runuser', 'chroot', 'nsenter']) refuse({ ...ok, programs: [p] }, 'programs[0]');
  refuse({ ...ok, programs: ['/bin/bash'] }, 'programs[0]');
  refuse({ ...ok, programs: [''] }, 'programs[0]');
  refuse({ ...ok, as_root: true }, 'as_root');
  refuse({ ...ok, root: true }, 'root');
  refuse({ ...ok, ttl_hours: 8 }, 'ttl_hours');
  refuse({ ...ok, cwd_prefixes: ['/'] }, 'cwd_prefixes[0]');
  refuse({ ...ok, cwd_prefixes: ['relative'] }, 'cwd_prefixes[0]');
  refuse({ ...ok, cwd_prefixes: ['/Users/memo/../etc'] }, 'cwd_prefixes[0]');
  refuse({ ...ok, cwd_prefixes: [] }, 'cwd_prefixes');
  refuse({ ...ok, programs: [] }, 'programs');
  refuse({ ...ok, programs: Array.from({ length: 17 }, (_, i) => `p${i}`) }, 'programs');
  refuse({ ...ok, host: 'vps' }, 'host');
  refuse({ programs: ['git'], cwd_prefixes: ['~/x'] }, 'host');
  refuse({ host: 'vps', programs: ['git'], cwd_prefixes: ['~/x'] }, 'cwd_prefixes[0]', vpsBase);
  assert.throws(() => parse(macBase({ permanent_grants: Array.from({ length: 9 }, () => ok) })), { message: 'invalid_operator_policy:permanent_grants' });
  assert.throws(() => parse(macBase({ permanent_grants: ok })), { message: 'invalid_operator_policy:permanent_grants' });
  assert.throws(() => parse(macBase({ permanent_grants: ['git'] })), { message: 'invalid_operator_policy:permanent_grants[0]' });
});

test('PG-R3 coverage under the Mac defaults: python3 in ~/memolabs is covered; ~/Documents, hard calls and root are not', () => {
  const grants = parse(macPolicy(HOME)).permanentGrants;
  const id = grants[0].grant_id;
  const homes = { mac: HOME };
  const run = (argv, cwd = `${HOME}/memolabs/os/app`, extra = {}) => permanentCovers(grants, { host: 'mac', op: 'operator_run', args: { argv, cwd, ...extra } }, homes);
  assert.equal(run(['python3', 'x.py']), id);
  for (const argv of [['node', 'x.js'], ['bash', 'build.sh'], ['zsh', 'x.zsh'], ['git', 'commit', '-am', 'x'], ['pnpm', 'test'], ['npm', 'ci'], ['make']]) {
    assert.equal(run(argv), id, argv.join(' '));
  }
  assert.equal(run(['python3', 'x.py'], '~/memolabs'), id, '"~/" expands to the home');
  assert.equal(run(['python3', 'x.py'], '/USERS/memo/MemoLabs/x'), id, 'case folded on the Mac');
  assert.equal(run(['python3', 'x.py'], `${HOME}/Documents`), null, '~/Documents still asks');
  assert.equal(run(['python3', 'x.py'], `${HOME}/memolabs-evil`), null, 'a sibling is not inside');
  assert.equal(run(['python3', 'x.py'], `${HOME}/memolabs/../Documents`), null, '.. is resolved first');
  assert.equal(permanentCovers(grants, { host: 'mac', op: 'operator_run', args: { argv: ['python3', 'x.py'] } }, homes), null, 'no cwd, no grant');
  assert.equal(run(['rm', '-r', 'build']), null, 'rm -r');
  assert.equal(run(['bash', '-c', 'rm -r build']), null, 'rm -r inside a shell line');
  assert.equal(run(['gh', 'pr', 'merge', '1']), null, 'gh pr merge');
  assert.equal(run(['git', 'push', '--force']), null, 'force push');
  assert.equal(run(['git', 'push', 'origin', 'main']), null, 'push to main');
  assert.equal(run(['git', 'reset', '--hard']), null, 'reset --hard');
  assert.equal(run(['ssh', 'lab', 'uptime']), null, 'ssh is not named');
  assert.equal(run(['env', 'python3', 'x.py']), null, 'env is not named');
  assert.equal(run(['python3', 'x.py'], undefined, { cwd: `${HOME}/memolabs`, as_root: true }), null, 'as_root');
  const script = (interpreter, extra = {}) => permanentCovers(grants, { host: 'mac', op: 'operator_script', args: { interpreter, content: 'x', cwd: `${HOME}/memolabs`, ...extra } }, homes);
  assert.equal(script('python3'), id);
  assert.equal(script('python3', { as_root: true }), null);
  assert.equal(permanentCovers(grants, { host: 'vps', op: 'operator_run', args: { argv: ['python3'], cwd: `${HOME}/memolabs` } }, homes), null, 'another host');
  assert.equal(permanentCovers(grants, { host: 'mac', op: 'operator_delete', args: { path: `${HOME}/memolabs/x`, recursive: true } }, homes), null);
  // Lab: the same programs under /srv and /opt.
  const lab = parse(vpsBase({ permanent_grants: [LAB_GRANT] })).permanentGrants;
  const labRun = (argv, cwd) => permanentCovers(lab, { host: 'vps', op: 'operator_run', args: { argv, cwd } }, {});
  assert.equal(labRun(['python3', 'x.py'], '/srv/app'), lab[0].grant_id);
  assert.equal(labRun(['make'], '/opt/x'), lab[0].grant_id);
  assert.equal(labRun(['python3', 'x.py'], '/etc'), null);
  assert.equal(labRun(['python3', 'x.py'], '/root'), null);
  assert.equal(labRun(['rm', '-r', '/srv/app'], '/srv'), null);
  // The scope rule shared with standing ids: a permanent id never stands for a hard or a T3 call.
  assert.equal(approvalInScope(id, 'operator_run', { argv: ['rm', '-r', 'x'], cwd: `${HOME}/memolabs` }, 2), false);
  assert.equal(approvalInScope(id, 'operator_run', { argv: ['python3'], cwd: `${HOME}/memolabs`, as_root: true }, 3), false);
  assert.equal(approvalInScope(id, 'operator_delete', { path: `${HOME}/memolabs/x`, recursive: true }, 1), false);
});

test('PG-R4 no tool makes a permanent grant: operator_grant has no such option, its ids and single-use ids never take ap_pm_', () => {
  const schema = OPERATOR_SCHEMAS.operator_grant;
  assert.equal(schema.safeParse({ host: 'mac', action: 'request', programs: ['git'], cwd_prefixes: ['~/x'], ttl_hours: 13 }).success, false);
  assert.equal(schema.safeParse({ host: 'mac', action: 'permanent', programs: ['git'], cwd_prefixes: ['~/x'] }).success, false);
  assert.equal(schema.safeParse({ host: 'mac', action: 'revoke', grant_id: 'ap_pm_AAAAAAAAAAAAAAAAAAAAAA' }).success, false, 'not even revoke');
  const store = createGrantStore({ homes: { mac: HOME } });
  const own = store.grantByOwner({ host: 'mac', programs: ['git'], cwd_prefixes: ['~/memolabs'], ttl_hours: 12 });
  assert.match(own.grant.id, /^ap_st_/);
  assert.equal(store.revoke('ap_pm_AAAAAAAAAAAAAAAAAAAAAA').error, 'unknown_grant');
  let n = 0;
  const forced = Buffer.from('pm_AAAAAAAAAAAAAAAAAAAAAAAA', 'base64url');
  const approvals = createApprovalStore({ random: size => (n++ === 0 ? forced.subarray(0, size) : Buffer.alloc(size, 7)) });
  const out = approvals.request({ host: 'mac', op: 'operator_run', argsSha256: 'a'.repeat(64), principal: 'p' });
  assert.equal(isGrantApproval(out.approval.id), false, out.approval.id);
  assert.equal(n, 2, 'it drew again');
});

test('PG-R5 agent: an ap_pm_ id runs only what its own file covers with that grant, whatever the hub signed', async t => {
  const host = makeHost(t, { policy: { max_tier: 'exec', approval_mode: 'dangerous' } });
  const grant = { host: 'vps', programs: ['python3', 'git'], cwd_prefixes: [host.p('srv/rw')] };
  const policy = parseOperatorPolicy({ ...host.raw, permanent_grants: [grant] }, { home: host.p('home/op') });
  const id = policy.permanentGrants[0].grant_id;
  const pair = signingPair({ clock: { t: Date.now() } });
  pair.clock.t = Date.now();
  const guard = createOperatorGuard(policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  let ran = 0;
  const tools = { operator_run: async () => { ran++; return { ok: true }; }, operator_script: async () => { ran++; return { ok: true }; } };
  const { handlers } = createOperatorOperations({ policy, verifier: pair.verifier, guard, chain: null, tools });
  const send = async (op, args, approval, tier = 2) => {
    const rid = `req_${Math.random().toString(36).slice(2, 18).padEnd(16, '0')}`;
    return handlers[op](args, { id: rid, principal: { id: 'oidc:owner' }, operator: pair.signer.sign({ id: rid, op, host: 'vps', tier, principal: 'oidc:owner', args, approval }) });
  };
  const rw = host.p('srv/rw/proj');
  assert.equal((await send('operator_run', { host: 'vps', argv: ['python3', 'x.py'], cwd: rw }, id)).ok, true);
  assert.equal((await send('operator_script', { host: 'vps', interpreter: 'python3', content: 'print(1)', cwd: rw }, id)).ok, true);
  assert.equal(ran, 2);
  const scope = { ok: false, error: 'approval_scope' };
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['python3', 'x.py'], cwd: host.p('srv/app') }, id), scope, 'outside its prefix');
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['node', 'x.js'], cwd: rw }, id), scope, 'a program it does not name');
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['python3', 'x.py'], cwd: rw }, 'ap_pm_AAAAAAAAAAAAAAAAAAAAAA'), scope, 'an id not in the file');
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['git', 'push', '--force'], cwd: rw }, id), scope, 'hard');
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['rm', '-r', rw] }, id), scope, 'hard, no cwd');
  assert.deepEqual(await send('operator_run', { host: 'vps', argv: ['python3', 'x.py'], cwd: rw, as_root: true }, id, 3).then(r => r.error), 'tier_not_allowed');
  // A file without the grant: the same id stands for nothing (the owner removed it, the hub's copy is stale).
  const without = createOperatorOperations({ policy: host.policy, verifier: pair.verifier, guard, chain: null, tools }).handlers;
  const rid = 'req_withoutgrant0001';
  const args = { host: 'vps', argv: ['python3', 'x.py'], cwd: rw };
  assert.deepEqual(await without.operator_run(args, { id: rid, principal: { id: 'oidc:owner' },
    operator: pair.signer.sign({ id: rid, op: 'operator_run', host: 'vps', tier: 2, principal: 'oidc:owner', args, approval: id }) }), scope);
  assert.equal(ran, 2);
});

// ------------------------------------------------------------------------------------------
// Live: a real hub, a real Mac operator agent on a temporary home with the installer's policy.

function tls(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memo-pg-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'k'), '-out', join(dir, 'c')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { tlsKey: readFileSync(join(dir, 'k'), 'utf8'), tlsCert: readFileSync(join(dir, 'c'), 'utf8') };
}
function fakeTelegram() {
  const sent = [];
  return { sent, client: { sendMessage: async p => { sent.push(p); return { message_id: sent.length }; }, getUpdates: async () => [],
    answerCallbackQuery: async () => true, editMessageText: async () => true } };
}
async function until(fn, ms = 5000) {
  const expire = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > expire) throw new Error('wait expired'); await new Promise(r => setTimeout(r, 15)); }
}

async function macStack(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'memo-pg-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const d of ['memolabs/os/app', 'memolabs/.links', 'Documents', '.memo-operator/state', 'Library/Logs/memo-operator']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, 'memolabs/PROJECTS.md'), '# registry\n');
  const raw = macPolicy(home);
  const policy = parseOperatorPolicy(raw, { home });
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const id = generateAgentIdentity();
  const runtimeId = generateAgentIdentity();
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev), runtimeHost: 'vps',
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: runtimeId.publicKey, 'operator-mac': id.publicKey },
    operator: { signingKeyPem: opKeys.privateKeyPem, approvalModes: { mac: 'dangerous' }, anchorIntervalMs: 0, homes: { mac: home },
      verifyWorkspace: async (principal, ws) => ({ ok: true, workspace: { workspace_id: ws, status: 'active', session_tag: null, project: 'drop' } }) } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const tg = fakeTelegram();
  const bot = createOperatorBot({ client: tg.client, ownerChatId: OWNER_CHAT, approvals: hub.operatorApprovals, grants: hub.operatorGrants,
    hub: { freeze: by => hub.setOperatorFrozen(true, by), unfreeze: async () => '', status: () => 'ok' } });
  hub.attachOperatorBot(bot);
  const guard = createOperatorGuard(policy, { autoFrozenFile: join(home, '.memo-operator/state/AUTO-FROZEN') });
  const chain = createAuditChain({ store: fileAuditStore(policy.auditFile) });
  const projects = async () => [];
  const tools = { ...createOperatorTools(policy, { guard, chain, projects }), ...createOperatorExecTools(policy, { projects }) };
  const verifier = createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: 'mac' });
  let policyCalls = 0;
  const { handlers } = createOperatorOperations({ policy, verifier, guard, chain, tools });
  const countedPolicy = async (args, ctx) => { policyCalls++; return handlers.operator_policy(args, ctx); };
  const agent = createAgent({ host: 'operator-mac', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-mac', online: true }), ...handlers, operator_policy: countedPolicy } });
  t.after(() => agent.stop());
  // The runtime answers sessions_overview (its part); the hub adds locks, standing and permanent grants.
  const runtime = createAgent({ host: 'vps', url: `wss://127.0.0.1:${port}/agent`, privateKey: runtimeId.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'vps', online: true }), sessions_overview: async () => ({ ok: true, sessions: [], count: 0, truncated: false }) } });
  t.after(() => runtime.stop());
  await until(() => hub.agentInfo('operator-mac')?.version === 2 && hub.agentInfo('vps')?.version === 2);
  assert.equal((await hub.requestOperator('mac', 'operator_lock', { args: { host: 'mac', workspace_id: WS, kind: 'global', reason: 'permanent tests' }, principal: OWNER })).ok, true);
  const call = (op, args) => hub.requestOperator('mac', op, { args: { host: 'mac', workspace_id: WS, ...args }, principal: OWNER });
  return { home, policy, hub, tg, call, audit, policyCalls: () => policyCalls };
}

test('PG-R6 live (Mac defaults): python3 under ~/memolabs runs without Telegram, journaled permanent; ~/Documents, rm -r, gh pr merge and as_root still ask', async t => {
  const s = await macStack(t);
  const grantId = s.policy.permanentGrants[0].grant_id;
  const app = join(s.home, 'memolabs/os/app');
  const a = await s.call('operator_run', { argv: ['python3', '-c', 'print(6*7)'], cwd: app });
  assert.deepEqual([a.ok, a.untrusted_content?.stdout], [true, '42\n'], JSON.stringify(a));
  const b = await s.call('operator_script', { interpreter: 'python3', content: 'print(1+1)', cwd: '~/memolabs' });
  assert.deepEqual([b.ok, b.untrusted_content?.stdout], [true, '2\n'], JSON.stringify(b));
  assert.equal(s.tg.sent.length, 0, 'no Telegram request');
  assert.equal(s.policyCalls(), 1, 'the hub read the grants once, then from its copy');
  const hubLines = s.audit.filter(e => e.event === 'operator_call' && ['operator_run', 'operator_script'].includes(e.op) && e.outcome === 'ok');
  assert.equal(hubLines.length, 2);
  assert.ok(hubLines.every(e => e.approval_id === grantId && e.approval_source === 'permanent'), JSON.stringify(hubLines));
  const hostLines = readFileSync(s.policy.auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(hostLines.filter(l => ['operator_run', 'operator_script'].includes(l.op) && l.outcome === 'ok' && l.approval === grantId).length, 2);
  // Still asking, one Telegram request each.
  const asks = [
    ['operator_run', { argv: ['python3', '-c', 'print(1)'], cwd: join(s.home, 'Documents') }],
    ['operator_run', { argv: ['rm', '-r', join(app, 'build')], cwd: app }],
    ['operator_run', { argv: ['gh', 'pr', 'merge', '1'], cwd: app }],
    ['operator_run', { argv: ['python3', '-c', 'print(1)'], cwd: app, as_root: true }],
    ['operator_script', { interpreter: 'python3', content: 'print(1)', cwd: app, as_root: true }]
  ];
  for (const [op, args] of asks) {
    const out = await s.call(op, args);
    assert.equal(out.error, 'pending_approval', `${op} ${JSON.stringify(args)}: ${JSON.stringify(out)}`);
  }
  assert.equal(s.tg.sent.length, asks.length);
  // operator_policy and sessions_overview show the grant.
  const shown = await s.call('operator_policy', {});
  assert.deepEqual(shown.policy.permanent_grants.map(g => [g.grant_id, g.source, g.expires_at, g.cwd_prefixes]),
    [[grantId, 'permanent', null, [join(s.home, 'memolabs')]]]);
  const overview = await s.hub.requestAgent('vps', 'sessions_overview', { principal: OWNER });
  assert.equal(overview.ok, true, JSON.stringify(overview));
  assert.deepEqual(overview.permanent_grants.map(g => [g.host, g.grant_id, g.programs]), [['mac', grantId, PERMANENT_PROGRAMS]]);
  assert.deepEqual(overview.standing_approvals, []);
});
