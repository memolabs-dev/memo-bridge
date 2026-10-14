// Issue #35: a Telegram message at the end of a job started with notify: true, and the
// notifications inbox (notifications_check, notifications_get, notifications_ack). Unit rules on
// the notifier and the bot with fakes, then the hub end to end: a real operator agent running a
// background job, a fake runtime agent for jobs_submit, a fake Telegram client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTIFY_LIMITS, createNotifier, operatorOutcome, runtimeOutcome, telegramText } from '../bridge/operator-notifications.mjs';
import { createOperatorBot } from '../bridge/operator-telegram.mjs';
import { createApprovalStore } from '../bridge/operator-approvals.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createHub } from '../bridge/hub.mjs';
import { createAgent } from '../bridge/agent.mjs';
import { generateAgentIdentity } from '../bridge/crypto.mjs';
import { HUB_PRINCIPALS, PRINCIPAL_IDS } from '../bridge/ops.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { NOTIFICATION_SCHEMAS, NOTIFICATION_TOOLS } from '../server/tools/operator-notifications.mjs';
import { GITHUB_TOKEN, makeHost, operatorKeys } from './helpers/operator-fixture.mjs';
import { tls, until } from './helpers/operator-live.mjs';

const OWNER = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
const READER = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
const A = { id: 'oidc:a' };
const B = { id: 'oidc:b' };
const OWNER_CHAT = 424242;
const DONE = { ok: true, status: 'done', exit_code: 0, timed_out: false, duration_ms: 83_000, stdout: 'step 1\nstep 2\nall good\n', stderr: '' };

function fakeTelegram({ fail = false } = {}) {
  const sent = [];
  const client = { sendMessage: async p => { if (fail) throw new Error('telegram_unreachable:sendMessage'); sent.push(p); return {}; },
    getUpdates: async () => [], answerCallbackQuery: async () => ({}), editMessageText: async () => ({}) };
  return { client, sent };
}
function notifier({ answers = new Map(), send, limits, now } = {}) {
  const journal = [];
  const n = createNotifier({ poll: async w => { const a = answers.get(w.job_id); return typeof a === 'function' ? a() : a; },
    send: send ?? (() => null), record: (event, details) => journal.push({ event, ...details }), limits, ...(now ? { now } : {}) });
  return { n, journal };
}

test('#35: a finished notify job lands once in the inbox; get returns it; ack removes it; a second check no longer counts it', async () => {
  const answers = new Map([['j_aaaaaaaaaaaaaaaaaaaa', { ok: true, status: 'running' }]]);
  const { client, sent } = fakeTelegram();
  const bot = createOperatorBot({ client, ownerChatId: OWNER_CHAT, approvals: createApprovalStore(), hub: {} });
  const { n, journal } = notifier({ answers, send: x => bot.notifyJob(x) });
  assert.deepEqual(n.watch({ kind: 'operator', host: 'mac', job_id: 'j_aaaaaaaaaaaaaaaaaaaa', label: 'operator_run', principal: A, timeout_s: 60 }), { registered: true });
  assert.equal(await n.pollOnce(), 0, 'still running');
  assert.equal(n.check(A.id).unread, 0);
  assert.equal(n.check(A.id).watching, 1);
  answers.set('j_aaaaaaaaaaaaaaaaaaaa', DONE);
  assert.equal(await n.pollOnce(), 1);
  assert.equal(await n.pollOnce(), 0, 'one notice per job');
  assert.equal(sent.length, 1, 'one Telegram message');
  assert.deepEqual(n.check(A.id), { ok: true, unread: 1, total: 1, watching: 0, latest_unread_at: n.get(A.id).notifications[0].ended_at });
  const got = n.get(A.id);
  assert.equal(got.notifications.length, 1);
  const item = got.notifications[0];
  assert.equal(item.status, 'succeeded');
  assert.equal(item.exit_code, 0);
  assert.equal(item.duration_ms, 83_000);
  assert.equal(item.telegram, 'sent');
  assert.equal(item.output_tail, 'step 1\nstep 2\nall good');
  assert.deepEqual(n.get(A.id, { notification_id: item.notification_id }).notifications[0], item);
  assert.deepEqual(n.ack(A.id, { notification_ids: [item.notification_id] }), { ok: true, acked: 1, unread: 0 });
  assert.equal(n.check(A.id).unread, 0);
  assert.equal(n.get(A.id).notifications.length, 0);
  assert.equal(n.get(A.id, { include_acked: true }).notifications.length, 1);
  assert.equal(n.ack(A.id, {}).error, 'invalid_arguments');
  assert.ok(journal.some(e => e.event === 'notification_sent' && e.job_id === 'j_aaaaaaaaaaaaaaaaaaaa'));
});

