import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createOperatorSigner, createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMacCheckoutAuthority, checkoutRootFor, checkoutTargetFor } from '../bridge/mac-checkout-authority.mjs';
import { createOperatorOperations } from '../bridge/operator-agent.mjs';
import { z } from 'zod/v4';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'memo-mac-broker-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = join(tmp, 'one'), other = join(tmp, 'other');
  mkdirSync(repo); mkdirSync(other);
  for (const dir of [repo, other]) {
    execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    mkdirSync(join(dir, 'sub'));
  }
  const stateDir = join(tmp, 'private-state');
  return { tmp, repo, other, stateDir };
}

test('real Git top-level is canonical for nested folders and symlinks', t => {
  const { tmp, repo, other } = fixture(t);
  const symlink = join(tmp, 'link'); symlinkSync(join(repo, 'sub'), symlink);
  assert.equal(checkoutRootFor(join(repo, 'sub')).root, realpathSync.native(repo));
  assert.equal(checkoutRootFor(symlink).root, realpathSync.native(repo));
  assert.equal(checkoutRootFor(other).root, realpathSync.native(other));
  assert.equal(checkoutRootFor(tmp).root, null);
  assert.equal(checkoutRootFor(repo + '/../other').error, 'checkout_scope_unknown');
  assert.equal(checkoutRootFor(join(tmp, 'not-present')).error, 'checkout_root_unverified');
  const unsafe = Object.assign(new Error('unsafe repository'), {
    status: 128, stderr: Buffer.from('fatal: detected dubious ownership')
  });
  assert.equal(checkoutRootFor(repo, { git: () => { throw unsafe; } }).error, 'checkout_root_unverified',
    'git exit code 128 without a verified non-repo error must fail closed');
});

test('local and remote principals use the identical persisted lease on the Mac', t => {
  const { repo, other, stateDir } = fixture(t);
  const authority = createMacCheckoutAuthority({ stateDir });
  const local = { root: repo, session: A, principal: 'local:mac-supervised' };
  assert.equal(authority.acquire(local).ok, true);
  const sameRepo = { path: join(repo, 'sub', 'new.txt'), mode: 'write', new_text: 'x' };
  assert.equal(authority.guard('operator_edit', sameRepo, { session: B, principal: 'oidc:owner' }).error,
    'locked_by_other_session');
  assert.equal(authority.guard('operator_edit', sameRepo, { session: A, principal: 'local:mac-supervised' }).ok, true);
  // A symlinked file within repo two points at repo one: guard its physical target.
  writeFileSync(join(repo, 'sub', 'shared.txt'), 'original');
  symlinkSync(join(repo, 'sub', 'shared.txt'), join(other, 'sub', 'alias.txt'));
  assert.equal(authority.guard('operator_edit', { path: join(other, 'sub', 'alias.txt') },
    { session: B, principal: 'oidc:owner' }).error, 'locked_by_other_session');
  assert.equal(authority.guard('operator_edit', { path: join(other, 'sub', 'x') },
    { session: B, principal: 'oidc:owner' }).ok, true);
  assert.equal(authority.guard('operator_edit', sameRepo, { principal: 'oidc:owner' }).error, 'session_required');
  assert.equal(authority.release(local).ok, true);
  assert.equal(authority.guard('operator_edit', sameRepo, { session: B, principal: 'oidc:owner' }).ok, true);
  assert.equal(authority.acquire(local).error, 'checkout_lease_revoked');
  assert.equal(existsSync(join(stateDir, 'checkout_leases.json')), true);
});

