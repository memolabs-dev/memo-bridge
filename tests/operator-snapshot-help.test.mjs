// operator_snapshot (spec D5, AC-7), operator_help and its playbooks (spec D3, AC-4), and the
// staged content of operator_edit (spec D6, AC-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SNAPSHOT_LIMITS, createSnapshotTool, parseStatusV2 } from '../bridge/operator-snapshot.mjs';
import { HELP_TOPICS, PLAYBOOKS, operatorHelp } from '../bridge/operator-help.mjs';
import { createOperatorWriteTools } from '../bridge/operator-write.mjs';
import { OPERATOR_SCHEMAS, OPERATOR_TOOLS, UPLOAD_CHUNK_BYTES } from '../server/tools/operator-tools.mjs';
import { finalizeResult } from '../bridge/operator-output.mjs';
import { makeHost, GITHUB_TOKEN } from './helpers/operator-fixture.mjs';

const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
};
const snapshotTool = (host, extra = {}) => createSnapshotTool(host.policy, { projects: async () => [], ...extra });

test('AC-7: a git repository: branch, dirty counts, recent commits, tree summary, README head as untrusted content', async t => {
  const host = makeHost(t);
  const repo = host.p('srv/app');
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), `# App\n\nThe app. token=${GITHUB_TOKEN}\n`);
  writeFileSync(join(repo, 'package.json'), '{}\n');
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), '');
  git(repo, 'add', 'README.md', 'package.json', 'config.txt');
  git(repo, 'commit', '-qm', 'first commit');
  writeFileSync(join(repo, 'README.md'), '# App\n\nChanged.\n');
  git(repo, 'commit', '-qam', 'second commit');
  writeFileSync(join(repo, 'config.txt'), 'changed\n');
  const out = await snapshotTool(host).operator_snapshot({ path: repo });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.kind, 'git_repository');
  assert.equal(out.git.branch, 'main');
  assert.match(out.git.head, /^[0-9a-f]{40}$/);
  assert.equal(out.git.unstaged, 1);
  assert.ok(out.git.untracked >= 2, 'notes.md, sub/...');
  assert.equal(out.git.dirty, true);
  assert.deepEqual(out.git.untrusted_content.recent_commits.map(c => c.subject), ['second commit', 'first commit']);
  assert.ok(out.markers.includes('package.json'));
  assert.ok(out.tree.noise_dirs_skipped.includes('node_modules'));
  assert.ok(out.tree.secret_entries_skipped >= 1, '.env is skipped and counted');
  assert.equal(JSON.stringify(out.tree).includes('.env'), false);
  assert.ok(out.tree.extensions.some(e => e.ext === '.md'));
  assert.match(out.readme.untrusted_content.head, /Changed/);
  // The agent's output path redacts whatever the README or a commit holds.
  writeFileSync(join(repo, 'README.md'), `token=${GITHUB_TOKEN}\n`);
  const redacted = finalizeResult(await snapshotTool(host).operator_snapshot({ path: repo })).data;
  assert.equal(JSON.stringify(redacted).includes(GITHUB_TOKEN), false);
});