test('#35: the Telegram message goes to the owner chat only: status, duration, job id, a short redacted tail; no tool takes a recipient', async () => {
  const { client, sent } = fakeTelegram();
  const bot = createOperatorBot({ client, ownerChatId: OWNER_CHAT, approvals: createApprovalStore(), hub: {} });
  const out = operatorOutcome({ ...DONE, exit_code: 2, stdout: '', stderr: `${Array.from({ length: 30 }, (_, i) => `err ${i}`).join('\n')}\ntoken=${GITHUB_TOKEN}\n` });
  assert.equal(out.status, 'failed');
  await bot.notifyJob({ kind: 'operator', host: 'vps', job_id: 'j_bbbbbbbbbbbbbbbbbbbb', label: 'operator_script', principal: 'oidc:a', ...out, output_tail: out.tail });
  assert.equal(sent.length, 1);
  const [msg] = sent;
  assert.deepEqual(Object.keys(msg).sort(), ['chat_id', 'text'], 'no buttons, no other field');
  assert.equal(msg.chat_id, OWNER_CHAT);
  for (const part of ['failed', 'j_bbbbbbbbbbbbbbbbbbbb', 'exit 2', '1m 23s', 'host: vps']) assert.ok(msg.text.includes(part), part);
  assert.equal(msg.text.includes(GITHUB_TOKEN), false, 'secrets redacted');
  assert.equal(msg.text.includes('err 24'), false, 'only the last lines');
  assert.ok(msg.text.includes('err 29'));
  assert.ok(msg.text.length <= 1500);
  assert.equal(out.tail.includes(GITHUB_TOKEN), false, 'the inbox tail is redacted too');
  // No tool names a chat or recipient.
  for (const schema of [...NOTIFICATION_TOOLS.map(t => NOTIFICATION_SCHEMAS[t]), OPERATOR_SCHEMAS.operator_run, OPERATOR_SCHEMAS.operator_script]) {
    for (const key of Object.keys(schema.shape)) assert.equal(/chat|recipient|to$|telegram/i.test(key), false, key);
  }
});

test('#35: without Telegram, or when it fails, the notice still lands in the inbox and the failure is journaled', async () => {
  const answers = new Map([['j_cccccccccccccccccccc', DONE], ['j_dddddddddddddddddddd', DONE]]);
  const off = notifier({ answers });
  off.n.watch({ kind: 'operator', host: 'mac', job_id: 'j_cccccccccccccccccccc', label: 'operator_run', principal: A });
  await off.n.pollOnce();
  assert.equal(off.n.check(A.id).unread, 1);
  assert.equal(off.n.get(A.id).notifications[0].telegram, 'unavailable');
  assert.ok(off.journal.some(e => e.event === 'notification_unsent' && e.reason === 'telegram_unavailable'));
  const { client } = fakeTelegram({ fail: true });
  const bot = createOperatorBot({ client, ownerChatId: OWNER_CHAT, approvals: createApprovalStore(), hub: {} });
  const broken = notifier({ answers, send: x => bot.notifyJob(x) });
  broken.n.watch({ kind: 'operator', host: 'mac', job_id: 'j_dddddddddddddddddddd', label: 'operator_run', principal: A });
  await broken.n.pollOnce();
  assert.equal(broken.n.check(A.id).unread, 1);
  assert.equal(broken.n.get(A.id).notifications[0].telegram, 'failed');
  assert.ok(broken.journal.some(e => e.event === 'notification_unsent' && e.reason === 'telegram_unreachable:sendMessage'));
});

