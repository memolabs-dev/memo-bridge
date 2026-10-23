// The mutation harness (tests/mutations/run.mjs) on a toy repository: it only proves an
// invariant test sensitive if it refuses everything that is not a real, behavioural mutant of
// committed production code. Kept fast: a few files, one tiny node:test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutantsByInvariant } from './mutations/run.mjs';
import { patchPaths } from './mutations/patches.mjs';

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
import { wait } from '../../server/wait.mjs';
import { other } from '../../bridge/other.mjs';
test('value is one', async () => {
  assert.equal(process.env.MEMO_BRIDGE_REQUIRE_GOVERNANCE, '1');
  await wait();
  assert.ok(process.env.MEMO_BRIDGE_GOVERNANCE_ROOT);
  assert.equal(value, 1);
});
test('other is a string', () => { assert.equal(typeof other, 'string'); });
`;

// A one-line hunk on server/value.mjs (or another file), behind the harness header.
const header = pattern => (pattern === null ? '' : `# test: ${pattern}\n`);
const patch = (pattern, { file = 'server/value.mjs', from = 'export const value = 1;', to = 'export const value = 2;' } = {}) =>
  `${header(pattern)}diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const WAIT = 'export const wait = () => Promise.resolve();';

// A committed toy repository: one invariant ("toy"), the given patches, and a fake governance checkout.
function toy(t, patches, extra = {}) {
  const repo = temp(t, 'memo-mutations-toy-');
  write(repo, {
    'package.json': '{ "type": "module", "private": true }\n',
    'README.md': 'toy\n',
    'server/value.mjs': 'export const value = 1;\n',
    'server/wait.mjs': `${WAIT}\n`,
    'tests/invariants/lib/helper.mjs': 'export const helper = 1;\n',
    'bridge/other.mjs': "export const other = 'a';\n",
    'tests/invariants/toy.test.mjs': TOY_TEST,
    ...Object.fromEntries(Object.entries(patches).map(([name, text]) => [`tests/mutations/${name}`, text])),
    ...extra
  });
  git(repo, 'init', '-q', '-b', 'main');
  // No background maintenance: it can leave .git/objects/maintenance.lock in the "before" listing
  // of the untouched-repository check and remove it afterwards (CI flake of 2026-10-23, Node 22).
  git(repo, 'config', 'maintenance.auto', 'false');
  git(repo, 'config', 'gc.auto', '0');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'toy');
  const governance = temp(t, 'memo-mutations-gov-');
  write(governance, { 'scripts/issue_lease.py': '# stand-in\n' });
  return { repo, governance };
}

function harness({ repo, governance }, ...args) {
  if (!args.includes('--test-timeout')) args.push('--test-timeout', '2000');
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

test('a rename out of tests/ into server/ exits 1: every change outside server/ and bridge/ is refused', t => {
  const rename = `${header('value is one')}diff --git a/tests/invariants/lib/helper.mjs b/server/helper.mjs
