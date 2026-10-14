// Phase 6, TODO-P6-10 (R-P6-04, R-P6-05, R-P6-07; AC-P6-09 executor part, AC-P6-07 helper
// ownership part): the root helper. Its own signature check, tier and approval checks, the
// systemd-run argv it hands to the executor (a recorder: systemd is never called), the script
// file, the journal it owns, and the agent talking to it over a real Unix socket.
// The real systemd behaviour on lab (unit gone after the call, limits applied) is runtime-pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRootHelper, createRootHelperClient, createRootHelperServer, systemdRunArgv } from '../bridge/operator-root-helper.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore, helperAuditChain, verifyChain } from '../bridge/operator-audit.mjs';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { createOperatorExecTools } from '../bridge/operator-exec.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { makeHost, signingPair } from './helpers/operator-fixture.mjs';

const PRINCIPAL = 'oidc:owner';
let n = 0;
const nextId = () => `req_${String(++n).padStart(16, '0')}`;

function rootHost(t, { approvalMode = 'dangerous', executor } = {}) {
  // A short socket directory: Unix socket paths are limited to about 104 bytes on macOS.
  const sockDir = realpathSync(mkdtempSync(join('/tmp', 'mop-')));
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));
  const h = makeHost(t, { policy: { max_tier: 'root', approval_mode: approvalMode, root_helper: { socket: join(sockDir, 'root.sock') },
    state_dir: undefined } });
  const pair = signingPair({ clock: { t: Date.now() } });
  pair.clock.t = Date.now();
  const calls = [];
  const exec = executor ?? (async (argv, opts) => { calls.push({ argv, opts }); return { code: 0, stdout: 'uid=0\n', stderr: '', truncated: false }; });
  // The helper has its own verifier (own nonce cache) over the same hub key, its own guard and chain.
  const helperVerifier = createOperatorVerifier({ publicKeys: [pair.keys.publicKeyPem], host: 'vps', now: () => pair.clock.t });
  const chain = createAuditChain({ store: fileAuditStore(h.p('state/root-audit.jsonl')) });
  const guard = createOperatorGuard(h.policy, { autoFrozenFile: h.p('state/ROOT-AUTO-FROZEN') });
  const helper = createRootHelper({ policy: h.policy, verifier: helperVerifier, guard, chain, executor: exec, scriptDir: h.p('state/scripts'),
    jobs: createJobStore({ dir: h.p('state/rjobs'), prefix: 'rj' }), projects: async () => [], now: () => pair.clock.t });
  const sign = (op, args, extra = {}) => {
    const id = nextId();
    return { type: 'call', id, op, args, principal: PRINCIPAL,
      operator: pair.signer.sign({ id, op, host: 'vps', tier: extra.tier ?? 3, principal: PRINCIPAL, args, approval: extra.approval ?? null }) };
  };
  return { ...h, pair, helper, calls, sign, chain, guard, sockDir };
}

test('AC-P6-09 (executor): as_root runs become one systemd-run --wait --pipe --collect transient unit with limits', async t => {
  const r = rootHost(t, { approvalMode: 'off' });
  const out = await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id', '-u'], as_root: true, timeout_s: 20, env: { LANG: 'C' } }));
  assert.equal(out.ok, true);
  assert.equal(out.untrusted_content.stdout, 'uid=0\n');
  assert.match(out.unit, /^memo-op-[0-9a-f]{12}$/);
  const { argv, opts } = r.calls[0];
  assert.deepEqual(argv.slice(0, 5), ['systemd-run', '--quiet', '--collect', '--wait', '--pipe']);
  assert.ok(argv.includes(`--unit=${out.unit}`));
  assert.ok(argv.includes('--property=RuntimeMaxSec=20s'));
  assert.ok(argv.includes('--property=MemoryMax=2G'));
  assert.ok(argv.includes('--property=TasksMax=512'));
  assert.ok(argv.includes('--working-directory=/'));
  assert.ok(argv.includes('--setenv=LANG=C'));
  assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', 'id', '-u'], 'the program follows --, argv only');
  assert.equal(opts.timeoutMs, 35_000, 'the client waits RuntimeMaxSec plus a margin');
  // Shell metacharacters stay one argv slot.
  assert.deepEqual(systemdRunArgv({ unit: 'u', description: 'd', argv: ['echo', 'a;id'], timeoutS: 5 }).slice(-3), ['--', 'echo', 'a;id']);
});

