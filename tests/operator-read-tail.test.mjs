// Issue #44: operator_read tail_lines. The last N lines of a large log, read from the end of the
// file within the usual read bound, behind the same policy, denylist and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, truncateSync, writeFileSync } from 'node:fs';
import { createOperatorTools, LIMITS } from '../bridge/operator-tools.mjs';
import { finalizeResult } from '../bridge/operator-output.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { GITHUB_TOKEN, makeHost } from './helpers/operator-fixture.mjs';

const tools = host => createOperatorTools(host.policy, { projects: async () => [], platform: 'linux' });
const done = value => finalizeResult(value).data;
const line = i => `2026-10-14T21:00:00Z line ${String(i).padStart(7, '0')} ${'x'.repeat(60)}`;

test('#44: tail_lines 30 on a 10 MB log returns exactly its last 30 lines, within the read bound', async t => {
  const host = makeHost(t);
  const lines = [];
  let size = 0;
  for (let i = 0; size < 10 * 1024 * 1024; i++) { const l = line(i); lines.push(l); size += l.length + 1; }
  writeFileSync(host.p('srv/app/big.log'), lines.join('\n') + '\n');
  const out = done(await tools(host).operator_read({ path: host.p('srv/app/big.log'), tail_lines: 30 }));
  assert.equal(out.ok, true);
  assert.equal(out.lines, 30);
  assert.equal(out.tail_lines, 30);
  assert.equal(out.untrusted_content.content, lines.slice(-30).join('\n') + '\n');
  assert.equal(out.offset + out.bytes, out.size, 'the slice ends at the end of the file');
  assert.equal(out.next_offset, null);
  assert.ok(out.bytes <= LIMITS.readMaxBytes);
  assert.equal(out.truncated, undefined);
});

test('#44: a final newline ends the last line; without one the last line still counts; short files come back whole', async t => {
  const host = makeHost(t);
  const op = tools(host);
  writeFileSync(host.p('srv/app/a.log'), 'one\ntwo\nthree\nfour');
  let out = await op.operator_read({ path: host.p('srv/app/a.log'), tail_lines: 2 });
  assert.equal(out.untrusted_content.content, 'three\nfour');
  assert.equal(out.lines, 2);
  writeFileSync(host.p('srv/app/b.log'), 'one\ntwo\nthree\n');
  out = await op.operator_read({ path: host.p('srv/app/b.log'), tail_lines: 1 });
  assert.equal(out.untrusted_content.content, 'three\n');
  assert.equal(out.lines, 1);
  out = await op.operator_read({ path: host.p('srv/app/b.log'), tail_lines: 50 });
  assert.equal(out.untrusted_content.content, 'one\ntwo\nthree\n');
  assert.equal(out.lines, 3);
  assert.equal(out.offset, 0);
  writeFileSync(host.p('srv/app/c.log'), 'x\n\n');
  out = await op.operator_read({ path: host.p('srv/app/c.log'), tail_lines: 1 });
  assert.equal(out.untrusted_content.content, '\n', 'an empty last line is one line');
  // The final newline alone in the last 16 KiB chunk: reading must go on to the previous chunk.
  writeFileSync(host.p('srv/app/d.log'), `${'A'.repeat(20000)}\n${'B'.repeat(17000)}\n`);
  out = await op.operator_read({ path: host.p('srv/app/d.log'), tail_lines: 1 });
  assert.equal(out.untrusted_content.content, `${'B'.repeat(17000)}\n`);
  assert.equal(out.truncated, undefined);
  writeFileSync(host.p('srv/app/empty.log'), '');
  out = await op.operator_read({ path: host.p('srv/app/empty.log'), tail_lines: 5 });
  assert.equal(out.lines, 0);
  assert.equal(out.untrusted_content.content, '');
});

test('#44: the end of a 2 GiB sparse file is read without reading the file', async t => {
  const host = makeHost(t);
  const file = host.p('srv/app/huge.log');
  writeFileSync(file, '');
  truncateSync(file, 2 * 1024 * 1024 * 1024);
  appendFileSync(file, '\nalpha\nbeta\ngamma\n');
  const started = Date.now();
  const out = await tools(host).operator_read({ path: file, tail_lines: 3 });
  assert.equal(out.untrusted_content.content, 'alpha\nbeta\ngamma\n');
  assert.equal(out.encoding, 'utf-8', 'only the end was looked at: no zero byte from the sparse part');
  assert.ok(Date.now() - started < 5_000);
});

test('#44: lines larger than the window come back as the complete lines that fit, flagged max_bytes', async t => {
  const host = makeHost(t);
  const long = Array.from({ length: 10 }, (_, i) => `${i}:${'y'.repeat(1000)}`);
  writeFileSync(host.p('srv/app/wide.log'), long.join('\n') + '\n');
  const out = await tools(host).operator_read({ path: host.p('srv/app/wide.log'), tail_lines: 10, max_bytes: 3500 });
  assert.equal(out.truncated, 'max_bytes');
  assert.equal(out.lines, 3);
  assert.equal(out.untrusted_content.content, long.slice(-3).join('\n') + '\n');
  assert.ok(out.bytes <= 3500);
});

test('#44: refusals are unchanged: secret paths, outside the roots, symlink escape, bad arguments; content redacted', async t => {
  const host = makeHost(t);
  const op = tools(host);
  for (const path of ['srv/app/.env', 'home/op/.ssh/id_ed25519', 'home/op/keys/server.pem']) {
    const plain = done(await op.operator_read({ path: host.p(path) }));
    const tailed = done(await op.operator_read({ path: host.p(path), tail_lines: 5 }));
    assert.deepEqual(tailed, plain, path);
    assert.equal(tailed.ok, false);
  }
  for (const path of ['outside/plain.txt', 'srv/app/escape-link', 'srv/app/sub']) {
    const plain = done(await op.operator_read({ path: host.p(path) }));
    assert.deepEqual(done(await op.operator_read({ path: host.p(path), tail_lines: 5 })), plain, path);
  }
  assert.equal((await op.operator_read({ path: host.p('srv/app/config.txt'), tail_lines: 2, offset: 0 })).error, 'invalid_arguments');
  const read = done(await op.operator_read({ path: host.p('srv/app/config.txt'), tail_lines: 3 }));
  assert.equal(read.ok, true);
  assert.equal(JSON.stringify(read).includes(GITHUB_TOKEN), false);
  const schema = OPERATOR_SCHEMAS.operator_read;
  for (const n of [0, 2001, 1.5]) assert.equal(schema.safeParse({ path: '/srv/x', tail_lines: n }).success, false, String(n));
  for (const n of [1, 2000]) assert.equal(schema.safeParse({ path: '/srv/x', tail_lines: n }).success, true, String(n));
});
