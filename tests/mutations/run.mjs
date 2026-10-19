#!/usr/bin/env node
// Mutation harness: proves every collision invariant test is sensitive to the production
// behaviour it protects. Each tests/mutations/<invariant>-<suffix>.patch is a small patch that
// breaks that behaviour; its first line `# test: <name pattern>` names the tests that must catch
// it. For each mutant the harness:
//   1. copies the committed tree (git archive HEAD) into a temporary directory and refuses to
//      run at all while tracked files have uncommitted changes: the proof is about the commit;
//   2. links node_modules, applies the patch with git apply inside the copy, then compares the
//      copy file by file (content and mode) with an untouched extraction: any difference outside
//      server/ and bridge/ is refused (a rename out of tests/ included), and node --check runs on
//      every changed .mjs/.js/.cjs (a syntax-only mutant is not a mutant);
//   3. runs the target invariant file on an unpatched copy with the same pattern (baseline): it
//      must pass and select at least one test, so a kill cannot come from a broken environment
//      or an empty selection;
//   4. runs it on the mutant: killed iff node --test exits non-zero AND at least one test that
//      passed in the baseline now fails with failureType 'testCodeFailure' (an assertion or an
//      error thrown by the test). A non-zero exit for any other reason (the file no longer loads,
//      a timeout, a hook, a cancelled test) is a harness error, never a kill.
// Tests run with MEMO_BRIDGE_REQUIRE_GOVERNANCE=1 and MEMO_BRIDGE_GOVERNANCE_ROOT set to the real
// governance checkout, resolved as tests/invariants/lib/fixture.mjs does. Nothing is ever
// written into the original repository; temporary directories are removed afterwards.
//
// Usage: node tests/mutations/run.mjs [--only <invariant|mutant>] [--repo <dir>] [--test-timeout <ms>]
// Exit 0 if and only if every selected mutant is killed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultGovernanceRoot } from '../../server/coordinator/issue-lease.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER = pathToFileURL(join(HERE, 'count-reporter.mjs')).href;
const TEST_SUFFIX = '.test.mjs';
const IN_SCOPE = /^(server|bridge)\//;
const RUN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 180_000;

// Ruling 4: a mutant <name>.patch targets tests/invariants/<prefix>.test.mjs for the LONGEST test
// basename <prefix> such that <name> starts with "<prefix>-". Every invariant is a key (possibly
// with no mutant); a patch with no target throws. Reused by the ratchet.
export function mutantsByInvariant(dir, { invariantsDir = join(dir, '..', 'invariants') } = {}) {
  const invariants = readdirSync(invariantsDir).filter(n => n.endsWith(TEST_SUFFIX)).map(n => n.slice(0, -TEST_SUFFIX.length)).sort();
  const map = new Map(invariants.map(n => [n, []]));
  for (const file of readdirSync(dir).filter(n => n.endsWith('.patch')).sort()) {
    const name = file.slice(0, -'.patch'.length);
    const target = invariants.filter(inv => name.startsWith(`${inv}-`) && name.length > inv.length + 1)
      .sort((a, b) => b.length - a.length)[0];
    if (!target) throw new Error(`${file}: no tests/invariants/<prefix>${TEST_SUFFIX} for it (name a mutant <invariant>-<suffix>.patch)`);
    map.get(target).push(file);
  }
  return map;
}

// Ruling 12: the first line is `# test: <name pattern>` (git apply ignores leading text).
export function headerPattern(text) {
  const match = /^# test: (.*)$/.exec(text.split('\n', 1)[0]);
  const pattern = match?.[1].trim();
  if (!pattern) throw new Error('first line must be "# test: <name pattern>"');
  try { new RegExp(pattern); } catch (error) { throw new Error(`"# test:" pattern is not a valid regular expression: ${error.message}`); }
  return pattern;
}

// git without any repository the caller's environment points at: the copy is a plain directory.
function gitEnv(cwd) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}
function git(cwd, args, { input } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: input === undefined ? 'utf8' : undefined, env: gitEnv(cwd), maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '').trim() };
}

// Every file of an extracted tree (node_modules link excluded), as path -> "mode:sha256" (or the
// target of a symlink). Comparing two snapshots shows exactly what a patch changed, whatever git
// apply was told (a rename, a mode change, a new or deleted file).
function snapshot(root) {
  const files = new Map();
  const walk = rel => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === 'node_modules') continue;
      const full = join(root, path);
      const info = lstatSync(full);
      if (info.isDirectory()) walk(path);
      else if (info.isSymbolicLink()) files.set(path, `link:${readlinkSync(full)}`);
      else files.set(path, `${(info.mode & 0o777).toString(8)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk('');
  return files;
}
function changedPaths(before, after) {
  const changed = [];
  for (const [path, id] of after) if (before.get(path) !== id) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed.sort();
}
const inScope = path => IN_SCOPE.test(path) && !path.split('/').some(s => s === '' || s === '.' || s === '..') && !path.includes('\\');

function extract(tar, dir, repo) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -xf: ${r.stderr}`);
  if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

