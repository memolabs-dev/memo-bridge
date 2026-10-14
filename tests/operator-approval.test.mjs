// Phase 6, TODO-P6-11 (R-P6-10, R-P6-06, R-P6-07; AC-P6-05, AC-P6-04 Telegram part, AC-P6-11
// owner unfreeze, AC-P6-07 anchoring): the dangerous list, the approval store, the Telegram bot
// behind a fake client, and the whole path over a real hub and a real operator agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dangerReason, needsApproval } from '../bridge/operator-dangerous.mjs';
import { createApprovalStore } from '../bridge/operator-approvals.mjs';
import { createOperatorBot, createTelegramClient, readTelegramToken } from '../bridge/operator-telegram.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorWriteTools } from '../bridge/operator-write.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { makePrincipal, CAPABILITIES } from '../server/coordinator/policy.mjs';
import { makeHost, operatorKeys } from './helpers/operator-fixture.mjs';

const OWNER_CHAT = 424242;
const TOKEN = `123456789:${'A'.repeat(35)}`;
const OWNER = makePrincipal('oidc:owner', Object.values(CAPABILITIES));

test('dangerous list (spec D5): what asks, what does not', () => {
  const yes = [
    ['operator_script', { interpreter: 'bash', content: 'id' }],
    ['operator_run', { argv: ['rm', '-f', '/tmp/x'] }], ['operator_run', { argv: ['/usr/bin/rm', 'x'] }],
    ['operator_run', { argv: ['mkfs.ext4', '/dev/sdb'] }], ['operator_run', { argv: ['dd', 'if=/dev/zero'] }],
    ['operator_run', { argv: ['ufw', 'disable'] }], ['operator_run', { argv: ['nft', 'flush', 'ruleset'] }],
    ['operator_run', { argv: ['systemctl', 'stop', 'ssh'] }], ['operator_run', { argv: ['systemctl', '--now', 'disable', 'traefik.service'] }],
    ['operator_run', { argv: ['systemctl', 'mask', 'memo-bridge-hub.service'] }], ['operator_run', { argv: ['systemctl', 'reboot'] }],
    ['operator_run', { argv: ['cat', '/etc/shadow'] }], ['operator_run', { argv: ['cp', 'x', '/etc/sudoers.d/a'] }],
    ['operator_run', { argv: ['grep', '--file=/etc/ssh/sshd_config', 'x'] }],
    ['operator_run', { argv: ['bash', '-c', 'echo hi'] }], ['operator_run', { argv: ['env', 'rm', 'x'] }], ['operator_run', { argv: ['sudo', 'id'] }],
    ['operator_run', { argv: ['find', '/srv', '-delete'] }], ['operator_run', { argv: ['python3', '-c', 'print(1)'] }],
    ['operator_service', { unit: 'ssh.service', action: 'stop' }], ['operator_service', { unit: 'traefik.service', action: 'stop' }],
    ['operator_delete', { path: '/srv/x', recursive: true }], ['operator_edit', { path: '/etc/pam.d/sshd' }],
    ['operator_move', { src: '/srv/a', dst: '/etc/passwd' }], ['operator_chmod', { path: '/etc/sudoers' }],
    // Lot 3, the Mac (DEV-P6-25): AppleScript, launchd, open and the keychain CLI; the agent's own control files.
    ['operator_run', { argv: ['osascript', '-e', 'do shell script "id"'] }], ['operator_run', { argv: ['/bin/launchctl', 'bootstrap', 'gui/501', 'x'] }],
    ['operator_run', { argv: ['open', '-a', 'Terminal'] }], ['operator_run', { argv: ['security', 'find-generic-password', '-w'] }],
    ['operator_run', { argv: ['mv', '/tmp/p.json', '/Users/memo/.memo-operator/policy.json'] }],
    ['operator_run', { argv: ['chmod', '644', '/Users/memo/.MEMO-OPERATOR/policy.json'] }],
    ['operator_run', { argv: ['cp', 'x.plist', '/Users/memo/Library/LaunchAgents/evil.plist'] }],
    ['operator_run', { argv: ['tee', '/etc/memo-operator/policy.json'] }],
    ['operator_edit', { path: '/Users/memo/Library/LaunchAgents/x.plist' }], ['operator_copy', { src: '/tmp/a', dst: '/Users/memo/.memo-operator/FROZEN' }]
  ];
  for (const [op, args] of yes) assert.notEqual(dangerReason(op, args), null, `${op} ${JSON.stringify(args)}`);
  const no = [
    ['operator_run', { argv: ['df', '-h'] }], ['operator_run', { argv: ['systemctl', 'status', 'ssh'] }],
    ['operator_run', { argv: ['systemctl', 'restart', 'beszel-agent.service'] }], ['operator_run', { argv: ['cat', '/etc/hostname'] }],
    ['operator_service', { unit: 'traefik.service', action: 'restart' }], ['operator_delete', { path: '/srv/rw/file' }],
    ['operator_edit', { path: '/srv/rw/app.conf' }], ['operator_read', { path: '/etc/shadow' }],
    ['operator_run', { argv: ['ls', '/Users/memo/memolabs'] }], ['operator_edit', { path: '/Users/memo/memolabs/notes/memo-operator.md' }]
  ];
  for (const [op, args] of no) assert.equal(dangerReason(op, args), null, `${op} ${JSON.stringify(args)}`);
  assert.equal(needsApproval('off', 'operator_script', {}, 3), false);
  assert.equal(needsApproval('dangerous', 'operator_run', { argv: ['id'] }, 3), false);
  assert.equal(needsApproval('all_root', 'operator_run', { argv: ['id'] }, 3), true);
  assert.equal(needsApproval('all_root', 'operator_run', { argv: ['id'] }, 2), false);
  assert.equal(needsApproval('typo', 'operator_run', { argv: ['id'] }, 2), true, 'unknown mode fails closed');
});