test('#35: the inbox is per principal and bounded; watches are bounded and deduplicated', async () => {
  const answers = new Map();
  const { n } = notifier({ answers, limits: { perPrincipal: 3, watchesPerPrincipal: 4, watches: 6 } });
  for (let i = 0; i < 5; i++) {
    const id = `j_${String(i).repeat(20)}`;
    answers.set(id, DONE);
    assert.equal(n.watch({ kind: 'operator', host: 'mac', job_id: id, label: 'operator_run', principal: A }).registered, i < 4);
  }
  assert.equal(n.watch({ kind: 'operator', host: 'mac', job_id: 'j_00000000000000000000', label: 'x', principal: A }).already, true);
  assert.equal(n.watch({ kind: 'operator', host: 'mac', job_id: 'j_bbbbbbbbbbbbbbbbbbbb', label: 'x', principal: A }).reason, 'too_many_watches');
  await n.pollOnce();
  assert.equal(n.check(A.id).total, 3, 'the oldest notice is dropped beyond the bound');
  assert.deepEqual(n.get(A.id).notifications.map(x => x.job_id), ['j_33333333333333333333', 'j_22222222222222222222', 'j_11111111111111111111']);
  assert.equal(n.check(B.id).total, 0, 'another principal sees nothing');
  assert.equal(n.get(B.id, { notification_id: n.get(A.id).notifications[0].notification_id }).error, 'unknown_notification');
  assert.equal(n.ack(B.id, { all: true }).acked, 0);
  assert.equal(n.check(A.id).unread, 3);
  assert.ok(NOTIFY_LIMITS.perPrincipal >= 10 && NOTIFY_LIMITS.watches >= 10);
});

test('#35: runtime statuses, permanent poll errors and an expired watch all end the watch with a notice', async () => {
  assert.equal(runtimeOutcome({ ok: true, job: { status: 'queued' } }).done, false);
  const r = runtimeOutcome({ ok: true, job: { status: 'failed', exit_code: 1, started_at: '2026-10-14T20:00:00Z', ended_at: '2026-10-14T20:02:05Z',
    summary: `x\nAuthorization: Bearer ${GITHUB_TOKEN}\nlast` } });
  assert.deepEqual([r.done, r.status, r.exit_code, r.duration_ms], [true, 'failed', 1, 125_000]);
  assert.equal(r.tail.includes(GITHUB_TOKEN), false);
  assert.equal(operatorOutcome({ ok: true, status: 'lost' }).status, 'lost');
  assert.equal(operatorOutcome({ ...DONE, timed_out: true, exit_code: null }).status, 'timed_out');
  let t = 1_000_000;
  const answers = new Map([['j_eeeeeeeeeeeeeeeeeeee', { ok: false, error: 'unknown_job' }], ['j_ffffffffffffffffffff', { ok: false, error: 'host_offline' }]]);
  const { n } = notifier({ answers, now: () => t });
  n.watch({ kind: 'operator', host: 'mac', job_id: 'j_eeeeeeeeeeeeeeeeeeee', label: 'operator_run', principal: A, timeout_s: 10 });
  n.watch({ kind: 'operator', host: 'mac', job_id: 'j_ffffffffffffffffffff', label: 'operator_run', principal: A, timeout_s: 10 });
  await n.pollOnce(); await n.pollOnce();
  assert.equal(n.check(A.id).total, 0, 'two errors are not enough');
  await n.pollOnce();
  assert.deepEqual(n.get(A.id).notifications.map(x => [x.job_id, x.status]), [['j_eeeeeeeeeeeeeeeeeeee', 'unknown']]);
  // Older jobs are polled less often: once a minute after 2 min.
  let polls = 0;
  const slow = notifier({ answers: new Map([['j_gggggggggggggggggggg', () => { polls++; return { ok: true, status: 'running' }; }]]), now: () => t });
  slow.n.watch({ kind: 'operator', host: 'mac', job_id: 'j_gggggggggggggggggggg', label: 'operator_run', principal: A, timeout_s: 3600 });
  await slow.n.pollOnce(); await slow.n.pollOnce();
  assert.equal(polls, 2, 'every tick while young');
  t += 3 * 60_000;
  await slow.n.pollOnce(); await slow.n.pollOnce();
  assert.equal(polls, 3, 'then at most once a minute');
  t += 61_000;
  await slow.n.pollOnce();
  assert.equal(polls, 4);
  t += 10_000 + 31 * 60_000;
  await n.pollOnce();
  assert.equal(n.get(A.id).notifications[0].status, 'watch_expired', 'an offline host ends as watch_expired after its timeout and grace');
  assert.ok(telegramText(n.get(A.id).notifications[0]).includes('no exit code'));
});

// ---- the hub, end to end -------------------------------------------------------------------