test('operator_script: content goes to a root-only file, run by a fixed interpreter path, removed after', async t => {
  let seen = null;
  const r = rootHost(t, { approvalMode: 'off', executor: async argv => {
    const script = argv[argv.indexOf('--') + 2];
    seen = { argv, mode: statSync(script).mode & 0o777, content: readFileSync(script, 'utf8'), script };
    return { code: 0, stdout: 'ok', stderr: '' };
  } });
  const out = await r.helper.handle(r.sign('operator_script', { host: 'vps', interpreter: 'bash', content: 'echo "$1"; id', args: ['a b'] }));
  assert.equal(out.ok, true);
  assert.deepEqual(seen.argv.slice(seen.argv.indexOf('--')), ['--', '/bin/bash', seen.script, 'a b']);
  assert.equal(seen.mode, 0o700);
  assert.equal(seen.content, 'echo "$1"; id');
  assert.equal(existsSync(seen.script), false, 'the script file is removed after the run');
});

test('the helper checks the signature, tier, approval and freeze itself; nothing runs on a refusal', async t => {
  const r = rootHost(t, { approvalMode: 'dangerous' });
  // Unsigned, forged, wrong tier: refused before anything.
  const unsigned = { type: 'call', id: nextId(), op: 'operator_run', args: { host: 'vps', argv: ['id'], as_root: true }, principal: PRINCIPAL };
  assert.equal((await r.helper.handle(unsigned)).error, 'signature_missing');
  const tampered = r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true });
  tampered.args = { ...tampered.args, argv: ['rm', '-rf', '/'] };
  assert.equal((await r.helper.handle(tampered)).error, 'args_mismatch');
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true }, { tier: 2 }))).error, 'tier_mismatch');
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id'] }, { tier: 2 }))).error, 'tier_mismatch', 'a T2 run is not the helper\'s');
  // Replay of a valid request: the helper's own nonce cache.
  const once = r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true });
  assert.equal((await r.helper.handle(once)).ok, true);
  assert.equal((await r.helper.handle(once)).error, 'replayed');
  // Five signature or tier refusals: the helper froze itself (its own auto-freeze marker).
  assert.equal(r.guard.status().auto, true);
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true }))).error, 'frozen');
  r.guard.clearAuto();
  // Dangerous mode: a script, or rm, without a signed approval id is refused.
  assert.equal((await r.helper.handle(r.sign('operator_script', { host: 'vps', interpreter: 'bash', content: 'id' }))).error, 'approval_required');
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['rm', '-rf', '/srv/x'], as_root: true }))).error, 'approval_required');
  const approved = await r.helper.handle(r.sign('operator_script', { host: 'vps', interpreter: 'bash', content: 'id' }, { approval: 'ap_' + 'a'.repeat(24) }));
  assert.equal(approved.ok, true);
  // FROZEN on the host: refused.
  writeFileSync(r.policy.frozenFile, '');
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true }))).error, 'frozen');
  rmSync(r.policy.frozenFile);
  assert.equal(r.calls.length, 2, 'only the two admitted calls reached systemd-run');
  assert.equal(r.guard.status().auto, false, 'two approval refusals stay under the auto-freeze threshold');
  // Every call, refusals included, is in the helper's journal.
  const lines = readFileSync(r.p('state/root-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.every(l => l.source === 'root-helper'));
  assert.equal(lines.filter(l => l.outcome === 'ok').length, 2);
  assert.equal(lines.find(l => l.code === 'approval_required').op, 'operator_script');
  assert.equal(lines.find(l => l.approval !== null && l.outcome === 'ok').approval, 'ap_' + 'a'.repeat(24));
});