// One node --test run of a single invariant file; resolves {code, tests, failed, ms}.
function runTest(copy, invariant, pattern, governanceRoot, scratch, testTimeoutMs) {
  const countFile = join(scratch, 'count.json');
  const logFile = join(scratch, 'spec.log');
  const env = { ...gitEnv(copy), MEMO_BRIDGE_REQUIRE_GOVERNANCE: '1', MEMO_BRIDGE_GOVERNANCE_ROOT: governanceRoot };
  delete env.GIT_CEILING_DIRECTORIES;
  // Under an outer node --test (the harness's own unit test), NODE_TEST_CONTEXT would make this
  // run a child of that runner: it would stream to stdout and never call the reporters.
  delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--experimental-test-isolation=none', `--test-timeout=${testTimeoutMs}`, `--test-name-pattern=${pattern}`,
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${countFile}`, '--test-reporter=spec', `--test-reporter-destination=${logFile}`,
    join('tests', 'invariants', `${invariant}${TEST_SUFFIX}`)];
  const started = Date.now();
  return new Promise(done => {
    const child = spawn(process.execPath, args, { cwd: copy, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      let count = null;
      try { count = JSON.parse(readFileSync(countFile, 'utf8')); } catch { /* reported below */ }
      let log = '';
      try { log = readFileSync(logFile, 'utf8'); } catch { /* none */ }
      done({ code, timedOut, count, ms: Date.now() - started, log, stderr });
    });
  });
}

const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
const tail = text => text.trim().split('\n').slice(-40).join('\n');

export async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr } = {}) {
  const say = line => out.write(`${line}\n`);
  const complain = line => err.write(`${line}\n`);
  let only = null; let repoArg = null; let testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) only = argv[++i];
    else if (argv[i] === '--repo' && argv[i + 1]) repoArg = argv[++i];
    else if (argv[i] === '--test-timeout' && /^[1-9]\d*$/.test(argv[i + 1] ?? '')) testTimeoutMs = Number(argv[++i]);
    else { complain(`mutations: unknown argument ${argv[i]} (usage: run.mjs [--only <invariant|mutant>] [--repo <dir>] [--test-timeout <ms>])`); return 1; }
  }
  const top = git(resolve(repoArg ?? join(HERE, '..', '..')), ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) { complain(`mutations: not a git repository: ${top.stderr}`); return 1; }
  const repo = top.stdout.trim();
  const dirty = git(repo, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirty.code !== 0 || dirty.stdout.trim()) {
    complain(`mutations: refused, tracked files have uncommitted changes (the proof is about the commit; commit first):\n${dirty.stdout || dirty.stderr}`);
    return 1;
  }
  const governanceRoot = defaultGovernanceRoot();
  if (!governanceRoot || !existsSync(join(governanceRoot, 'scripts', 'issue_lease.py'))) {
    complain(`mutations: governance checkout not found (scripts/issue_lease.py under ${governanceRoot ?? '<unresolved>'}; set MEMO_BRIDGE_GOVERNANCE_ROOT)`);
    return 1;
  }
  const head = git(repo, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'tests/mutations']).stdout.split('\0')
    .filter(p => p.endsWith('.patch'));
  for (const p of untracked) complain(`mutations: warning: ${p} is not committed and is ignored (the harness reads HEAD)`);

  const work = mkdtempSync(join(tmpdir(), 'memo-mutations-'));
  let runs = 0;
  try {
    const tar = join(work, 'head.tar');
    const archived = git(repo, ['archive', '--format=tar', '-o', tar, 'HEAD']);
    if (archived.code !== 0) { complain(`mutations: git archive: ${archived.stderr}`); return 1; }
    const fresh = () => extract(tar, join(work, `tree-${runs++}`), repo);
    const listing = fresh();
    const pristine = snapshot(listing);
    const mutationsDir = join(listing, 'tests', 'mutations');
    let map;
    try { map = mutantsByInvariant(mutationsDir); } catch (error) { complain(`mutations: ${error.message}`); return 1; }

    const failures = [];
    let plan = [...map].flatMap(([invariant, files]) => files.map(file => ({ invariant, file, name: file.slice(0, -'.patch'.length) })));
    if (only) {
      plan = plan.filter(m => m.invariant === only || m.name === only);
      if (!plan.length) { complain(`mutations: --only ${only} selects no mutant`); return 1; }
    } else {
      for (const [invariant, files] of map) if (!files.length) failures.push(`${invariant}: no mutant (add tests/mutations/${invariant}-<suffix>.patch)`);
    }
    say(`mutations: ${plan.length} mutant(s) on ${head}, governance ${governanceRoot}`);

    const baselines = new Map();
    const started = Date.now();
    for (const m of plan) {
      const t0 = Date.now();
      const fail = reason => { failures.push(`${m.file}: ${reason}`); complain(`ERROR    ${m.file}: ${reason}`); };
      const patchFile = join(mutationsDir, m.file);
      let pattern;
      try { pattern = headerPattern(readFileSync(patchFile, 'utf8')); } catch (error) { fail(error.message); continue; }

      const copy = fresh();
      const applied = git(copy, ['apply', patchFile]);
      if (applied.code !== 0) { fail(`does not apply to HEAD: ${applied.stderr}`); continue; }
      const paths = changedPaths(pristine, snapshot(copy));
      if (!paths.length) { fail('the patch changes no file'); continue; }
      const outside = paths.filter(p => !inScope(p));
      if (outside.length) { fail(`changes files outside server/ and bridge/: ${outside.join(', ')}`); continue; }
      const unparsable = paths.filter(p => /\.[cm]?js$/.test(p) && existsSync(join(copy, p)))
        .filter(p => spawnSync(process.execPath, ['--check', join(copy, p)], { stdio: 'ignore' }).status !== 0);
      if (unparsable.length) { fail(`node --check fails on ${unparsable.join(', ')}: a syntax error is not a mutant`); continue; }

      const key = `${m.invariant}\0${pattern}`;
      if (!baselines.has(key)) {
        const scratch = join(work, `run-${runs++}`); mkdirSync(scratch);
        baselines.set(key, await runTest(fresh(), m.invariant, pattern, governanceRoot, scratch, testTimeoutMs));
      }
      const base = baselines.get(key);
      if (base.timedOut) { fail(`baseline timed out after ${seconds(RUN_TIMEOUT_MS)}`); continue; }
      if (!base.count) { fail(`baseline wrote no test count (exit ${base.code}):\n${tail(base.stderr)}`); continue; }
      if (base.count.tests === 0) { fail(`"# test: ${pattern}" selects no test in tests/invariants/${m.invariant}${TEST_SUFFIX}`); continue; }
      if (base.code !== 0 || base.count.failed.length || !base.count.passed.length) { fail(`baseline fails without the mutant (exit ${base.code}), so a kill would prove nothing:\n${tail(base.log)}`); continue; }

      const scratch = join(work, `run-${runs++}`); mkdirSync(scratch);
      const run = await runTest(copy, m.invariant, pattern, governanceRoot, scratch, testTimeoutMs);
      const timing = `baseline ${seconds(base.ms)}, mutant ${seconds(run.ms)}, total ${seconds(Date.now() - t0)}`;
      if (run.timedOut) { fail(`mutant run timed out after ${seconds(RUN_TIMEOUT_MS)}`); continue; }
      if (!run.count || run.count.tests === 0) { fail(`mutant run selected no test (exit ${run.code}):\n${tail(run.stderr)}`); continue; }
      if (run.code !== 0) {
        // Only an assertion (or an error thrown by the test body) in a test the baseline passed kills.
        const passedBefore = new Set(base.count.passed);
        const killers = run.count.failed.filter(f => passedBefore.has(f.key) && f.failureType === 'testCodeFailure');
        if (killers.length) {
          say(`killed   ${m.name}  [${m.invariant}] ${killers.length}/${run.count.tests} test(s) failed on an assertion  (${timing})`);
        } else {
          const seen = run.count.failed.map(f => `${f.key} (${f.failureType ?? 'file-level failure'})`).join(', ') || 'none';
          fail(`exit ${run.code} but no test that passed in the baseline failed on an assertion (testCodeFailure); failures: ${seen}  (${timing})\n${tail(run.log)}`);
        }
      } else {
        failures.push(`${m.file}: survived`);
        complain(`SURVIVED ${m.name}  [${m.invariant}] all ${run.count.passed.length} test(s) matching /${pattern}/ pass with the mutant  (${timing})`);
      }
    }
    if (failures.length) {
      complain(`mutations: FAILED (${failures.length}) in ${seconds(Date.now() - started)}:\n  ${failures.join('\n  ')}`);
      return 1;
    }
    say(`mutations: all ${plan.length} mutant(s) killed in ${seconds(Date.now() - started)}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