async function hubStack(t, { withBot = true } = {}) {
  const mac = makeHost(t, { host: 'mac', policy: { max_tier: 'exec', approval_mode: 'off' } });
  const { tlsKey, tlsCert } = tls(t);
  const opKeys = operatorKeys();
  const ids = { 'operator-mac': generateAgentIdentity(), vps: generateAgentIdentity(), mac: generateAgentIdentity(), 'operator-vps': generateAgentIdentity() };
  const audit = [];
  const hub = createHub({ tlsKey, tlsCert, tokenSha256: 'a'.repeat(64), port: 0, audit: ev => audit.push(ev), runtimeHost: 'vps',
    allowedAgentKeys: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.publicKey])),
    operator: { signingKeyPem: opKeys.privateKeyPem, freezeFile: mac.p('state/HUB-FROZEN'), anchorIntervalMs: 0, notifyPollMs: 40,
      approvalModes: { mac: 'off', vps: 'off' } } });
  const telegram = fakeTelegram();
  if (withBot) hub.attachOperatorBot(createOperatorBot({ client: telegram.client, ownerChatId: OWNER_CHAT, approvals: hub.operatorApprovals, hub: {} }));
  const { port } = await hub.start();
  t.after(() => hub.stop());
  const url = `wss://127.0.0.1:${port}/agent`;
  // operator-mac: real exec tools and a real background job store.
  const verifier = createOperatorVerifier({ publicKeys: [opKeys.publicKeyPem], host: 'mac' });
  const tools = { ...createOperatorTools(mac.policy, { projects: async () => [], platform: 'linux' }),
    ...createOperatorExecTools(mac.policy, { jobs: createJobStore({ dir: mac.p('state/jobs') }), projects: async () => [], platform: 'linux' }) };
  const { handlers } = createOperatorOperations({ policy: mac.policy, verifier, guard: createOperatorGuard(mac.policy, { autoFrozenFile: mac.p('state/AUTO') }),
    chain: createAuditChain({ store: fileAuditStore(mac.policy.auditFile) }), tools });
  const opAgent = createAgent({ host: 'operator-mac', url, privateKey: ids['operator-mac'].privateKey, ca: tlsCert, reconnectMs: 100_000,
    operations: { host_status: async () => ({ host: 'operator-mac', online: true }), ...handlers } });
  t.after(() => opAgent.stop());
  // vps: a fake runtime serving jobs_submit, job_status and sessions_overview.
  const runtime = { submitted: [], polls: 0, status: 'running' };
  const job = () => ({ job_id: 'job_AAAAAAAAAAAAAAAA', recipe: 'test', status: runtime.status, exit_code: runtime.status === 'succeeded' ? 0 : null,
    timeout_seconds: 900, started_at: '2026-10-14T20:00:00.000Z', ended_at: runtime.status === 'running' ? null : '2026-10-14T20:00:42.000Z',
    summary: 'tests 12\npass 12' });
  const rtAgent = createAgent({ host: 'vps', url, privateKey: ids.vps.privateKey, ca: tlsCert, reconnectMs: 100_000, operations: {
    host_status: async () => ({ host: 'vps', online: true }),
    jobs_submit: async args => { runtime.submitted.push(args); return { ok: true, job: job() }; },
    job_status: async () => { runtime.polls++; return { ok: true, job: job() }; },
    sessions_overview: async () => ({ ok: true, sessions: [], you: { workspaces: [] } }) } });
  t.after(() => rtAgent.stop());
  await until(() => hub.agentInfo('operator-mac')?.version === 2 && hub.agentInfo('vps')?.version === 2);
  return { hub, mac, audit, telegram, runtime };
}

test('#35 hub: operator_run background notify:true is watched, signed without notify, notified once, and read back through the tools', async t => {
  const { hub, mac, audit, telegram } = await hubStack(t);
  const started = await hub.requestOperator('mac', 'operator_run', { args: { host: 'mac', argv: ['date', '+%s'], background: true, notify: true, timeout_s: 60 }, principal: OWNER });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(started.notify, { registered: true });
  await until(async () => (await hub.requestOperator(undefined, 'notifications_check', { args: {}, principal: OWNER })).unread === 1);
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].chat_id, OWNER_CHAT);
  assert.ok(telegram.sent[0].text.includes(started.job_id) && telegram.sent[0].text.includes('succeeded'));
  // The host never saw notify: not in the signed arguments it journaled.
  const lines = readFileSync(mac.policy.auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const run = lines.find(l => l.op === 'operator_run');
  assert.equal(JSON.stringify(run.args).includes('notify'), false);
  assert.ok(lines.some(l => l.op === 'operator_job_status' && l.principal === OWNER.id), 'polled with the starter\'s principal');
  const got = await hub.requestOperator(undefined, 'notifications_get', { args: {}, principal: OWNER });
  const [item] = got.untrusted_content.notifications;
  assert.deepEqual([item.job_id, item.status, item.host, item.label, item.telegram], [started.job_id, 'succeeded', 'mac', 'operator_run', 'sent']);
  assert.match(item.output_tail, /^\d+$/);
  // The read-only principal has no operator:read: its inbox tools are refused.
  assert.equal((await hub.requestOperator(undefined, 'notifications_check', { args: {}, principal: READER })).error, 'forbidden');
  const acked = await hub.requestOperator(undefined, 'notifications_ack', { args: { all: true }, principal: OWNER });
  assert.deepEqual([acked.ok, acked.acked, acked.unread], [true, 1, 0]);
  assert.equal((await hub.requestOperator(undefined, 'notifications_check', { args: {}, principal: OWNER })).unread, 0);
  assert.ok(audit.some(e => e.event === 'notification_sent'));
  // A foreground run with notify answers why nothing is watched.
  const fg = await hub.requestOperator('mac', 'operator_run', { args: { host: 'mac', argv: ['date', '+%s'], notify: true }, principal: OWNER });
  assert.deepEqual(fg.notify, { registered: false, reason: 'foreground' });
});

