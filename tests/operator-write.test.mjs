// Phase 6, TODO-P6-08 (R-P6-09, R-P6-13; AC-P6-02 full, AC-P6-13 on a real write tool): the T1
// tools on a temporary host tree. Edits with every mode, dry run and diff, backups, atomic
// replace with mode kept, named validator presets only, uploads with SHA-256, move, copy,
// delete with backup, chmod without special bits; .git and default-branch checkouts refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdit, createOperatorWriteTools, lineDiff, VALIDATORS } from '../bridge/operator-write.mjs';
import { parseOperatorPolicy } from '../bridge/operator-policy.mjs';
import { OPERATOR_SCHEMAS, VALIDATOR_PRESETS, UPLOAD_CHUNK_BYTES } from '../server/tools/operator-tools.mjs';
import { CANARY, makeHost } from './helpers/operator-fixture.mjs';

function host(t, extra = {}) {
  const h = makeHost(t, { policy: { max_tier: 'write' } });
  const calls = [];
  const run = extra.run ?? (async argv => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; });
  const tools = createOperatorWriteTools(h.policy, { run, stateDir: h.p('state'), ...extra });
  writeFileSync(h.p('srv/rw/app.conf'), 'listen 80\nserver_name a;\n# BEGIN managed\nold\n# END managed\n');
  chmodSync(h.p('srv/rw/app.conf'), 0o640);
  return { ...h, tools, calls };
}
const backups = (dir, name) => readdirSync(dir).filter(f => f.startsWith(`${name}.memo-bak.`));

test('edit: every mode computes the expected content; ambiguous or missing anchors are refused', () => {
  const text = 'a=1\nb=2\na=1\n';
  assert.equal(applyEdit(text, { mode: 'replace', old: 'b=2', new_text: 'b=3' }).text, 'a=1\nb=3\na=1\n');
  assert.deepEqual(applyEdit(text, { mode: 'replace', old: 'a=1', new_text: 'x' }), { error: 'old_count_mismatch', found: 2 });
  assert.equal(applyEdit(text, { mode: 'replace', old: 'a=1', new_text: 'x', count: 2 }).text, 'x\nb=2\nx\n');
  assert.deepEqual(applyEdit(text, { mode: 'replace', old: 'zzz', new_text: 'x' }), { error: 'old_not_found' });
  assert.equal(applyEdit(text, { mode: 'regex', pattern: '^a=\\d$', flags: 'm', new_text: 'a=$1', count: 1 }).text, 'a=$1\nb=2\na=1\n', 'replacement is literal');
  assert.equal(applyEdit(text, { mode: 'regex', pattern: '(a+)+', new_text: '' }).error, 'regex_too_complex');
  assert.equal(applyEdit(text, { mode: 'append', new_text: 'c=3\n' }).text, `${text}c=3\n`);
  assert.equal(applyEdit(text, { mode: 'prepend', new_text: '#\n' }).text, `#\n${text}`);
  assert.equal(applyEdit(text, { mode: 'write', new_text: 'only' }).text, 'only');
  assert.equal(applyEdit('x<<\nold\n>>y', { mode: 'block', start_marker: '<<', end_marker: '>>', new_text: '\nnew\n' }).text, 'x<<\nnew\n>>y');
  assert.equal(applyEdit('<<a>><<b>>', { mode: 'block', start_marker: '<<', end_marker: '>>', new_text: '' }).error, 'markers_not_unique');
  assert.match(lineDiff('a\nb\nc', 'a\nB\nc'), /-b\n\+B/);
});