test('approval store: bound to host, op, principal and args hash; single use, 10 min expiry, 15 min standing, deny', () => {
  const clock = { t: 1_800_000_000_000 };
  const store = createApprovalStore({ now: () => clock.t });
  const call = { host: 'vps', op: 'operator_run', argsSha256: 'a'.repeat(64), principal: 'oidc:owner' };
  const first = store.request(call);
  assert.equal(first.created, true);
  assert.equal(store.request(call).approval.id, first.approval.id, 'one open approval per call');
  assert.equal(store.consume(call), null, 'pending is not usable');
  assert.equal(store.decide(first.approval.id, 'approve').ok, true);
  assert.equal(store.consume({ ...call, argsSha256: 'b'.repeat(64) }), null, 'another args hash is not unlocked');
  assert.equal(store.consume({ ...call, principal: 'oidc:other' }), null);
  assert.equal(store.consume(call), first.approval.id);
  assert.equal(store.consume(call), null, 'single use');
  assert.equal(store.status(first.approval.id).status, 'used');
  // Expiry: pending for 10 min, then expired; a decision after that is refused.
  const late = store.request({ ...call, argsSha256: 'c'.repeat(64) });
  clock.t += 10 * 60_000 + 1;
  assert.equal(store.status(late.approval.id).status, 'expired');
  assert.equal(store.decide(late.approval.id, 'approve').error, 'approval_expired');
  // Standing: the same exact call for 15 min after the decision.
  const standing = store.request({ ...call, argsSha256: 'd'.repeat(64) });
  store.decide(standing.approval.id, 'standing');
  const d = { ...call, argsSha256: 'd'.repeat(64) };
  assert.equal(store.consume(d), standing.approval.id);
  assert.equal(store.consume(d), standing.approval.id);
  clock.t += 15 * 60_000 + 1;
  assert.equal(store.consume(d), null);
  // Deny.
  const denied = store.request({ ...call, argsSha256: 'e'.repeat(64) });
  store.decide(denied.approval.id, 'deny');
  assert.equal(store.status(denied.approval.id).status, 'denied');
  assert.equal(store.consume({ ...call, argsSha256: 'e'.repeat(64) }), null);
  assert.equal(store.status('ap_unknown_unknown_x').error, 'unknown_approval');
});

function fakeTelegram() {
  const sent = []; const answered = []; const edited = []; const queue = [];
  return { sent, answered, edited, queue, client: {
    sendMessage: async p => { sent.push(p); return { message_id: sent.length }; },
    getUpdates: async p => { const out = queue.splice(0); out.offsetAsked = p.offset; return out; },
    answerCallbackQuery: async p => { answered.push(p); return true; },
    editMessageText: async p => { edited.push(p); return true; }
  } };
}