test('AC-7: a plain directory, a secret path, a file, outside the roots; another user\'s repository reads HEAD only', async t => {
  const host = makeHost(t);
  const plain = await snapshotTool(host).operator_snapshot({ path: host.p('srv') });
  assert.deepEqual([plain.ok, plain.kind, plain.git.repository], [true, 'directory', false]);
  assert.ok(plain.tree.top.some(e => e.name === 'app' && e.type === 'dir' && e.files >= 3));
  assert.equal((await snapshotTool(host).operator_snapshot({ path: host.p('home/op/.ssh') })).error, 'path_secret');
  assert.equal((await snapshotTool(host).operator_snapshot({ path: host.p('srv/app/config.txt') })).error, 'not_a_directory');
  assert.equal((await snapshotTool(host).operator_snapshot({ path: host.p('outside') })).error, 'path_not_allowed');
  // git refuses a repository owned by someone else (safe.directory): no git config is read,
  // only .git/HEAD as a file.
  mkdirSync(host.p('srv/app/.git'), { recursive: true });
  writeFileSync(host.p('srv/app/.git/HEAD'), 'ref: refs/heads/feature/x\n');
  const calls = [];
  const run = async argv => { calls.push(argv); return { code: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/x'" }; };
  const foreign = await snapshotTool(host, { run }).operator_snapshot({ path: host.p('srv/app') });
  assert.deepEqual([foreign.git.repository, foreign.git.branch, foreign.git.partial], [true, 'feature/x', 'owned_by_another_user']);
  assert.equal(calls.length, 1, 'no status or log after the refusal');
  assert.ok(calls[0].includes('core.fsmonitor=false') && !calls[0].some(a => a.startsWith('safe.directory')));
});

test('snapshot bounds: depth, entries and porcelain v2 parsing', () => {
  assert.ok(SNAPSHOT_LIMITS.depth <= 5 && SNAPSHOT_LIMITS.entries <= 20_000 && SNAPSHOT_LIMITS.budgetMs <= 5_000);
  const parsed = parseStatusV2(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 a b src/a.js', '1 .M N... 100644 100644 100644 a b src/b.js', 'u UU N... 1 2 3 4 a b c x', '? new.txt'].join('\n'));
  assert.deepEqual([parsed.branch, parsed.upstream, parsed.ahead, parsed.behind, parsed.staged, parsed.unstaged, parsed.conflicts, parsed.untracked],
    ['main', 'origin/main', 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(parsed.changed.map(c => c.path), ['src/a.js', 'src/b.js', 'new.txt']);
});

test('AC-4: operator_help: index, topics, playbooks, pagination, unknown names list the known ones', () => {
  const index = operatorHelp({});
  assert.deepEqual(index.topics.map(t => t.topic), Object.keys(HELP_TOPICS));
  for (const name of ['restart_stack', 'read_logs', 'free_disk', 'deploy_check', 'git_sync', 'backup_status', 'rotate_key', 'freeze']) {
    assert.ok(index.playbooks.some(p => p.playbook === name), name);
    const book = operatorHelp({ playbook: name });
    assert.equal(book.ok, true);
    assert.ok(book.steps.length >= 1 && book.when && book.requires, name);
    assert.ok(book.steps.every(s => typeof s.call === 'string' && s.why), name);
  }
  const topic = operatorHelp({ topic: 'transfer' });
  assert.ok(topic.details.some(d => d.includes('512 MiB')));
  assert.ok(Array.isArray(topic.next));
  assert.ok(operatorHelp({ topic: 'playbooks' }).playbooks.length >= 8);
  const paged = operatorHelp({ playbook: 'restart_stack', limit: 3 });
  assert.deepEqual([paged.steps.length, paged.next_offset], [3, 3]);
  assert.match(paged.next, /offset:3/);
  assert.equal(operatorHelp({ playbook: 'restart_stack', offset: 3, limit: 50 }).steps[0].step, 4);
  const unknown = operatorHelp({ playbook: 'nope' });
  assert.deepEqual([unknown.error, unknown.playbooks.includes('freeze')], ['unknown_playbook', true]);
  assert.equal(operatorHelp({ topic: 'nope' }).error, 'unknown_topic');
  assert.equal(operatorHelp({ topic: 'start', playbook: 'freeze' }).error, 'invalid_arguments');
});

test('AC-4: no playbook teaches widening access: no policy edit, no root or allowlist change, no workaround; every step names a real tool', () => {
  const tools = new Set([...OPERATOR_TOOLS, 'sessions_overview', 'audit_events', 'github_workflows', 'memory_search', 'memory_save']);
  for (const [name, book] of Object.entries(PLAYBOOKS)) {
    const text = JSON.stringify(book).toLowerCase();
    for (const banned of ['policy.json', 'write_roots', 'read_roots', 'max_tier', 'approval_mode', 'allowlist', 'sudoers', 'chmod 777', 'work around',
      'bypass', 'disable the', 'unfreeze it yourself']) {
      assert.equal(text.includes(banned), false, `${name}: ${banned}`);
    }
    for (const step of book.steps) {
      assert.ok(tools.has(step.call), `${name}: ${step.call}`);
      // Arguments with placeholders still match the tool's schema shape (keys exist).
      const schema = OPERATOR_SCHEMAS[step.call];
      if (schema && step.args) for (const key of Object.keys(step.args)) assert.ok(Object.hasOwn(schema.shape, key), `${name}: ${step.call}.${key}`);
    }
  }
  for (const [name, topic] of Object.entries(HELP_TOPICS)) assert.equal(JSON.stringify(topic).toLowerCase().includes('policy.json'), false, name);
});

test('AC-8: staged content for operator_edit: a 2 MiB new_text and an old fragment, by upload id', async t => {
  const host = makeHost(t, { policy: { max_tier: 'write' } });
  const w = createOperatorWriteTools(host.policy, { projects: async () => [], stateDir: host.p('state') });
  const target = host.p('srv/rw/big.txt');
  writeFileSync(target, 'head\nOLD BLOCK\ntail\n');
  async function stage(text, path = target) {
    const data = Buffer.from(text, 'utf8');
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const init = await w.operator_upload_init({ path, size: data.length, stage: true });
    assert.equal(init.ok, true, JSON.stringify(init));
    assert.equal(init.stage, true);
    for (let i = 0; i * UPLOAD_CHUNK_BYTES < data.length; i++) {
      const out = await w.operator_upload_chunk({ upload_id: init.upload_id, index: i,
        content_base64: data.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES).toString('base64') });
      assert.equal(out.ok, true);
    }
    const done = await w.operator_upload_complete({ upload_id: init.upload_id, sha256: createHash('sha256').update(data).digest('hex') });
    assert.deepEqual([done.ok, done.staged], [true, true]);
    assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, before, 'a stage writes nothing at its path');
    return init.upload_id;
  }
  const big = `${'x'.repeat(80)}\n`.repeat(26_000); // about 2 MiB
  const oldId = await stage('OLD BLOCK');
  const newId = await stage(big);
  // dry_run first: nothing changes, the stage stays usable.
  const dry = await w.operator_edit({ path: target, mode: 'replace', old_upload_id: oldId, new_upload_id: newId, dry_run: true });
  assert.deepEqual([dry.ok, dry.dry_run, dry.changed], [true, true, true]);
  assert.equal(readFileSync(target, 'utf8'), 'head\nOLD BLOCK\ntail\n');
  const edited = await w.operator_edit({ path: target, mode: 'replace', old_upload_id: oldId, new_upload_id: newId });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(readFileSync(target, 'utf8'), `head\n${big}\ntail\n`);
  assert.ok(edited.backup);
  // Used stages are gone; unknown, foreign-path, incomplete and mixed forms are refused.
  assert.equal((await w.operator_edit({ path: target, mode: 'write', new_upload_id: newId })).error, 'unknown_upload');
  const other = await stage('other', host.p('srv/rw/other.txt'));
  assert.equal((await w.operator_edit({ path: target, mode: 'write', new_upload_id: other })).error, 'stage_path_mismatch');
  assert.equal((await w.operator_edit({ path: target, mode: 'write', new_text: 'a', new_upload_id: other })).error, 'invalid_arguments');
  const open = await w.operator_upload_init({ path: target, size: 10, stage: true });
  assert.equal((await w.operator_edit({ path: target, mode: 'write', new_upload_id: open.upload_id })).error, 'upload_incomplete');
  assert.equal((await w.operator_upload_init({ path: target, size: 9 * 1024 * 1024, stage: true })).error, 'file_too_large');
  // A stage is never placed by upload_complete, even for a path that does not exist yet.
  const fresh = host.p('srv/rw/new.txt');
  const s = await w.operator_upload_init({ path: fresh, size: 3, stage: true });
  await w.operator_upload_chunk({ upload_id: s.upload_id, index: 0, content_base64: Buffer.from('abc').toString('base64') });
  await w.operator_upload_complete({ upload_id: s.upload_id, sha256: createHash('sha256').update('abc').digest('hex') });
  assert.throws(() => readFileSync(fresh));
  assert.equal((await w.operator_edit({ path: fresh, mode: 'write', create: true, new_upload_id: s.upload_id })).ok, true);
  assert.equal(readFileSync(fresh, 'utf8'), 'abc');
  // The schemas carry the new fields.
  assert.equal(OPERATOR_SCHEMAS.operator_edit.safeParse({ path: '/x', mode: 'write', new_upload_id: s.upload_id }).success, true);
  assert.equal(OPERATOR_SCHEMAS.operator_upload_init.safeParse({ path: '/x', size: 1, stage: true }).success, true);
});