test('edit: backup, atomic replace, mode kept, dry run and diff leave the file alone', async t => {
  const h = host(t);
  const file = h.p('srv/rw/app.conf');
  const dry = await h.tools.operator_edit({ path: file, mode: 'replace', old: 'listen 80', new_text: 'listen 8080', dry_run: true });
  assert.deepEqual([dry.ok, dry.dry_run, dry.changed], [true, true, true]);
  assert.match(dry.untrusted_content.diff, /-listen 80\n\+listen 8080/);
  assert.equal(readFileSync(file, 'utf8').startsWith('listen 80\n'), true, 'dry run wrote nothing');
  assert.deepEqual(backups(h.p('srv/rw'), 'app.conf'), []);
  const out = await h.tools.operator_edit({ path: file, mode: 'block', start_marker: '# BEGIN managed\n', end_marker: '# END managed', new_text: 'new\n' });
  assert.equal(out.ok, true);
  assert.match(readFileSync(file, 'utf8'), /# BEGIN managed\nnew\n# END managed/);
  assert.equal(statSync(file).mode & 0o777, 0o640, 'mode kept');
  assert.equal(backups(h.p('srv/rw'), 'app.conf').length, 1);
  assert.match(readFileSync(out.backup, 'utf8'), /\nold\n/, 'the backup holds the previous content');
  assert.equal(readdirSync(h.p('srv/rw')).some(f => f.startsWith('.memo-tmp-')), false, 'no temporary file left');
  const same = await h.tools.operator_edit({ path: file, mode: 'replace', old: 'new', new_text: 'new' });
  assert.deepEqual([same.ok, same.changed], [true, false]);
  // create: a new file only with create, never in a missing directory.
  assert.equal((await h.tools.operator_edit({ path: h.p('srv/rw/new.txt'), mode: 'write', new_text: 'x' })).error, 'not_found');
  const created = await h.tools.operator_edit({ path: h.p('srv/rw/new.txt'), mode: 'write', new_text: 'x', create: true });
  assert.deepEqual([created.ok, created.created, created.backup], [true, true, null]);
  assert.equal((await h.tools.operator_edit({ path: h.p('srv/rw/missing/x.txt'), mode: 'write', new_text: 'x', create: true })).error, 'not_found');
});

test('AC-P6-02: validators are named presets with fixed argv; any other name is refused by the schema; json runs in process', async t => {
  const h = host(t);
  const file = h.p('srv/rw/conf.json');
  writeFileSync(file, '{"a":1}');
  for (const name of ['bash -c id', 'sh', 'json; id', '../bin/x', 'nginx -s stop']) {
    const parsed = OPERATOR_SCHEMAS.operator_edit.safeParse({ host: 'vps', path: file, mode: 'write', new_text: '{}', validator: name });
    assert.equal(parsed.success, name === 'sh', name);
  }
  assert.deepEqual(Object.keys(VALIDATORS).sort(), [...VALIDATOR_PRESETS].sort());
  const bad = await h.tools.operator_edit({ path: file, mode: 'write', new_text: '{oops', validator: 'json' });
  assert.equal(bad.error, 'validation_failed');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}', 'a failed validation leaves the file untouched');
  assert.deepEqual(h.calls, [], 'json never starts a process');
  await h.tools.operator_edit({ path: file, mode: 'write', new_text: '{"a":2}', validator: 'json' });
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}');
  // A process preset: fixed argv, the only variable slot is the agent's own temporary file.
  const sh = h.p('srv/rw/run.sh');
  writeFileSync(sh, 'echo hi\n');
  const ok = await h.tools.operator_edit({ path: sh, mode: 'append', new_text: 'echo; id\n', validator: 'sh' });
  assert.equal(ok.ok, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].slice(0, 2), ['sh', '-n']);
  assert.match(h.calls[0][2], /\/srv\/rw\/\.memo-tmp-[0-9a-f]{16}$/);
  assert.equal(existsSync(h.calls[0][2]), false, 'the candidate copy is removed');
  // A failing process preset: nothing replaced.
  const failing = host(t, { run: async () => ({ code: 2, stdout: '', stderr: 'syntax error' }) });
  const before = readFileSync(failing.p('srv/rw/app.conf'), 'utf8');
  assert.equal((await failing.tools.operator_edit({ path: failing.p('srv/rw/app.conf'), mode: 'append', new_text: 'x', validator: 'nginx' })).error, 'validation_failed');
  assert.equal(readFileSync(failing.p('srv/rw/app.conf'), 'utf8'), before);
  // A missing validator program: validator_unavailable, nothing replaced.
  const missing = host(t, { run: async () => ({ code: null, stdout: '', stderr: '' }) });
  assert.equal((await missing.tools.operator_edit({ path: missing.p('srv/rw/app.conf'), mode: 'append', new_text: 'x', validator: 'caddy' })).error, 'validator_unavailable');
});

