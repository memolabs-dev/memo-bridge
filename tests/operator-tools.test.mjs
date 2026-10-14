// Phase 6, TODO-P6-03 (R-P6-03 by construction, R-P6-08, R-P6-12; AC-P6-02, AC-P6-06,
// AC-P6-12 bounding part): the T0 tools as the host agent runs them, on a temporary host tree
// with canary secrets, and with a recording argv runner instead of journalctl, systemctl and
// docker. Nothing here runs a shell or touches the real system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createOperatorTools, decodeSlice, runArgv, searchMatcher } from '../bridge/operator-tools.mjs';
import { boundResult, finalizeResult, redactSecrets, RESULT_LIMIT_BYTES, UNTRUSTED_NOTE } from '../bridge/operator-output.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { AWS_KEY, CANARY, GITHUB_TOKEN, JWT, makeHost } from './helpers/operator-fixture.mjs';

// Records every argv; answers like the real commands would.
function recorder(answers = {}) {
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    const key = argv[0];
    return answers[key] ? answers[key](argv) : { code: 0, stdout: '', stderr: '', truncated: false };
  };
  return { run, calls };
}
const tools = (host, extra = {}) => createOperatorTools(host.policy, { projects: async () => [], platform: 'linux', ...extra });
const everything = value => finalizeResult(value).data;

test('AC-P6-06: canary files in .ssh, .env and keys never come back from list, read or search', async t => {
  const host = makeHost(t);
  const op = tools(host);
  const listed = everything(await op.operator_list({ path: host.p('home'), depth: 5, show_hidden: true }));
  const srv = everything(await op.operator_list({ path: host.p('srv'), depth: 5, show_hidden: true }));
  for (const out of [listed, srv]) {
    assert.equal(out.ok, true);
    const text = JSON.stringify(out);
    for (const secret of ['.ssh', 'id_ed25519', '.env', 'server.pem', CANARY]) assert.equal(text.includes(secret), false, secret);
  }
  assert.ok(listed.secret_entries_skipped >= 2 && srv.secret_entries_skipped >= 1);
  assert.ok(srv.untrusted_content.entries.some(e => e.path.endsWith('config.txt')));
  // Hidden entries stay hidden by default.
  assert.equal(JSON.stringify(everything(await op.operator_list({ path: host.p('srv/app') }))).includes('.env'), false);
  // Direct reads of the secrets, and of a symlink into .ssh.
  for (const secret of ['srv/app/.env', 'home/op/.ssh/id_ed25519', 'home/op/innocent', 'home/op/keys/server.pem']) {
    const out = everything(await op.operator_read({ path: host.p(secret) }));
    assert.deepEqual(out, { ok: false, error: 'path_secret' }, secret);
  }
  // A search for the canary itself, from the top of every root.
  for (const top of ['srv', 'home']) {
    const out = everything(await op.operator_search({ path: host.p(top), pattern: CANARY }));
    assert.equal(out.ok, true);
    assert.equal(out.count, 0, top);
    assert.equal(JSON.stringify(out).includes(CANARY), false, top);
  }
  assert.equal((await op.operator_search({ path: host.p('home/op/.ssh'), pattern: 'x' })).error, 'path_secret');
});

test('AC-P6-06: token-like strings are redacted before a result leaves the host', async t => {
  const host = makeHost(t);
  const op = tools(host);
  const read = everything(await op.operator_read({ path: host.p('srv/app/config.txt') }));
  const text = JSON.stringify(read);
  for (const secret of [GITHUB_TOKEN, AWS_KEY, JWT]) assert.equal(text.includes(secret), false, secret);
  assert.match(read.untrusted_content.content, /\[REDACTED:github\]/);
  assert.match(read.untrusted_content.content, /\[REDACTED:aws\]/);
  assert.match(read.untrusted_content.content, /\[REDACTED:jwt\]/);
  assert.equal(read.redactions, 3);
  const found = everything(await op.operator_search({ path: host.p('srv'), pattern: 'token=' }));
  assert.equal(found.count, 1);
  assert.equal(JSON.stringify(found).includes(GITHUB_TOKEN), false);
  // The redactor alone, every family.
  for (const [secret, kind] of [[`github_pat_${'x1'.repeat(15)}`, 'github'], [`gho_${'a'.repeat(36)}`, 'github'], [`sk-proj-${'b'.repeat(40)}`, 'openai'],
    [`sk-ant-api03-${'c'.repeat(40)}`, 'openai'], [`xoxb-${'1234567890-'.repeat(3)}abc`, 'slack'], ['ASIAABCDEFGHIJKLMNOP', 'aws'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'pem']]) {
    const r = redactSecrets(`before ${secret} after`);
    assert.equal(r.text, `before [REDACTED:${kind}] after`, kind);
  }
  assert.equal(redactSecrets('sk-short and skeleton and AKIA lowercase').count, 0);
});