test('Telegram client: the token never appears in an error; the credential file is read like the other systemd credentials', async t => {
  const failing = createTelegramClient({ token: TOKEN, fetchImpl: async () => ({ status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }) });
  await assert.rejects(failing.sendMessage({ chat_id: 1, text: 'x' }), error => !error.message.includes(TOKEN) && /telegram_error:sendMessage:401/.test(error.message));
  const unreachable = createTelegramClient({ token: TOKEN, fetchImpl: async url => { throw new Error(`connect failed ${url}`); } });
  await assert.rejects(unreachable.getUpdates({}), error => !error.message.includes(TOKEN));
  let seenUrl = null;
  const ok = createTelegramClient({ token: TOKEN, fetchImpl: async (url, init) => { seenUrl = url; assert.equal(init.method, 'POST'); return { status: 200, json: async () => ({ ok: true, result: [] }) }; } });
  assert.deepEqual(await ok.getUpdates({ offset: 0, timeout: 1 }), []);
  assert.equal(seenUrl, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
  assert.throws(() => createTelegramClient({ token: 'not a token' }), /telegram token invalid/);
  const dir = mkdtempSync(join(tmpdir(), 'memo-cred-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await readTelegramToken({ CREDENTIALS_DIRECTORY: dir }), { error: 'credential_missing' });
  writeFileSync(join(dir, 'telegram-bot'), `${TOKEN}\n`);
  assert.deepEqual(await readTelegramToken({ CREDENTIALS_DIRECTORY: dir }), { token: TOKEN });
  writeFileSync(join(dir, 'telegram-bot'), 'garbage');
  assert.deepEqual(await readTelegramToken({ CREDENTIALS_DIRECTORY: dir }), { error: 'credential_invalid' });
  assert.deepEqual(await readTelegramToken({}), { error: 'credential_missing' });
});

// ------------------------------------------------------------------------------------------
// Live: a real hub and a real operator agent (T0 to T2, approval_mode dangerous).

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

async function stack(t, { hubModes = { vps: 'dangerous' }, withBot = true } = {}) {
  const host = makeHost(t, { policy: { max_tier: 'exec', approval_mode: 'dangerous' } });
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const id = generateAgentIdentity();
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev),
    allowedAgentKeys: { mac: generateAgentIdentity().publicKey, vps: generateAgentIdentity().publicKey, 'operator-vps': id.publicKey },
    operator: { signingKeyPem: opKeys.privateKeyPem, approvalModes: hubModes, anchorIntervalMs: 0 } });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const tg = fakeTelegram();
  const bot = createOperatorBot({ client: tg.client, ownerChatId: OWNER_CHAT, approvals: hub.operatorApprovals, hub: {
    freeze: by => hub.setOperatorFrozen(true, by), unfreeze: async by => JSON.stringify(await hub.ownerUnfreeze(by)),
    status: () => `frozen: ${hub.operatorFrozen()}` } });
  if (withBot) hub.attachOperatorBot(bot);
  const guard = createOperatorGuard(host.policy, { autoFrozenFile: host.p('state/AUTO-FROZEN') });
  const chain = createAuditChain({ store: fileAuditStore(host.policy.auditFile) });
  const tools = { ...createOperatorTools(host.policy, { guard, chain, projects: async () => [], platform: 'linux' }),
    ...createOperatorWriteTools(host.policy, { projects: async () => [] }),
    ...createOperatorExecTools(host.policy, { jobs: createJobStore({ dir: host.p('state/jobs') }), projects: async () => [], platform: 'linux' }) };
  const { handlers } = createOperatorOperations({ policy: host.policy, verifier: createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: 'vps' }),
    guard, chain, tools });
  const agent = createAgent({ host: 'operator-vps', url: `wss://127.0.0.1:${port}/agent`, privateKey: id.privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-vps', online: true }), ...handlers } });
  t.after(() => agent.stop());
  await until(() => hub.agentInfo('operator-vps')?.version === 2);
  const call = (op, args) => hub.requestOperator('vps', op, { args: { host: 'vps', ...args }, principal: OWNER });
  const press = (approvalId, decision = 'a', from = OWNER_CHAT) => bot.handleUpdate({ update_id: 7, callback_query: { id: 'cb1', from: { id: from },
    data: `ap:${decision}:${approvalId}`, message: { message_id: 1, chat: { id: OWNER_CHAT }, text: 'req' } } });
  return { host, hub, tg, bot, call, press, audit, guard };
}

test('AC-P6-05: a dangerous call waits for the owner; confirm:true and another args hash unlock nothing; the exact call runs once approved', async t => {
  const s = await stack(t);
  const victim = s.host.p('srv/rw/victim.txt');
  writeFileSync(victim, 'x');
  const pending = await s.call('operator_run', { argv: ['rm', victim] });
  assert.equal(pending.error, 'pending_approval');
  assert.match(pending.approval_id, /^ap_/);
  assert.equal(s.tg.sent.length, 1);
  assert.equal(s.tg.sent[0].chat_id, OWNER_CHAT);
  assert.deepEqual(s.tg.sent[0].reply_markup.inline_keyboard.flat().map(b => b.callback_data),
    [`ap:a:${pending.approval_id}`, `ap:d:${pending.approval_id}`, `ap:s:${pending.approval_id}`]);
  assert.ok(s.tg.sent[0].reply_markup.inline_keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64), 'callback_data 1-64 bytes');
  // Asking again: same approval, no second message.
  assert.equal((await s.call('operator_run', { argv: ['rm', victim] })).approval_id, pending.approval_id);
  assert.equal(s.tg.sent.length, 1);
  assert.equal((await s.call('approval_status', { approval_id: pending.approval_id })).status, 'pending');
  // confirm:true is just another argument: a different hash, a separate pending approval.
  const confirm = await s.call('operator_run', { argv: ['rm', victim], confirm: true });
  assert.equal(confirm.error, 'pending_approval');
  assert.notEqual(confirm.approval_id, pending.approval_id);
  // A stranger pressing the button: ignored.
  await s.press(pending.approval_id, 'a', 999);
  assert.equal((await s.call('approval_status', { approval_id: pending.approval_id })).status, 'pending');
  assert.equal(s.bot.ignored, 1);
  // The owner approves: another file's rm is still not unlocked...
  await s.press(pending.approval_id, 'a');
  assert.equal(s.tg.answered.at(-1).text, 'Done: approve');
  assert.equal((await s.call('approval_status', { approval_id: pending.approval_id })).status, 'approved');
  const other = await s.call('operator_run', { argv: ['rm', s.host.p('srv/rw/other.txt')] });
  assert.equal(other.error, 'pending_approval');
  assert.equal(existsSync(victim), true, 'nothing ran so far');
  // ...the exact call runs once.
  const ran = await s.call('operator_run', { argv: ['rm', victim] });
  assert.deepEqual([ran.ok, ran.exit_code], [true, 0]);
  assert.equal(existsSync(victim), false);
  const again = await s.call('operator_run', { argv: ['rm', victim] });
  assert.equal(again.error, 'pending_approval', 'single use: asking again opens a new approval');
  // The journals record the approval id with the call.
  const hubLine = s.audit.find(e => e.event === 'operator_call' && e.outcome === 'ok' && e.op === 'operator_run');
  assert.equal(hubLine.approval_id, pending.approval_id);
  const hostLines = readFileSync(s.host.policy.auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(hostLines.find(l => l.op === 'operator_run' && l.outcome === 'ok').approval, pending.approval_id);
  // A harmless call never asks.
  assert.equal((await s.call('operator_run', { argv: ['df', '-h'] })).ok, true);
  // as_root needs operator:root on top of operator:exec (the call's tier is T3).
  const execOnly = makePrincipal('oidc:owner', [CAPABILITIES.OPERATOR_READ, CAPABILITIES.OPERATOR_EXEC]);
  assert.deepEqual(await s.hub.requestOperator('vps', 'operator_run', { args: { host: 'vps', argv: ['id'], as_root: true }, principal: execOnly }),
    { ok: false, error: 'forbidden' });
  assert.equal((await s.hub.requestOperator('vps', 'operator_run', { args: { host: 'vps', argv: ['id'] }, principal: execOnly })).ok, true);
  // Deny.
  const denied = await s.call('operator_run', { argv: ['rm', s.host.p('srv/rw/third.txt')] });
  await s.press(denied.approval_id, 'd');
  assert.equal((await s.call('approval_status', { approval_id: denied.approval_id })).status, 'denied');
});

test('AC-P6-05: without a bot dangerous calls fail closed; a host stricter than the hub refuses an unapproved call itself', async t => {
  const noBot = await stack(t, { withBot: false });
  const file = noBot.host.p('srv/rw/keep.txt');
  writeFileSync(file, 'x');
  assert.deepEqual(await noBot.call('operator_run', { argv: ['rm', file] }), { ok: false, error: 'approval_unavailable' });
  assert.equal(existsSync(file), true);
  const lax = await stack(t, { hubModes: { vps: 'off' } });
  const file2 = lax.host.p('srv/rw/keep.txt');
  writeFileSync(file2, 'x');
  assert.deepEqual(await lax.call('operator_run', { argv: ['rm', file2] }), { ok: false, error: 'approval_required' });
  assert.equal(existsSync(file2), true);
});

test('AC-P6-04 (Telegram): /freeze from the owner chat refuses above T0 at the hub; strangers are ignored; /unfreeze also clears the hosts\' auto-freeze', async t => {
  const s = await stack(t);
  s.tg.queue.push({ update_id: 10, message: { chat: { id: 999 }, from: { id: 999 }, text: '/freeze' } });
  await s.bot.pollOnce();
  assert.equal(s.hub.operatorFrozen(), false, 'a stranger cannot freeze');
  s.tg.queue.push({ update_id: 11, message: { chat: { id: OWNER_CHAT }, from: { id: OWNER_CHAT }, text: '/freeze' } });
  await s.bot.pollOnce();
  assert.equal(s.hub.operatorFrozen(), true);
  assert.deepEqual(await s.call('operator_run', { argv: ['df'] }), { ok: false, error: 'frozen' });
  assert.equal((await s.call('operator_policy', {})).ok, true, 'T0 still answers');
  // The host froze itself meanwhile (auto-freeze marker): the owner's /unfreeze clears both.
  writeFileSync(s.host.p('state/AUTO-FROZEN'), '{}');
  assert.equal(s.guard.status().auto, true);
  s.tg.queue.push({ update_id: 12, message: { chat: { id: 999 }, from: { id: 999 }, text: '/unfreeze' } });
  s.tg.queue.push({ update_id: 13, message: { chat: { id: OWNER_CHAT }, from: { id: OWNER_CHAT }, text: '/unfreeze' } });
  await s.bot.pollOnce();
  assert.equal(s.hub.operatorFrozen(), false);
  assert.equal(s.guard.status().auto, false);
  assert.equal(existsSync(s.host.p('state/AUTO-FROZEN')), false);
  assert.match(s.tg.sent.at(-1).text, /auto_freeze_cleared/);
  assert.equal((await s.call('operator_run', { argv: ['df'] })).ok, true);
  // Updates are confirmed with offset = last update_id + 1.
  const before = s.tg.queue.length;
  await s.bot.pollOnce();
  assert.equal(before, 0);
  // No tool can do this: the internal ops are refused through requestOperator.
  assert.deepEqual(await s.call('operator_owner_unfreeze', { by: 'model' }), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await s.call('operator_audit_head', {}), { ok: false, error: 'unsupported_op' });
});

test('AC-P6-07 (anchoring): the hub anchors each chain head; a rewritten host journal is detected and freezes operator access', async t => {
  const s = await stack(t);
  await s.call('operator_policy', {});
  await s.call('operator_state', {});
  assert.deepEqual(await s.hub.anchorChains(), { vps: 'anchored' });
  const anchor = s.audit.filter(e => e.event === 'operator_chain_anchor').at(-1);
  assert.equal(anchor.seq, 2);
  await s.call('operator_policy', {});
  assert.deepEqual(await s.hub.anchorChains(), { vps: 'anchored' }, 'growth is fine');
  // Rewrite the whole file consistently (a new chain with different content): the anchored line changed.
  const file = s.host.policy.auditFile;
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  rmSync(file);
  const forged = createAuditChain({ store: fileAuditStore(file) });
  for (let i = 0; i < lines.length + 2; i++) forged.append({ op: 'operator_policy', outcome: 'ok', args: { host: 'vps', i } });
  assert.deepEqual(await s.hub.anchorChains(), { vps: 'tampered' });
  assert.equal(s.hub.operatorFrozen(), true);
  assert.ok(s.audit.some(e => e.event === 'operator_chain_tampered'));
});