similarity index 100%
rename from tests/invariants/lib/helper.mjs
rename to server/helper.mjs
`;
  const r = harness(toy(t, { 'toy-rename.patch': rename }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-rename.patch: changes files outside server\/ and bridge\/: .*tests\/invariants\/lib\/helper\.mjs/);
});

test('a mutant that only breaks loading the test file is an error, not a kill', t => {
  const r = harness(toy(t, { 'toy-import.patch': patch('value is one', { to: "export { value } from './missing.mjs';" }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ERROR.*toy-import.*no test that passed in the baseline failed on an assertion/);
  assert.doesNotMatch(r.stdout, /killed/);
});

// The hang holds a ref'd 3 s timer, well past the 300 ms --test-timeout: with an empty event
// loop, Node 22 reports a bare pending promise as cancelledByParent before any timeout fires
// (Node 24 as testTimeoutFailure). The timer keeps the loop alive so both see a real timeout, and
// it ends on its own, so the run still exits.
test('a mutant that only makes a test time out is an error, not a kill', t => {
  const r = harness(toy(t, { 'toy-hang.patch': patch('value is one', { file: 'server/wait.mjs', from: WAIT,
    to: 'export const wait = () => new Promise(resolve => setTimeout(resolve, 3000));' }) }),
    '--test-timeout', '300');
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ERROR.*toy-hang.*testTimeoutFailure/);
  assert.doesNotMatch(r.stdout, /killed/);
});

test('untracked patches are named on stderr: they are ignored until committed', t => {
  const toyRepo = toy(t, { 'toy-value.patch': patch('value is one') });
  write(toyRepo.repo, { 'tests/mutations/toy-draft.patch': patch('value is one') });
  const r = harness(toyRepo);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /warning.*toy-draft\.patch.*not committed/);
  assert.doesNotMatch(r.stdout, /toy-draft/);
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

// Ruling 17a: an error thrown by production code is a broken program, not a caught behaviour.
// Only an assertion (AssertionError, code ERR_ASSERTION) in a test the baseline passed kills.
test('a mutant that makes production code throw a TypeError is an error, not a kill', t => {
  const r = harness(toy(t, { 'toy-throw.patch': patch('value is one', { file: 'server/wait.mjs', from: WAIT,
    to: "export const wait = () => { throw new TypeError('boom'); };" }) }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ERROR.*toy-throw.*no test that passed in the baseline failed on an assertion.*TypeError/);
  assert.doesNotMatch(r.stdout, /killed/);
});

// Ruling 17b: the paths a patch names are checked before git apply runs, so a patch can never
// write through the node_modules link (or anywhere else) into the original repository.
test('a patch naming node_modules/ is refused before git apply and writes nothing', t => {
  const toyRepo = toy(t, { 'toy-deps.patch': patch('value is one', { file: 'node_modules/pkg/index.mjs', from: 'export const x = 1;', to: 'export const x = 2;' }) });
  write(toyRepo.repo, { 'node_modules/pkg/index.mjs': 'export const x = 1;\n' });
  const r = harness(toyRepo);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-deps\.patch: changes files outside server\/ and bridge\/: node_modules\/pkg\/index\.mjs \(named by the patch, refused before git apply\)/);
  assert.equal(readFileSync(join(toyRepo.repo, 'node_modules/pkg/index.mjs'), 'utf8'), 'export const x = 1;\n');
});

test('a patch whose paths cannot be read is refused before git apply', t => {
  const quoted = `${header('value is one')}diff --git "a/server/v\\303\\251.mjs" "b/server/v\\303\\251.mjs"\n--- "a/server/v\\303\\251.mjs"\n+++ "b/server/v\\303\\251.mjs"\n@@ -1 +1 @@\n-a\n+b\n`;
  const r = harness(toy(t, { 'toy-quoted.patch': quoted }));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /toy-quoted\.patch: cannot read the paths of the patch.*quoted/);
});

test('patchPaths reads every committed mutant, counts hunk lines, and refuses what it cannot read', () => {
  const dir = join(dirname(RUN));
  for (const file of readdirSync(dir).filter(n => n.endsWith('.patch'))) {
    const paths = patchPaths(readFileSync(join(dir, file), 'utf8'));
    assert.ok(paths.length && paths.every(p => /^(server|bridge)\//.test(p)), `${file}: ${paths}`);
  }
  // A removed line that starts with "-- " is hunk content, not the header of another file.
  const tricky = 'diff --git a/server/a.mjs b/server/a.mjs\n--- a/server/a.mjs\n+++ b/server/a.mjs\n@@ -1,2 +1 @@\n--- a/README.md\n+++ b/README.md\n';
  assert.throws(() => patchPaths(tricky), /hunk ends early/);
  assert.throws(() => patchPaths('--- a/server/a.mjs\n+++ b/server/a.mjs\n@@ -1 +1,2 @@\n-a\n b\n+c\n'), /more lines than its @@ header/);
  const ok = 'diff --git a/server/a.mjs b/server/a.mjs\n--- a/server/a.mjs\n+++ b/server/a.mjs\n@@ -1,2 +1 @@\n--- a/README.md\n-x\n+y\n';
  assert.deepEqual(patchPaths(ok), ['server/a.mjs']);
  assert.deepEqual(patchPaths('--- a/server/b.mjs\t2026-01-01\n+++ b/server/b.mjs\n@@ -1 +1 @@\n-a\n+b\n'), ['server/b.mjs']);
  assert.throws(() => patchPaths('# test: x\nno diff here\n'), /names no file/);
  assert.throws(() => patchPaths('diff --git a/server/a.mjs b/server/a.mjs\n--- a/server/a.mjs\n+++ b/server/a.mjs\n@@ -1,3 +1,3 @@\n a\n'), /ends early/);
});
