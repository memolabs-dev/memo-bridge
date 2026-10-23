import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorTools } from '../bridge/operator-tools.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { CAPABILITIES, operationCapability } from '../server/coordinator/policy.mjs';

async function fixture(fn, { rootEnabled = true } = {}) {
  // Canonical, as the roots of a parsed policy are (macOS tmpdir is a symlink under /private).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'memo-preflight-')));
  const write = join(dir, 'editable');
  const readonly = join(dir, 'maintenance');
  const project = join(write, 'project');
  const secret = join(dir, '.ssh', 'id_ed25519');
  await mkdir(write);
  await mkdir(readonly);
  await mkdir(project);
  await mkdir(join(dir, '.ssh'));
  await writeFile(join(write, 'notes.txt'), 'test\n');
  await writeFile(join(readonly, 'lab-backup'), 'pg_containers() {}\n');
  await writeFile(secret, 'fixture-only');
  const policy = {
    host: 'vps', home: '/nonexistent', repositories: null, denylist: [],
    readRoots: [dir], writeRoots: [write], maxTierName: rootEnabled ? 'root' : 'write',
    rootHelper: rootEnabled ? { socket: '/unit-test-only' } : null
  };
  const tools = createOperatorTools(policy, {
    maintenanceFiles: [join(readonly, 'lab-backup')]
  });
  try { await fn({ tools, write, readonly, project, secret, policy }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('preflight is a T0 read-only tool with a strict edit intent', () => {
  assert.equal(operationCapability('operator_preflight'), CAPABILITIES.OPERATOR_READ);
  assert.ok(OPERATOR_SCHEMAS.operator_preflight.safeParse({ host: 'vps', path: '/etc/example', intent: 'edit' }).success);
  assert.equal(OPERATOR_SCHEMAS.operator_preflight.safeParse({ host: 'vps', path: '/etc/example', intent: 'delete' }).success, false);
});

test('ordinary file within configured root routes to normal operator edit', () => fixture(async ({ tools, write }) => {
  const result = await tools.operator_preflight({ path: join(write, 'notes.txt') });
  assert.equal(result.route, 'operator_edit');
  assert.equal(result.authorized, true);
  assert.equal(result.ok, true);
}));

test('exact reviewed root-owned path needs independent owner-approved maintenance, never a grant', () =>
  fixture(async ({ tools, readonly }) => {
    const result = await tools.operator_preflight({ path: join(readonly, 'lab-backup') });
    assert.equal(result.ok, true);
    assert.equal(result.authorized, false);
    assert.equal(result.route, 'reviewed_root_maintenance');
    assert.ok(result.requires.includes('single_use_owner_approval'));
    assert.ok(result.requires.includes('isolated_restore_test'));
    assert.ok(!JSON.stringify(result).includes('path_not_allowed'));
  }));

test('same path is not eligible for admin route without actual root helper support', () =>
  fixture(async ({ tools, readonly }) => {
    const result = await tools.operator_preflight({ path: join(readonly, 'lab-backup') });
    assert.equal(result.route, 'owner_policy_review');
    assert.equal(result.authorized, false);
  }, { rootEnabled: false }));

test('unknown paths cannot infer a root workaround', () => fixture(async ({ tools, readonly }) => {
  const result = await tools.operator_preflight({ path: readonly });
  assert.equal(result.route, 'owner_policy_review');
  assert.equal(result.authorized, false);
}));

test('secret paths always stop before any administrator maintenance route', () =>
  fixture(async ({ tools, secret }) => {
    const result = await tools.operator_preflight({ path: secret });
    assert.equal(result.route, 'stop');
    assert.equal(result.reason, 'path_secret');
    assert.equal(result.authorized, false);
  }));

// Owner decision 2026-10-23: a checkout on its default branch is edited in place, no worktree flow.
test('a project checkout on its default branch routes to a normal operator edit', () =>
  fixture(async ({ tools, project }) => {
    const git = join(project, '.git');
    await mkdir(join(git, 'refs', 'remotes', 'origin'), { recursive: true });
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(git, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
    await writeFile(join(project, 'README.md'), 'fixture\n');
    const result = await tools.operator_preflight({ path: join(project, 'README.md') });
    assert.equal(result.route, 'operator_edit');
    assert.equal(result.authorized, true);
    assert.deepEqual(result.requires, []);
  }));