test('AC-P6-02 and AC-P6-13 on the write tools: .git and a default-branch checkout are refused; reads outside rw roots too', async t => {
  const h = host(t);
  const checkout = h.p('srv/rw/project');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(checkout, '.git', 'config'), '[core]\n');
  writeFileSync(join(checkout, 'README.md'), 'readme\n');
  writeFileSync(h.p('projects/PROJECTS.md'), ['# registry', '## Projets appartenant à Memo Labs', '| Name | Path | Kind | Status | Nature | Stack | Vault note |',
    '|---|---|---|---|---|---|---|', '| project | project | repo | active | infra | Node.js | - |', '## Dépôts de référence'].join('\n'));
  const policy = parseOperatorPolicy({ ...h.raw, max_tier: 'write', repositories: { projects_root: h.p('srv/rw'), layout_root: h.p('srv/rw') } });
  writeFileSync(h.p('srv/rw/PROJECTS.md'), readFileSync(h.p('projects/PROJECTS.md')));
  const tools = createOperatorWriteTools(policy, { stateDir: h.p('state') });
  assert.equal((await tools.operator_edit({ path: join(checkout, 'README.md'), mode: 'append', new_text: 'x' })).error, 'use_dev_flow');
  assert.equal((await tools.operator_edit({ path: join(checkout, '.git', 'config'), mode: 'append', new_text: '[core]\n\tsshCommand = id\n' })).error, 'git_internal');
  assert.equal((await tools.operator_delete({ path: join(checkout, 'README.md') })).error, 'use_dev_flow');
  assert.equal((await tools.operator_chmod({ path: join(checkout, '.git', 'config'), mode: '777' })).error, 'git_internal');
  assert.equal(readFileSync(join(checkout, '.git', 'config'), 'utf8'), '[core]\n');
  // Outside the write roots: refused, even inside a read root.
  assert.equal((await tools.operator_edit({ path: h.p('srv/app/config.txt'), mode: 'append', new_text: 'x' })).error, 'path_not_allowed');
  // Secrets inside a write root are refused for writes too.
  writeFileSync(h.p('srv/rw/.env'), 'SECRET=1');
  assert.equal((await tools.operator_edit({ path: h.p('srv/rw/.env'), mode: 'write', new_text: 'x' })).error, 'path_secret');
});

test('policy: a write tier needs the repositories section (no write tool without the D11 guard)', t => {
  const h = makeHost(t);
  const { repositories, ...raw } = h.raw;
  assert.throws(() => parseOperatorPolicy({ ...raw, max_tier: 'write' }), /invalid_operator_policy:repositories/);
  assert.throws(() => parseOperatorPolicy({ ...raw, max_tier: 'root', repositories }), /invalid_operator_policy:root_helper/);
  // The Mac: root only with a root helper (spec §13, Mac root follow-up).
  assert.throws(() => parseOperatorPolicy({ ...raw, host: 'mac', max_tier: 'root', repositories }), /invalid_operator_policy:root_helper/);
  const macRoot = parseOperatorPolicy({ ...raw, host: 'mac', max_tier: 'root', repositories, root_helper: { socket: '/var/run/memo-operator/root.sock' } });
  assert.deepEqual([macRoot.maxTierName, macRoot.rootHelper.socket], ['root', '/var/run/memo-operator/root.sock']);
  assert.throws(() => parseOperatorPolicy({ ...raw, run_env_allow: ['LD_PRELOAD'] }), /run_env_allow/);
  assert.throws(() => parseOperatorPolicy({ ...raw, run_env_allow: ['PATH'] }), /run_env_allow/);
  assert.equal(parseOperatorPolicy({ ...raw, max_tier: 'read' }).repositories, null, 'read only: no guard needed');
});

test('upload: init, chunks in any order, SHA-256 checked, backup of the replaced file, atomic move', async t => {
  const h = host(t);
  const data = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 100, 7);
  const sha = createHash('sha256').update(data).digest('hex');
  const target = h.p('srv/rw/blob.bin');
  writeFileSync(target, 'old');
  assert.equal((await h.tools.operator_upload_init({ path: target, size: data.length })).error, 'exists');
  const init = await h.tools.operator_upload_init({ path: target, size: data.length, overwrite: true });
  assert.equal(init.chunks, 3);
  const chunk = i => data.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES).toString('base64');
  for (const i of [2, 0]) assert.equal((await h.tools.operator_upload_chunk({ upload_id: init.upload_id, index: i, content_base64: chunk(i) })).ok, true);
  assert.equal((await h.tools.operator_upload_complete({ upload_id: init.upload_id, sha256: sha })).error, 'upload_incomplete');
  assert.equal((await h.tools.operator_upload_chunk({ upload_id: init.upload_id, index: 1, content_base64: 'AAAA' })).error, 'chunk_size_mismatch');
  await h.tools.operator_upload_chunk({ upload_id: init.upload_id, index: 1, content_base64: chunk(1) });
  assert.equal((await h.tools.operator_upload_complete({ upload_id: init.upload_id, sha256: 'f'.repeat(64) })).error, 'sha256_mismatch');
  assert.equal(readFileSync(target, 'utf8'), 'old', 'nothing moved on a bad hash');
  const done = await h.tools.operator_upload_complete({ upload_id: init.upload_id, sha256: sha });
  assert.equal(done.ok, true);
  assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'), sha);
  assert.equal(readFileSync(done.backup, 'utf8'), 'old');
  assert.equal((await h.tools.operator_upload_chunk({ upload_id: init.upload_id, index: 0, content_base64: chunk(0) })).error, 'unknown_upload');
  // The schema caps one chunk under the 128 KiB wire bound.
  assert.equal(OPERATOR_SCHEMAS.operator_upload_chunk.safeParse({ host: 'vps', upload_id: init.upload_id, index: 0,
    content_base64: 'A'.repeat(200 * 1024) }).success, false);
});