test('failed states, upload completion and ambiguous scripts fail closed', t => {
  const { repo, stateDir } = fixture(t);
  const authority = createMacCheckoutAuthority({ stateDir });
  const ctx = { principal: 'oidc:owner', session: B };
  assert.equal(authority.guard('operator_script', { cwd: repo }, ctx).error, 'checkout_scope_unknown');
  assert.equal(authority.guard('operator_upload_complete', { upload_id: 'up_123' }, ctx).error, 'checkout_scope_unknown');
  assert.equal(authority.guard('operator_run', { argv: ['git', '-C', repo, 'switch', 'branch'], cwd: repo }, ctx).error,
    'checkout_target_ambiguous');
  assert.equal(authority.guard('operator_run', { argv: ['git', 'switch', '-c', 'one'] }, ctx).error, 'checkout_scope_unknown');
  assert.equal(authority.guard('operator_run', { argv: ['git', 'status'], cwd: repo }, ctx).ok, true);
  assert.equal(checkoutTargetFor('operator_copy', { src: join(repo, 'sub', 'x'), dst: join(repo, 'sub', 'y') }).directories.length, 2);
});

test('cross-repository move is refused before acquiring any lease', t => {
  const { repo, other, stateDir } = fixture(t);
  const authority = createMacCheckoutAuthority({ stateDir });
  const ctx = { principal: 'oidc:owner', session: A };
  const out = authority.guard('operator_move', { src: join(repo, 'sub', 'x'), dst: join(other, 'sub', 'x') }, ctx);
  assert.equal(out.error, 'checkout_cross_repo_not_supported');
  assert.equal(authority.guard('operator_edit', { path: join(repo, 'sub', 'x') }, { principal: 'local:test', session: B }).ok,
    true, 'no partially acquired lease');
});

