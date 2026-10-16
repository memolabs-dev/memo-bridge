import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteStore } from '../server/coordinator/store.mjs';
import { recordSourceChange } from '../server/source-engine/changes.mjs';
import { registerSourceTools, SOURCE_TOOLS } from '../server/tools/source-tools.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import { tempStateDir } from './helpers/coordinator-fixture.mjs';

const local = makePrincipal('local:owner', [CAPABILITIES.READ]);
const remote = makePrincipal('oidc:reader', [CAPABILITIES.READ]);
const issue = 'memolabs-dev/drop#7';
const base = {
  project_id: 'drop', issue_ref: issue, branch: 'agent/7-bbbb',
  head_sha: 'a'.repeat(40), ci_state: 'success', pr_number: 18
};
const parse = value => JSON.parse(value.content[0].text);

async function fixture(t, principal = local, overrides = {}) {
  const store = openSqliteStore({ dir: await tempStateDir(t) });
  t.after(() => store.close());
  const tools = new Map();
  const audit = [];
  const rt = {
    principal, store: () => store, now: Date.now, catalogOptions: {},
    authorize: op => SOURCE_TOOLS.includes(op) && principal.capabilities.has(CAPABILITIES.READ),
    audit: async (...x) => { audit.push(x); }
  };
  registerSourceTools({ registerTool(name, def, handler) { tools.set(name, { def, handler }); } },
    () => rt, {
      listProjects: async () => ({ projects: [{ name: 'drop', kind: 'repo' }, { name: 'emargo', kind: 'repo' }] }),
      repoFor: async (_rt, project) => project === 'drop' ? 'memolabs-dev/drop' : 'memolabs-dev/emargo',
      remotePolicy: () => ({ configured: true, projects: ['drop'] }),
      ...overrides
    });
  const invoke = async (op, args) => parse(await tools.get(op).handler(args));
  return { store, tools, audit, invoke };
}

test('source tools: all three declare non-destructive read-only MCP annotations', async t => {
  const { tools } = await fixture(t);
  assert.deepEqual([...tools.keys()].sort(), [...SOURCE_TOOLS].sort());
  for (const { def } of tools.values()) {
    assert.equal(def.annotations.readOnlyHint, true);
    assert.equal(def.annotations.destructiveHint, false);
    assert.equal(def.annotations.openWorldHint, false);
  }
});

test('source tools: list, status, history, pagination and verified repository links', async t => {
  const { store, invoke, audit } = await fixture(t);
  const record = async (id, index) => recordSourceChange(store, {
    id, patch: { ...base, pr_number: index }, at: 1000 + index,
    event_id: 'event-create-' + id.replace(/\./g, '_')
  });
  await record('drop.change1', 1);
  await record('drop.change2', 2);
  const one = await invoke('source_changes_list', { project: 'drop', limit: 1 });
  assert.equal(one.ok, true);
  assert.equal(one.count, 1);
  assert.equal(one.next_offset, 1);
  const two = await invoke('source_changes_list', { project: 'drop', limit: 1, offset: one.next_offset });
  assert.equal(two.ok, true);
  assert.equal(two.count, 1);
  assert.notEqual(one.changes[0].id, two.changes[0].id);
  assert.equal(one.changes[0].issue_url, 'https://github.com/memolabs-dev/drop/issues/7');
  assert.equal(one.changes[0].checks_url, 'https://github.com/memolabs-dev/drop/commit/' + 'a'.repeat(40) + '/checks');
  const result = await invoke('source_change_status', { project: 'drop', id: 'drop.change1' });
  assert.equal(result.ok, true);
  assert.equal(result.change.pr_url, 'https://github.com/memolabs-dev/drop/pull/1');
  assert.equal(result.change.branch, 'agent/7-bbbb');
  const history = await invoke('source_change_history', { project: 'drop', id: 'drop.change1', limit: 1 });
  assert.equal(history.ok, true);
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].snapshot.id, 'drop.change1');
  assert.ok(!JSON.stringify(history).includes('snapshot_json'));
  assert.ok(audit.some(([name, status]) => name === 'source_change_status' && status === 'ok'));
});

test('source tools: strict allowlist, canonical names and no cross-project disclosure', async t => {
  const { store, invoke, audit } = await fixture(t, remote);
  await recordSourceChange(store, { id: 'drop.real', patch: base });
  await recordSourceChange(store, { id: 'drop.badorigin',
    patch: { ...base, issue_ref: 'third-party/public#1' } });
  await recordSourceChange(store, { id: 'emargo.private',
    patch: { ...base, project_id: 'emargo', issue_ref: 'memolabs-dev/emargo#2' } });
  assert.equal((await invoke('source_changes_list', { project: 'emargo' })).error, 'project_not_allowed');
  assert.equal((await invoke('source_change_status', { project: 'drop', id: 'emargo.private' })).error, 'not_found');
  assert.equal((await invoke('source_change_history', { project: 'drop', id: 'drop.badorigin' })).error, 'not_found');
  const out = await invoke('source_changes_list', { project: 'drop' });
  assert.equal(out.count, 1);
  assert.equal(out.changes[0].id, 'drop.real');
  assert.equal((await invoke('source_changes_list', { project: 'DROP' })).error, 'invalid_input');
  assert.equal((await invoke('source_changes_list', { project: 'unregistered' })).error, 'unknown_project');
  assert.equal((await invoke('source_changes_list', { project: '../drop' })).error, 'invalid_input');
  assert.equal((await invoke('source_change_status', { project: 'drop', id: '../../etc/passwd' })).error, 'invalid_input');
  assert.equal((await invoke('source_changes_list', { project: 'drop', limit: 10000 })).error, 'invalid_input');
  assert.equal((await invoke('source_change_history', { project: 'drop', id: 'drop.real', limit: 10000 })).error, 'invalid_input');
  assert.ok(audit.some(([name, status, code]) => name === 'source_changes_list' && status === 'denied' && code === 'project_not_allowed'));
});

test('source tools: remote missing allowlist and missing origin fail closed', async t => {
  const a = await fixture(t, remote, { remotePolicy: () => ({ configured: false, projects: [] }) });
  assert.equal((await a.invoke('source_changes_list', { project: 'drop' })).error, 'project_not_allowed');
  const b = await fixture(t, local, { repoFor: async () => null });
  assert.equal((await b.invoke('source_changes_list', { project: 'drop' })).error, 'repo_unavailable');
});