test('untrusted content: file text, names and command output are wrapped with the boundary note', async t => {
  const host = makeHost(t);
  const op = tools(host);
  const read = await op.operator_read({ path: host.p('srv/app/notes.md') });
  assert.equal(read.note, UNTRUSTED_NOTE);
  assert.match(read.untrusted_content.content, /Ignore previous instructions/);
  assert.equal(read.content, undefined, 'never at the top level');
  assert.equal((await op.operator_list({ path: host.p('srv') })).note, UNTRUSTED_NOTE);
  assert.equal((await op.operator_search({ path: host.p('srv'), pattern: 'needle' })).note, UNTRUSTED_NOTE);
});

test('read: byte ranges with next_offset, binary flagged, encodings, not a file', async t => {
  const host = makeHost(t);
  const op = tools(host);
  writeFileSync(host.p('srv/app/range.txt'), 'abcdefghij');
  const first = await op.operator_read({ path: host.p('srv/app/range.txt'), max_bytes: 4 });
  assert.deepEqual([first.untrusted_content.content, first.next_offset, first.size], ['abcd', 4, 10]);
  const last = await op.operator_read({ path: host.p('srv/app/range.txt'), offset: 8 });
  assert.deepEqual([last.untrusted_content.content, last.next_offset], ['ij', null]);
  writeFileSync(host.p('srv/app/blob.bin'), Buffer.from([1, 2, 0, 3]));
  const bin = await op.operator_read({ path: host.p('srv/app/blob.bin') });
  assert.deepEqual([bin.encoding, bin.binary, bin.untrusted_content], ['binary', true, undefined]);
  assert.equal((await op.operator_read({ path: host.p('srv/app') })).error, 'not_a_file');
  assert.equal(decodeSlice(Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), { atStart: true }).text, 'hi');
  assert.equal(decodeSlice(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), { atStart: true }).text, 'hi');
  assert.equal(decodeSlice(Buffer.from([0xc3]), { atStart: false }).encoding, 'utf-8-lossy');
  // The schema caps a read at 128 KiB.
  assert.equal(OPERATOR_SCHEMAS.operator_read.safeParse({ host: 'vps', path: '/x', max_bytes: 128 * 1024 + 1 }).success, false);
});