test('signed operator-agent executes no mutation when local wrapper owns its target', async t => {
  const { repo, stateDir } = fixture(t);
  const authority = createMacCheckoutAuthority({ stateDir });
  assert.equal(authority.acquire({ root: repo, session: A, principal: 'local:mac-supervised' }).ok, true);
  let writes = 0;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = createOperatorSigner({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const verifier = createOperatorVerifier({
    publicKeys: [publicKey.export({ type: 'spki', format: 'pem' })], host: 'mac'
  });
  const { handlers } = createOperatorOperations({
    policy: { host: 'mac', maxTier: 2, approvalMode: 'off', permanentGrants: [] },
    verifier,
    guard: { admit: () => null, refused: () => false },
    tools: { broker_test: async () => { writes++; return { ok: true }; } },
    checkoutAuthority: authority,
    tierOf: () => 1,
    schemas: { broker_test: z.object({ host: z.literal('mac'), path: z.string() }) },
    ops: ['broker_test']
  });
  // Distinct signed session B: refuses before invoking the tool.
  const args = { host: 'mac', path: join(repo, 'sub', 'x') };
  const id = 'signed-request-1';
  const ctx = { id, principal: { id: 'oidc:owner' },
    operator: signer.sign({ id, op: 'broker_test', host: 'mac', tier: 1, principal: 'oidc:owner', args, clientSession: B }),
    meta: { client_session: B } };
  assert.equal((await handlers.broker_test(args, ctx)).error, 'locked_by_other_session');
  assert.equal(writes, 0);
  const oldId = 'signed-request-legacy';
  const legacy = { ...ctx, id: oldId, operator: signer.sign({
    id: oldId, op: 'broker_test', host: 'mac', tier: 1, principal: 'oidc:owner', args
  }) };
  assert.equal((await handlers.broker_test(args, legacy)).error, 'session_unbound',
    'legacy v1 is denied when Mac-side authority is enabled');
  const swapId = 'signed-request-swap';
  const swapped = { ...ctx, id: swapId, operator: signer.sign({
    id: swapId, op: 'broker_test', host: 'mac', tier: 1, principal: 'oidc:owner', args, clientSession: B
  }), meta: { client_session: C } };
  assert.equal((await handlers.broker_test(args, swapped)).error, 'session_mismatch',
    'swapping the unsigned transport metadata cannot impersonate another session');
  assert.equal(writes, 0);
  const forged = { ...args, session: A };
  // Caller-supplied args are either rejected by signature verification or
  // discarded by schema parsing; they never become the transport's session.
  const secondId = 'signed-request-2';
  const secondCtx = { ...ctx, id: secondId, operator: signer.sign({
    id: secondId, op: 'broker_test', host: 'mac', tier: 1, principal: 'oidc:owner', args: forged, clientSession: B
  }) };
  assert.equal((await handlers.broker_test(forged, secondCtx)).error,
    'locked_by_other_session');
  assert.equal(writes, 0);
});

test('two independent local processes contend and the refused one never launches', { skip: process.platform !== 'darwin' }, async t => {
  const { repo, stateDir } = fixture(t);
  const script = new URL('../scripts/with-checkout-lease.mjs', import.meta.url).pathname;
  const launch = code => spawn(process.execPath,
    [script, '--repo', repo, '--state-dir', stateDir, '--', process.execPath, '-e', code],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const first = launch('setInterval(() => {}, 1000)');
  t.after(() => { try { first.kill('SIGTERM'); } catch { /* exited */ } });
  const started = Date.now();
  while (!existsSync(join(stateDir, 'checkout_leases.json'))) {
    if (Date.now() - started > 4_000) assert.fail('lease was never acquired');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const before = execFileSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
  const second = launch("require('node:fs').writeFileSync('SHOULD_NOT_EXIST','bad')");
  let stderr = '';
  second.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    second.once('error', reject); second.once('exit', resolve);
  });
  assert.equal(code, 73, stderr);
  assert.equal(existsSync(join(repo, 'SHOULD_NOT_EXIST')), false);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' }), before);
  first.kill('SIGTERM');
  await new Promise(resolve => first.once('exit', resolve));
  const authority = createMacCheckoutAuthority({ stateDir });
  assert.equal(authority.guard('operator_edit', { path: join(repo, 'new') },
    { principal: 'oidc:owner', session: C }).ok, true);
});

test('regression: a supervised child group must retain the checkout until its surviving grandchild exits',
  { skip: process.platform !== 'darwin' }, async t => {
  const { repo, stateDir } = fixture(t);
  const script = new URL('../scripts/with-checkout-lease.mjs', import.meta.url).pathname;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const workerCode = "setTimeout(() => require('node:fs').writeFileSync('GRANDCHILD_DONE', 'ok'), 850)";
  const parentCode = "const {spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e'," + JSON.stringify(workerCode) + "],{stdio:'ignore'}).unref();";
  const wrap = code => spawn(process.execPath,
    [script, '--repo', repo, '--state-dir', stateDir, '--', process.execPath, '-e', code],
    { stdio: ['ignore','ignore','pipe'] });
  const holder = wrap(parentCode);
  let holderErr = '';
  holder.stderr.on('data', data => { holderErr += data.toString(); });
  t.after(() => { try { holder.kill('SIGTERM'); } catch { /* already finished */ } });
  const leaseFile = join(stateDir, 'checkout_leases.json');
  const started = Date.now();
  while (!existsSync(leaseFile)) {
    if (Date.now() - started > 4000) assert.fail('holder did not acquire checkout');
    await delay(25);
  }
  await delay(250); // parent has exited; grandchild should still be writing later
  const contender = wrap("require('node:fs').writeFileSync('UNAUTHORIZED_CONTENDER','bad')");
  let refusedErr = '';
  contender.stderr.on('data', data => { refusedErr += data.toString(); });
  const contenderExit = await new Promise((resolve, reject) => {
    contender.once('error', reject);
    contender.once('exit', resolve);
  });
  assert.equal(contenderExit, 73, refusedErr);
  assert.equal(existsSync(join(repo, 'UNAUTHORIZED_CONTENDER')), false);
  const done = await Promise.race([
    new Promise(resolve => holder.once('exit', code => resolve({ code }))),
    delay(4000).then(() => ({ timeout: true }))
  ]);
  assert.equal(done.timeout, undefined, 'wrapper must finish once its process group drains');
  assert.equal(existsSync(join(repo, 'GRANDCHILD_DONE')), true,
    'supervisor must not release before its descendant has finished');
  assert.equal(done.code, 0, holderErr);
});

test('supervisor SIGTERM after the direct child exits stops surviving process-group descendants',
  { skip: process.platform !== 'darwin' }, async t => {
  const { repo, stateDir } = fixture(t);
  const script = new URL('../scripts/with-checkout-lease.mjs', import.meta.url).pathname;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const grandchildCode = "setTimeout(() => require('node:fs').writeFileSync('SHOULD_NOT_WRITE_AFTER_TERM','bad'), 1800)";
  const parentCode = "const {spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e'," + JSON.stringify(grandchildCode) + "],{stdio:'ignore'}).unref();";
  const holder = spawn(process.execPath, [script, '--repo', repo, '--state-dir', stateDir,
    '--', process.execPath, '-e', parentCode], { stdio: ['ignore','ignore','pipe'] });
  t.after(() => { try { holder.kill('SIGTERM'); } catch { /* finished */ } });
  let stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const start = Date.now();
  while (!existsSync(join(stateDir, 'checkout_leases.json'))) {
    if (Date.now() - start > 4000) assert.fail('supervisor failed to acquire checkout');
    await delay(25);
  }
  await delay(280); // direct parent has exited; grandchild is still in the group
  holder.kill('SIGTERM');
  const outcome = await Promise.race([
    new Promise(resolve => holder.once('exit', code => resolve({ code }))),
    delay(3500).then(() => ({ timeout: true }))
  ]);
  assert.equal(outcome.timeout, undefined, stderr);
  assert.equal(existsSync(join(repo, 'SHOULD_NOT_WRITE_AFTER_TERM')), false);
  const authority = createMacCheckoutAuthority({ stateDir });
  assert.equal(authority.guard('operator_edit', { path: join(repo, 'after-term') },
    { principal: 'oidc:owner', session: C }).ok, true, 'group should be stopped before release');
});

test('experimental Seatbelt writer cannot modify another checkout, including through a child process',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') }, t => {
  const { repo, other, stateDir } = fixture(t);
  createMacCheckoutAuthority({ stateDir });
  const script = new URL('../scripts/with-checkout-lease.mjs', import.meta.url).pathname;
  const target = join(other, 'ESCAPE');
  symlinkSync(other, join(repo, 'OTHER_ALIAS'));
  const linkedTarget = join(repo, 'OTHER_ALIAS', 'SYMLINK_ESCAPE');
  const child = "require('node:fs').writeFileSync(" + JSON.stringify(target) + ",'bad')";
  const code = `
const fs = require('node:fs');
const cp = require('node:child_process');
fs.writeFileSync('ALLOWED','ok');
const out = cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}], { encoding:'utf8' });
fs.writeFileSync('CHILD_EXIT_CODE', String(out.status));
if (out.status === 0) process.exit(19);
try { fs.writeFileSync(${JSON.stringify(linkedTarget)},'bad'); process.exit(20); }
catch (error) { fs.writeFileSync('LINK_DENIED', error?.code ?? 'unknown'); }
`;
  const run = spawnSync(process.execPath,
    [script, '--repo', repo, '--state-dir', stateDir, '--sandbox-strict', '--', process.execPath, '-e', code],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, JSON.stringify({ stdout: run.stdout, stderr: run.stderr }));
  assert.equal(readFileSync(join(repo, 'ALLOWED'), 'utf8'), 'ok');
  assert.notEqual(readFileSync(join(repo, 'CHILD_EXIT_CODE'), 'utf8'), '0');
  assert.equal(existsSync(target), false, 'sandbox must prevent all writes to the second repo');
  assert.equal(existsSync(join(other, 'SYMLINK_ESCAPE')), false, 'symlink must not escape Seatbelt');
  assert.notEqual(readFileSync(join(repo, 'LINK_DENIED'), 'utf8'), '', 'symlink denial observed');
});