test('move, copy, delete: backups first, recursive required for directories, roots and secrets protected', async t => {
  const h = host(t);
  mkdirSync(h.p('srv/rw/dir/sub'), { recursive: true });
  writeFileSync(h.p('srv/rw/dir/a.txt'), 'a');
  writeFileSync(h.p('srv/rw/dir/.env'), CANARY);
  symlinkSync(h.p('home/op/.ssh/id_ed25519'), h.p('srv/rw/dir/key-link'));
  // copy: secrets left behind, symlinks copied as links (never their target's content).
  assert.equal((await h.tools.operator_copy({ src: h.p('srv/rw/dir'), dst: h.p('srv/rw/copy') })).error, 'recursive_required');
  const copied = await h.tools.operator_copy({ src: h.p('srv/rw/dir'), dst: h.p('srv/rw/copy'), recursive: true });
  assert.equal(copied.ok, true);
  assert.equal(existsSync(h.p('srv/rw/copy/a.txt')), true);
  assert.equal(existsSync(h.p('srv/rw/copy/.env')), false);
  assert.ok(copied.secret_entries_skipped >= 1);
  assert.equal(lstatSync(h.p('srv/rw/copy/key-link')).isSymbolicLink(), true);
  // move over an existing file needs overwrite and backs it up.
  writeFileSync(h.p('srv/rw/target.txt'), 'target');
  assert.equal((await h.tools.operator_move({ src: h.p('srv/rw/dir/a.txt'), dst: h.p('srv/rw/target.txt') })).error, 'exists');
  const moved = await h.tools.operator_move({ src: h.p('srv/rw/dir/a.txt'), dst: h.p('srv/rw/target.txt'), overwrite: true });
  assert.equal(readFileSync(h.p('srv/rw/target.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(moved.backup, 'utf8'), 'target');
  // delete: a file is backed up, a directory needs recursive and is archived with tar.
  const del = await h.tools.operator_delete({ path: h.p('srv/rw/target.txt') });
  assert.deepEqual([del.ok, existsSync(h.p('srv/rw/target.txt')), readFileSync(del.backup, 'utf8')], [true, false, 'a']);
  assert.equal((await h.tools.operator_delete({ path: h.p('srv/rw/copy') })).error, 'recursive_required');
  // The real tar archives the directory.
  const real = createOperatorWriteTools(h.policy, { stateDir: h.p('state') });
  const gone = await real.operator_delete({ path: h.p('srv/rw/copy'), recursive: true });
  assert.equal(gone.ok, true);
  assert.match(gone.backup, /copy\.memo-bak\.\d{8}T\d{6}Z-[0-9a-f]{6}\.tar\.gz$/);
  assert.equal(existsSync(h.p('srv/rw/copy')), false);
  assert.ok(statSync(gone.backup).size > 0);
  // A failing backup refuses the delete.
  const noTar = createOperatorWriteTools(h.policy, { stateDir: h.p('state'), run: async () => ({ code: 1, stdout: '', stderr: '' }) });
  assert.equal((await noTar.operator_delete({ path: h.p('srv/rw/dir'), recursive: true })).error, 'backup_failed');
  assert.equal(existsSync(h.p('srv/rw/dir/sub')), true, 'nothing deleted');
  // The write root itself is protected.
  assert.equal((await h.tools.operator_delete({ path: h.p('srv/rw'), recursive: true })).error, 'root_protected');
  assert.equal((await h.tools.operator_move({ src: h.p('srv/rw'), dst: h.p('srv/rw2') })).error, 'root_protected');
});

test('chmod: plain permission bits only, never through a symlink', async t => {
  const h = host(t);
  const out = await h.tools.operator_chmod({ path: h.p('srv/rw/app.conf'), mode: '600' });
  assert.deepEqual([out.ok, out.mode, out.previous], [true, '600', '640']);
  for (const mode of ['4755', '2755', '1777', '0o777', '7']) {
    assert.equal(OPERATOR_SCHEMAS.operator_chmod.safeParse({ host: 'vps', path: '/x', mode }).success, false, mode);
  }
  symlinkSync(h.p('srv/rw/app.conf'), h.p('srv/rw/link'));
  // The resolver canonicalizes the link to its target: the target is changed, the link itself never.
  assert.equal((await h.tools.operator_chmod({ path: h.p('srv/rw/link'), mode: '644' })).ok, true);
  assert.equal(statSync(h.p('srv/rw/app.conf')).mode & 0o777, 0o644);
});