test('#35 hub: jobs_submit notify:true never reaches the runtime, is watched, notified, and counted in sessions_overview', async t => {
  const { hub, telegram, runtime } = await hubStack(t);
  const out = await hub.requestAgent('vps', 'jobs_submit', { args: { workspace_id: 'ws_AAAAAAAAAAAAAAAA', worktree_id: 'wt1', recipe: 'test', notify: true }, principal: OWNER });
  assert.equal(out.ok, true);
  assert.deepEqual(out.notify, { registered: true });
  assert.equal(Object.hasOwn(runtime.submitted[0], 'notify'), false, 'stripped before the runtime');
  await until(() => runtime.polls >= 1);
  runtime.status = 'succeeded';
  await until(() => hub.operatorNotifications.check(OWNER.id).unread === 1);
  assert.equal(telegram.sent.length, 1);
  assert.ok(telegram.sent[0].text.includes('job_AAAAAAAAAAAAAAAA') && telegram.sent[0].text.includes('recipe: test') && telegram.sent[0].text.includes('42s'));
  const overview = await hub.requestAgent('vps', 'sessions_overview', { args: {}, principal: OWNER });
  assert.deepEqual(overview.notifications, { unread: 1, total: 1, watching: 0, latest_unread_at: overview.notifications.latest_unread_at });
  // Without notify nothing is watched.
  const plain = await hub.requestAgent('vps', 'jobs_submit', { args: { workspace_id: 'ws_AAAAAAAAAAAAAAAA', worktree_id: 'wt1', recipe: 'test' }, principal: OWNER });
  assert.equal(plain.notify, undefined);
  assert.equal(hub.operatorNotifications.watching, 0);
});

test('#35 hub: without a Telegram bot the completion still lands in the inbox, and the hub journals notification_unsent', async t => {
  const { hub, audit, runtime } = await hubStack(t, { withBot: false });
  runtime.status = 'failed';
  await hub.requestAgent('vps', 'jobs_submit', { args: { workspace_id: 'ws_AAAAAAAAAAAAAAAA', worktree_id: 'wt1', recipe: 'test', notify: true }, principal: OWNER });
  await until(() => hub.operatorNotifications.check(OWNER.id).unread === 1);
  assert.equal(hub.operatorNotifications.get(OWNER.id).notifications[0].telegram, 'unavailable');
  assert.ok(audit.some(e => e.event === 'notification_unsent' && e.reason === 'telegram_unavailable'));
});

test('#35: the inbox tools are listed on both surfaces as T0 hub tools; notify is in the schemas of the three starters', async () => {
  const { REMOTE_OPERATOR_TOOLS, collectOperatorDefinitions, collectToolDefinitions, operatorRegistryProblems } = await import('../server/registry.mjs');
  const defs = await collectOperatorDefinitions();
  assert.deepEqual(operatorRegistryProblems(defs), []);
  for (const name of NOTIFICATION_TOOLS) {
    assert.ok(REMOTE_OPERATOR_TOOLS.includes(name), name);
    assert.equal(defs.get(name).annotations.readOnlyHint, true, name);
  }
  for (const op of ['operator_run', 'operator_script']) assert.equal(OPERATOR_SCHEMAS[op].safeParse({ host: 'mac', argv: ['x'], interpreter: 'bash', content: 'x', notify: true }).data?.notify, true, op);
  const runtime = await collectToolDefinitions();
  assert.equal(runtime.get('jobs_submit').inputSchema.shape.notify !== undefined, true);
});