test('AC-P6-12 (bounding): a 5 MB output comes back at most 128 KiB with _truncation.omitted pointers', async t => {
  const host = makeHost(t);
  const big = 'x'.repeat(5 * 1024 * 1024);
  const bounded = boundResult({ ok: true, untrusted_content: { content: big }, meta: 'kept' });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= RESULT_LIMIT_BYTES);
  assert.deepEqual(bounded._truncation.omitted, ['/untrusted_content/content']);
  assert.equal(bounded._truncation.original_bytes > 5 * 1024 * 1024, true);
  assert.equal(bounded.meta, 'kept');
  assert.match(bounded.untrusted_content.content, /^x+\n\[\.\.\. \d+ bytes omitted \.\.\.\]\nx+$/);
  // Long arrays lose their tail; the pointer names the array.
  const many = boundResult({ ok: true, lines: Array.from({ length: 50_000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`) });
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= RESULT_LIMIT_BYTES);
  assert.deepEqual(many._truncation.omitted, ['/lines']);
  assert.equal(many.lines[0], `line 0 ${'y'.repeat(20)}`);
  // Small results pass untouched (same object).
  const small = { ok: true, a: 1 };
  assert.equal(boundResult(small), small);
  // A log of 5 MB through the real tool path.
  const run = async () => ({ code: 0, stdout: `${'z'.repeat(200)}\n`.repeat(26_000), stderr: '', truncated: false });
  const logs = everything(await tools(host, { run }).operator_logs({ unit: 'traefik.service', lines: 2000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(logs)) <= RESULT_LIMIT_BYTES);
  assert.ok(logs._truncation.omitted.length >= 1);
});

test('AC-P6-02: no caller string is executed; only declared units and containers fill one argv slot', async t => {
  const host = makeHost(t);
  const { run, calls } = recorder({ systemctl: () => ({ code: 0, stdout: 'Id=traefik.service\nActiveState=active\nUnitFileState=enabled\nMainPID=42\n', stderr: '' }) });
  const op = tools(host, { run });
  // Undeclared units, injection attempts, flags: refused before any process starts.
  for (const unit of ['ssh.service', 'traefik.service; id', 'traefik.service --root=/', '-p', '$(id).service', 'traefik.service\nid']) {
    assert.equal((await op.operator_logs({ unit })).error, 'unit_not_declared', unit);
    assert.equal((await op.operator_service_status({ unit })).error, 'unit_not_declared', unit);
  }
  for (const container of ['other', 'traefik;id', '--privileged']) {
    assert.equal((await op.operator_logs({ container })).error, 'container_not_declared', container);
  }
  assert.equal((await op.operator_logs({})).error, 'invalid_arguments');
  assert.equal((await op.operator_logs({ unit: 'traefik.service', container: 'traefik' })).error, 'invalid_arguments');
  assert.deepEqual(calls, [], 'nothing ran');
  // Declared: fixed argv, the caller's value in exactly one slot, joined with its flag.
  await op.operator_logs({ unit: 'traefik.service', lines: 50, since: '-2h' });
  await op.operator_logs({ container: 'traefik', lines: 10, since: '-2h' });
  const status = await op.operator_service_status({ unit: 'traefik.service' });
  assert.deepEqual(calls, [
    ['journalctl', '--no-pager', '--output=short-iso', '--lines=50', '--unit=traefik.service', '--since=-2h'],
    ['docker', 'logs', '--tail=10', '--since=2h', 'traefik'],
    ['systemctl', 'show', '--no-pager', '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestamp,Result,NRestarts', 'traefik.service']
  ]);
  assert.deepEqual([status.is_active, status.is_enabled, status.main_pid], ['active', 'enabled', 42]);
  // The schema refuses a since value that is not a journalctl time form.
  for (const since of ['$(id)', '-2h; id', '--all', '2026-10-14 12:00 --root=/']) {
    assert.equal(OPERATOR_SCHEMAS.operator_logs.safeParse({ host: 'vps', unit: 'traefik.service', since }).success, false, since);
  }
  // The real runner never uses a shell: shell metacharacters are plain argument bytes.
  const echoed = await runArgv(['/bin/echo', 'a;id', '$(id)', '|', '`id`']);
  assert.equal(echoed.stdout, 'a;id $(id) | `id`\n');
  const noShell = await runArgv(['a;id']);
  assert.equal(noShell.code, null, 'a command string is a file name, not a shell line');
});

test('search: regex guard, literal and case options, budgets', async t => {
  const host = makeHost(t);
  const op = tools(host);
  assert.equal(searchMatcher('(a+)+$', { regex: true }).error, 'regex_too_complex');
  assert.equal(searchMatcher('(x*)*', { regex: true }).error, 'regex_too_complex');
  assert.equal(searchMatcher('([', { regex: true }).error, 'invalid_pattern');
  assert.equal(searchMatcher('^listen \\d+', { regex: true }).ok, true);
  assert.equal((await op.operator_search({ path: host.p('srv'), pattern: '(a+)+', regex: true })).error, 'regex_too_complex');
  const insensitive = await op.operator_search({ path: host.p('srv'), pattern: 'NEEDLE', case_sensitive: false });
  assert.equal(insensitive.count, 1);
  assert.equal((await op.operator_search({ path: host.p('srv'), pattern: 'NEEDLE' })).count, 0);
  const globbed = await op.operator_search({ path: host.p('srv'), pattern: 'e', file_glob: '*.md' });
  assert.ok(globbed.untrusted_content.matches.every(m => m.path.endsWith('.md')));
  const capped = await op.operator_search({ path: host.p('srv'), pattern: 'e', max_results: 1 });
  assert.deepEqual([capped.count, capped.truncated_reason], [1, 'max_results']);
  // The 20 s budget: a clock that jumps stops the walk with truncated_reason time_budget.
  let t0 = 0;
  const jumpy = tools(host, { now: () => (t0 += 15_000) });
  assert.equal((await jumpy.operator_search({ path: host.p('srv'), pattern: 'zzz' })).truncated_reason, 'time_budget');
});

test('state, policy and freeze status on a fake host', async t => {
  const host = makeHost(t);
  const { run, calls } = recorder({
    systemctl: () => ({ code: 0, stdout: 'bad.service loaded failed failed Bad\n', stderr: '' }),
    docker: () => ({ code: 0, stdout: 'traefik\tUp 2 days\n', stderr: '' })
  });
  const op = tools(host, { run, guard: { status: () => ({ file: true, auto: false }) } });
  const state = await op.operator_state();
  assert.deepEqual(state.untrusted_content.failed_units, ['bad.service']);
  assert.deepEqual(state.untrusted_content.containers, [{ name: 'traefik', status: 'Up 2 days' }]);
  assert.ok(state.disk.length >= 1 && state.memory.total_mib > 0);
  assert.deepEqual(calls.map(c => c[0]), ['systemctl', 'docker']);
  const policy = await op.operator_policy();
  assert.equal(policy.policy.max_tier, 'read');
  assert.deepEqual(policy.frozen, { file: true, auto: false });
  const freeze = await op.operator_freeze_status();
  assert.deepEqual([freeze.host_frozen_file, freeze.frozen_above_t0], [true, true]);
  // On the Mac there is no systemd: logs and status answer a clear code, nothing runs.
  const mac = createOperatorTools(host.policy, { run, platform: 'darwin', projects: async () => [] });
  assert.equal((await mac.operator_logs({ unit: 'traefik.service' })).error, 'logs_unavailable_on_host');
  assert.equal((await mac.operator_service_status({ unit: 'traefik.service' })).error, 'systemd_unavailable_on_host');
});