test('over the socket: the agent forwards T3 and journals through the helper; the journal file is the helper\'s alone', async t => {
  const r = rootHost(t, { approvalMode: 'off' });
  const server = createRootHelperServer({ helper: r.helper, socketPath: r.policy.rootHelper.socket });
  await server.start();
  t.after(() => server.stop());
  assert.equal(statSync(r.policy.rootHelper.socket).mode & 0o777, 0o660);
  const client = createRootHelperClient({ socketPath: r.policy.rootHelper.socket, timeoutMs: 5000 });
  const chain = helperAuditChain(client);
  const agentVerifier = createOperatorVerifier({ publicKeys: [r.pair.keys.publicKeyPem], host: 'vps', now: () => r.pair.clock.t });
  const guard = createOperatorGuard(r.policy, { autoFrozenFile: r.p('state/AUTO-FROZEN') });
  const tools = { ...createOperatorTools(r.policy, { guard, chain, projects: async () => [], platform: 'linux' }),
    ...createOperatorExecTools(r.policy, { platform: 'linux', projects: async () => [] }) };
  const { handlers } = createOperatorOperations({ policy: r.policy, verifier: agentVerifier, guard, chain, tools, rootHelper: client,
    now: () => r.pair.clock.t });
  const call = async (op, args, tier) => {
    const id = nextId();
    return handlers[op](args, { id, op, principal: { id: PRINCIPAL }, operator: r.pair.signer.sign({ id, op, host: 'vps', tier, principal: PRINCIPAL, args }) });
  };
  const root = await call('operator_run', { host: 'vps', argv: ['id', '-u'], as_root: true }, 3);
  assert.deepEqual([root.ok, root.as_root, root.untrusted_content.stdout], [true, true, 'uid=0\n']);
  assert.equal((await call('operator_policy', { host: 'vps' }, 0)).ok, true);
  const verified = await call('operator_audit_verify', { host: 'vps' }, 0);
  assert.equal(verified.chain_ok, true);
  // agent line (forward) + helper line (run) + agent line (policy) = 3 before the verify call.
  assert.equal(verified.lines, 3);
  const lines = readFileSync(r.p('state/root-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.source, l.op]), [['root-helper', 'operator_run'], ['agent', 'operator_run'], ['agent', 'operator_policy'],
    ['agent', 'operator_audit_verify']]);
  // The agent's side has no file to write and no socket verb to change a line.
  assert.equal(typeof chain.append, 'function');
  assert.equal('store' in chain, false);
  for (const type of ['audit_rewrite', 'audit_truncate', 'audit_set', 'exec']) {
    assert.deepEqual(await client.request({ type }), { ok: false, error: 'invalid_request' }, type);
  }
  assert.deepEqual(await client.request({ type: 'audit_append', fields: { op: 'x;y', outcome: 'ok' } }), { ok: false, error: 'invalid_request' });
  assert.equal(verifyChain(readFileSync(r.p('state/root-audit.jsonl'), 'utf8')).ok, true);
  // The root journal's mode: 0600 (owner root on lab; the agent user is not the owner there).
  assert.equal(statSync(r.p('state/root-audit.jsonl')).mode & 0o777, 0o600);
  // On the Mac (no helper), T3 answers root_unavailable_on_host.
  const mac = createOperatorOperations({ policy: r.policy, verifier: agentVerifier, guard, chain: null, tools, rootHelper: null });
  const id = nextId();
  const args = { host: 'vps', argv: ['id'], as_root: true };
  const out = await mac.handlers.operator_run(args, { id, op: 'operator_run', principal: { id: PRINCIPAL },
    operator: r.pair.signer.sign({ id, op: 'operator_run', host: 'vps', tier: 3, principal: PRINCIPAL, args }) });
  assert.equal(out.error, 'root_unavailable_on_host');
});

test('helper: unknown socket peers get nothing without a signature; a dead helper answers root_helper_unavailable', async t => {
  const r = rootHost(t);
  const client = createRootHelperClient({ socketPath: join(r.sockDir, 'missing.sock'), timeoutMs: 2000 });
  assert.deepEqual(await client.request({ type: 'status' }), { ok: false, error: 'root_helper_unavailable' });
  assert.deepEqual(await r.helper.handle({ type: 'call', op: 'operator_run', args: {} }), { ok: false, error: 'signature_missing' });
  assert.deepEqual(await r.helper.handle({ type: 'call', op: 'operator_read', args: {} }), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await r.helper.handle('x'), { ok: false, error: 'invalid_request' });
});
