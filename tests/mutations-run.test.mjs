// The mutation harness (tests/mutations/run.mjs) on a toy repository: it only proves an
// invariant test sensitive if it refuses everything that is not a real, behavioural mutant of
// committed production code. Kept fast: a few files, one tiny node:test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutantsByInvariant } from './mutations/run.mjs';

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'mutations', 'run.mjs');

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=toy', '-c', 'user.email=toy@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });

const TOY_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../../server/value.mjs';
import { other } from '../../bridge/other.mjs';
test('value is one', () => {
  assert.equal(process.env.MEMO_BRIDGE_REQUIRE_GOVERNANCE, '1');
  assert.ok(process.env.MEMO_BRIDGE_GOVERNANCE_ROOT);
  assert.equal(value, 1);
});
test('other is a string', () => { assert.equal(typeof other, 'string'); });
`;

// A one-line hunk on server/value.mjs (or another file), behind the harness header.
const patch = (pattern, { file = 'server/value.mjs', from = 'export const value = 1;', to = 'export const value = 2;' } = {}) =>
  `${pattern === null ? '' : `# test: ${pattern}\n`}diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

// A committed toy repository: one invariant ("toy"), the given patches, and a fake governance checkout.
function toy(t, patches, extra = {}) {
  const repo = temp(t, 'memo-mutations-toy-');
  write(repo, {
    'package.json': '{ "type": "module", "private": true }\n',
    'README.md': 'toy\n',
    'server/value.mjs': 'export const value = 1;\n',
    'bridge/other.mjs': "export const other = 'a';\n",
    'tests/invariants/toy.test.mjs': TOY_TEST,
    ...Object.fromEntries(Object.entries(patches).map(([name, text]) => [`tests/mutations/${name}`, text])),
    ...extra
  });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'toy');
  const governance = temp(t, 'memo-mutations-gov-');
  write(governance, { 'scripts/issue_lease.py': '# stand-in\n' });
  return { repo, governance };
}

function harness({ repo, governance }, ...args) {
  const r = spawnSync(process.execPath, [RUN, '--repo', repo, ...args], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MEMO_BRIDGE_GOVERNANCE_ROOT: governance, MEMO_BRIDGE_REQUIRE_GOVERNANCE: undefined } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a killed mutant exits 0, names it, and leaves the original repository untouched', t => {
  const toyRepo = toy(t, { 'toy-value.patch': patch('value is one') });
  const before = readdirSync(toyRepo.repo, { recursive: true }).sort();
  const r = harness(toyRepo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /killed.*toy-value/);
  assert.equal(git(toyRepo.repo, 'status', '--porcelain', '--ignored'), '', 'nothing written into the repository');
  assert.deepEqual(readdirSync(toyRepo.repo, { recursive: true }).sort(), before);
});

test('a surviving mutant exits 1 and is named on stderr', t => {
  const r = harness(toy(t, { 'toy-other.patch': patch('other is a string', { file: 'bridge/other.mjs', from: "export const other = 'a';", to: "export const other = 'b';" }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /SURVIVED.*toy-other/);
});

test('a patch that does not apply exits 1', t => {
  const r = harness(toy(t, { 'toy-stale.patch': patch('value is one', { from: 'export const value = 9;' }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-stale/);
});

test('a patch touching a file outside server/ or bridge/ exits 1', t => {
  const r = harness(toy(t, { 'toy-readme.patch': patch('value is one', { file: 'README.md', from: 'toy', to: 'not toy' }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-readme.*README\.md/);
});

test('a mutant that leaves a .mjs file unparsable exits 1: a syntax error is not a mutant', t => {
  const r = harness(toy(t, { 'toy-syntax.patch': patch('value is one', { to: 'export const value = ;' }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-syntax.*node --check/);
});

test('a header pattern that selects no test exits 1', t => {
  const r = harness(toy(t, { 'toy-nothing.patch': patch('no such test') }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-nothing.*selects no test/);
});

test('a test that already fails without the mutant proves nothing: exits 1', t => {
  const broken = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always red', () => { assert.fail('red'); });\n";
  const r = harness(toy(t, { 'toy-value.patch': patch('value is one'), 'broken-value.patch': patch('always red') },
    { 'tests/invariants/broken.test.mjs': broken }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /broken-value.*baseline fails without the mutant/);
  assert.match(r.stdout, /killed.*toy-value/, 'the other mutant is still judged');
});

test('a patch without its "# test:" header exits 1', t => {
  const r = harness(toy(t, { 'toy-bare.patch': patch(null) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-bare.*# test:/);
});

test('uncommitted changes to tracked files are refused before anything runs', t => {
  const toyRepo = toy(t, { 'toy-value.patch': patch('value is one') });
  writeFileSync(join(toyRepo.repo, 'server/value.mjs'), 'export const value = 3;\n');
  const r = harness(toyRepo);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /uncommitted/);
  assert.equal(git(toyRepo.repo, 'status', '--porcelain'), ' M server/value.mjs\n', 'the change is left as it was');
});

test('an invariant without a mutant fails the run, and --only narrows it', t => {
  const toyRepo = toy(t, { 'toy-value.patch': patch('value is one') }, { 'tests/invariants/lonely.test.mjs': "import test from 'node:test';\ntest('x', () => {});\n" });
  const all = harness(toyRepo);
  assert.equal(all.code, 1, all.stdout + all.stderr);
  assert.match(all.stderr, /lonely.*no mutant/);
  const only = harness(toyRepo, '--only', 'toy');
  assert.equal(only.code, 0, only.stdout + only.stderr);
});

test('mutantsByInvariant maps a patch to the longest invariant prefix and fails loudly without one', t => {
  const root = temp(t, 'memo-mutations-map-');
  write(root, {
    'invariants/claim.test.mjs': '', 'invariants/claim-race.test.mjs': '', 'invariants/fence.test.mjs': '',
    'mutations/claim-race-unique.patch': '', 'mutations/claim-x.patch': '', 'mutations/claim-race-b.patch': ''
  });
  assert.deepEqual([...mutantsByInvariant(join(root, 'mutations'))], [
    ['claim', ['claim-x.patch']], ['claim-race', ['claim-race-b.patch', 'claim-race-unique.patch']], ['fence', []]
  ]);
  write(root, { 'mutations/fence.patch': '' });
  assert.throws(() => mutantsByInvariant(join(root, 'mutations')), /fence\.patch/);
  rmSync(join(root, 'mutations/fence.patch'));
  write(root, { 'mutations/claimrace-a.patch': '' });
  assert.throws(() => mutantsByInvariant(join(root, 'mutations')), /claimrace-a\.patch/);
});
