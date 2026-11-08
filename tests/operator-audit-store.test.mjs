// The host journal's file sink and its reaction to a journal that disappears under it
// (bridge/operator-audit.mjs, D7). A journal write that fails ENOENT made every operator call
// answer audit_unavailable (operator-agent.mjs), so the sink recreates the directory it lost:
// on 2026-11-08 a deleted ~/Library/Logs/memo-operator took every Mac operator call and the
// hub's 15-minute anchor down while the agent kept running and reporting itself healthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditChain, fileAuditStore, headInfoOf, verifyChain, verifyJournal } from '../bridge/operator-audit.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'audit-store-'));
const mode = p => statSync(p).mode & 0o777;
const line = (file, n) => JSON.parse(readFileSync(file, 'utf8').split('\n')[n - 1]);

test('append creates a missing parent directory (0700) and the journal (0600)', t => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'logs', 'memo-operator');
  const chain = createAuditChain({ store: fileAuditStore(join(dir, 'audit.jsonl')), now: () => 1_700_000_000_000 });
  const first = chain.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  assert.equal(first.seq, 1);
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, 'audit.jsonl')), 0o600);
  assert.equal(verifyChain(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).ok, true);
});

test('a journal removed under a running agent restarts a valid chain and marks the loss', t => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'logs', 'memo-operator');
  const file = join(dir, 'audit.jsonl');
  const chain = createAuditChain({ store: fileAuditStore(file), now: () => 1_700_000_000_000 });
  const first = chain.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  rmSync(dir, { recursive: true, force: true });
  // Continuing from seq 2 would leave a file that can never verify again, and the hub freezes on
  // chain_ok false with no way back: the new chain starts at 1 and says what it lost.
  const lost = chain.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  assert.equal(lost.seq, 1);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(line(file, 1).journal_lost, { seq: 1, hash: first.hash });
  assert.equal(verifyChain(readFileSync(file, 'utf8')).ok, true, 'the rebuilt journal verifies');
  const next = chain.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  assert.equal(next.seq, 2);
  assert.equal(line(file, 2).journal_lost, undefined);
  // The hub compares this head with its anchor and sees the rewrite at that sequence.
  const at = headInfoOf(readFileSync(file, 'utf8'), 1).at;
  assert.deepEqual(at, { seq: 1, hash: lost.hash });
  assert.notEqual(at.hash, first.hash);
  // A reader must not mistake that file for a complete history.
  assert.deepEqual(verifyJournal(readFileSync(file, 'utf8')).restarts, [{ seq: 1, lost_seq: first.seq, lost_hash: first.hash }]);
});

test('a torn last line from a crash is cut when the chain is loaded, not glued to the next line', t => {
  const root = tmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'logs', 'audit.jsonl');
  const chain = createAuditChain({ store: fileAuditStore(file), now: () => 1_700_000_000_000 });
  chain.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  // A crash during an append leaves the beginning of a line that was never committed.
  appendFileSync(file, '{"seq":2,"at":"2026-11-08T');
  const reopened = createAuditChain({ store: fileAuditStore(file), now: () => 1_700_000_000_000 });
  assert.equal(reopened.seq, 1);
  const next = reopened.append({ op: 'operator_read', tier: 0, outcome: 'ok' });
  assert.equal(next.seq, 2);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 2);
  assert.equal(verifyChain(text).ok, true);
});

test('a read that did not cover the whole journal never rewrites it', () => {
  // read() stops at MAX_AUDIT_READ_BYTES: cutting that prefix would destroy every line beyond it.
  let resets = 0;
  const store = {
    read: () => '{"seq":1}\n{"seq":2,"at":"2026',
    size: () => 64 * 1024 * 1024 + 4096,
    append() {},
    reset() { resets++; }
  };
  createAuditChain({ store });
  assert.equal(resets, 0);
});

test('a journal that cannot be rewritten still lets the agent start', () => {
  const text = '{"seq":1}\n{"seq":2,"at":"2026';
  const store = { read: () => text, size: () => Buffer.byteLength(text), append() {},
    reset() { const error = new Error('EACCES'); error.code = 'EACCES'; throw error; } };
  assert.doesNotThrow(() => createAuditChain({ store }), 'a read-only journal is reported by verify, not fatal at start');
});
