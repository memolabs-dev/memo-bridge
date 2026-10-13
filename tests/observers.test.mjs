import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentsObserve, focusStatus, guardianReport, liveState } from '../server/observers.mjs';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const now = () => NOW;

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'memo-observers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function guardianFixture(t, report) {
  const dir = await root(t);
  await writeFile(join(dir, 'PROJECTS.md'), ['## Projets appartenant à Memo Labs',
    '| Name | Path | Kind | Status | Nature | Stack | Vault note |', '|---|---|---|---|---|---|---|',
    '| infrastructure-guardian | infrastructure-guardian | repo | lab | infrastructure | Python | - |', '## Fin'].join('\n'));
  await mkdir(join(dir, 'infrastructure-guardian', 'reports'), { recursive: true });
  if (report) await writeFile(join(dir, 'infrastructure-guardian', 'reports', 'latest-all.json'), JSON.stringify(report));
  return { projectsRoot: dir, registryFile: join(dir, 'PROJECTS.md') };
}

test('guardian: summary per section, most severe findings first, freshness from the report', async t => {
  const finding = (status, check) => ({ check, status, title: `${check} ‮title\nwith break`, criterion: 'x' });
  const catalogOptions = await guardianFixture(t, {
    schema: 'guardian.report/v1', generated_at: '2026-10-13T09:20:05+02:00', run_id: 'r1', status: 'CRIT',
    sections: {
      vps: { status: 'CRIT', available: true, findings: [finding('OK', 'a'), finding('WARN', 'b'), finding('CRIT', 'c')] },
      mac: { status: 'OK', available: true, findings: [finding('OK', 'd')] }
    }
  });
  const r = await guardianReport({ catalogOptions, now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'CRIT');
  assert.equal(r.age_minutes, 760);
  assert.equal(r.stale, false);
  assert.deepEqual(r.sections.vps.findings, { OK: 1, WARN: 1, CRIT: 1 });
  assert.deepEqual(r.sections.vps.top.map(f => f.check), ['c', 'b']);
  assert.equal(r.sections.vps.top[0].title, 'c title with break', 'control and bidi characters are stripped');
  assert.deepEqual(r.sections.mac.top, []);
  const stale = await guardianReport({ catalogOptions, now: () => NOW + 2 * 86400000 });
  assert.equal(stale.stale, true);
});

test('guardian: missing project, missing report and foreign schema are reported, never guessed', async t => {
  assert.equal((await guardianReport({ catalogOptions: await guardianFixture(t, null), now })).error, 'source_unavailable');
  const foreign = await guardianReport({ catalogOptions: await guardianFixture(t, { schema: 'other' }), now });
  assert.equal(foreign.detail, 'unexpected_schema');
  const dir = await root(t);
  await writeFile(join(dir, 'PROJECTS.md'), '## Projets appartenant à Memo Labs\n| Name | Path | Kind | Status | Nature | Stack | Vault note |\n## Fin');
  const none = await guardianReport({ catalogOptions: { projectsRoot: dir, registryFile: join(dir, 'PROJECTS.md') }, now });
  assert.equal(none.error, 'source_unavailable');
});

test('agents-observe: bounded agent list with alert counts and freshness', async t => {
  const vaultRoot = await root(t);
  await mkdir(join(vaultRoot, '4-Tools'));
  const agents = Array.from({ length: 60 }, (_, i) => ({ nom: `agent-${i}`, quoi: 'x'.repeat(500), statut: 'running',
    depuis: '3 j', redemarrages: 0, alertes: ['a', 'b', 'c', 'd'] }));
  await writeFile(join(vaultRoot, '4-Tools', 'agents-observe.json'), JSON.stringify({ le: '2026-10-13T21:50:00', fenetre_h: 24, alertes: 7, agents }));
  const r = await agentsObserve({ vaultRoot, now: () => Date.parse('2026-10-13T21:55:00') });
  assert.equal(r.ok, true);
  assert.equal(r.agents.length, 50);
  assert.equal(r.agents[0].role.length, 160);
  assert.equal(r.agents[0].alerts, 4);
  assert.equal(r.agents[0].first_alerts.length, 3);
  assert.equal(r.age_minutes, 5);
  assert.equal(r.stale, false);
  assert.equal((await agentsObserve({ vaultRoot: join(vaultRoot, 'nope'), now })).error, 'source_unavailable');
});

test('live state: only operational sections leave the function', async t => {
  const agentDir = await root(t);
  await writeFile(join(agentDir, 'LIVE-STATE.md'), [
    '# LIVE STATE', '**Generated:** 2026-10-13T21:50:07', '',
    '## Live processes (someone is actively talking to Guillaume)', '- **Secret Corp** interview',
    '## Emploi — 15 relances dues', 'private pipeline line',
    '## CI — runs/checks rouges', '- red run on navirox',
    '## Configuration agents — 7 chemins', 'Detail : PATH-HEALTH.md',
    '## Git : 45 checkouts', '- mac repo (3 modif)'
  ].join('\n'));
  const r = await liveState({ agentDir, now: () => Date.parse('2026-10-13T22:00:07') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sections.map(s => s.heading.split(' ')[0]), ['CI', 'Configuration', 'Git']);
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('Secret Corp') && !serialized.includes('private pipeline'), 'job-search data is withheld');
  assert.equal(r.age_minutes, 10);
  assert.equal((await liveState({ agentDir: join(agentDir, 'nope'), now })).error, 'source_unavailable');
});

test('focus: active bet with review due, else the last closed bet; failures are reported', async () => {
  const fake = output => (cmd, args, options, callback) => {
    assert.deepEqual(args, ['focus', '--json']);
    output instanceof Error ? callback(output) : callback(null, output);
  };
  const active = { project: 'intentlane', bet: 'first euro', kill: 'no call', setAt: '2026-09-26T10:16:59Z', horizonDays: 14 };
  const r1 = await focusStatus({ run: fake(JSON.stringify({ active, history: [] })), now });
  assert.equal(r1.active.project, 'intentlane');
  assert.equal(r1.review_due, true);
  const closed = { ...active, endedAt: '2026-10-09T11:33:36Z', verdict: 'killed' };
  const r2 = await focusStatus({ run: fake(JSON.stringify({ active: null, history: [closed, { ...closed, project: 'older' }] })), now });
  assert.equal(r2.active, null);
  assert.equal(r2.last_closed.project, 'intentlane', 'history is newest first');
  assert.equal(r2.last_closed.verdict, 'killed');
  assert.equal((await focusStatus({ run: fake(new Error('missing')), now })).error, 'source_unavailable');
  assert.equal((await focusStatus({ run: fake('not json'), now })).detail, 'unexpected_output');
});
