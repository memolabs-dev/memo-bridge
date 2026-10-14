// Phase 5 write gate, layer 2 (D7, REQ-P5-07, AC-P5-07 second half): with remote_writes enabled
// the hub refuses to start while any actions.runner.* unit runs, or would start at boot, as
// root, and whenever that cannot be established. The systemctl runner is injected; the
// fixture outputs are the shapes read on the VPS on 2026-10-14 (systemd 257, read-only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWriteGate, checkRunnerUsers, parseRemotePolicy, parseSystemctlShow, parseUnitNames, remotePolicyFromEnv,
  rootRunnerRisk, UNCONFIGURED_POLICY } from '../bridge/write-gate.mjs';

const EMARGO = 'actions.runner.guillaume-flambard-emargo.lab-emargo.service';
const LAB = 'actions.runner.guillaume-flambard-lab-infra.lab-infra.service';
const DROP = 'actions.runner.guillaume-flambard-drop.lab-drop.service';
const FACTURA = 'actions.runner.guillaume-flambard-factura.lab-factura.service';

// A fake systemctl: unit name -> properties; records every argv.
function fakeSystemctl(units, { fail = {} } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (fail[args[0]]) return { code: fail[args[0]], stdout: '' };
    if (args[0] === 'list-unit-files') {
      const names = Object.keys(units).filter(n => units[n].file !== false);
      return { code: names.length ? 0 : 1, stdout: names.map(n => `${n} ${units[n].UnitFileState ?? 'enabled'} enabled`).join('\n') };
    }
    if (args[0] === 'list-units') {
      return { code: 0, stdout: Object.keys(units).filter(n => units[n].loaded !== false)
        .map(n => `${n} loaded ${units[n].ActiveState ?? 'active'} running Runner`).join('\n') };
    }
    if (args[0] === 'show') {
      const names = args.slice(args.indexOf('--') + 1);
      return { code: 0, stdout: names.filter(n => units[n] && !units[n].hidden).map(n => [
        `User=${units[n].User ?? ''}`, `Id=${n}`, 'LoadState=loaded', `ActiveState=${units[n].ActiveState ?? 'active'}`,
        `UnitFileState=${units[n].UnitFileState ?? 'enabled'}`].join('\n')).join('\n\n') };
    }
    return { code: 1, stdout: '' };
  };
  return { run, calls };
}

const VPS_TODAY = {
  [LAB]: { User: 'github-runner-lab-infra' },
  [EMARGO]: { User: 'root' },
  [DROP]: { User: 'root', ActiveState: 'inactive' },
  [FACTURA]: { User: 'root', ActiveState: 'inactive', UnitFileState: 'disabled', loaded: false }
};

test('parsers: unit names, show blocks, empty User is root', () => {
  assert.deepEqual(parseUnitNames(`${EMARGO}  enabled enabled\nnot-a-runner.service x\n\n${DROP} enabled enabled`), [EMARGO, DROP]);
  const units = parseSystemctlShow(`User=root\nId=${EMARGO}\nActiveState=active\n\nId=${LAB}\nUser=\nActiveState=inactive\nUnitFileState=disabled\n`);
  assert.deepEqual(units.map(u => u.Id), [EMARGO, LAB]);
  assert.equal(rootRunnerRisk(units[0]), 'active');
  assert.equal(rootRunnerRisk(units[1]), null, 'root (empty User) but neither active nor enabled');
  assert.equal(rootRunnerRisk({ Id: 'x', ActiveState: 'inactive', UnitFileState: 'enabled' }), 'enabled', 'empty User means root');
  assert.equal(rootRunnerRisk({ Id: 'x', User: 'runner', ActiveState: 'active' }), null);
});

test('AC-P5-07: the VPS as observed on 2026-10-14 (emargo active as root, drop enabled as root) keeps the gate shut', async () => {
  const { run, calls } = fakeSystemctl(VPS_TODAY);
  const probe = await checkRunnerUsers({ systemctl: run });
  assert.equal(probe.ok, false);
  assert.equal(probe.error, 'root_runner');
  assert.deepEqual(probe.units, [{ unit: EMARGO, reason: 'active' }, { unit: DROP, reason: 'enabled' }]);
  // Every name was asked explicitly with --all (empty properties shown), after a separator.
  const show = calls.find(c => c[0] === 'show');
  assert.deepEqual(show.slice(0, 5), ['show', '--all', '-p', 'Id,User,ActiveState,UnitFileState,LoadState', '--']);
  assert.deepEqual(new Set(show.slice(5)), new Set([LAB, EMARGO, DROP, FACTURA]));

  await assert.rejects(assertWriteGate(parseRemotePolicy({ remote_writes: 'enabled' }), { systemctl: run }),
    error => error.message === 'write_gate_refused' && error.code === 'root_runner' && error.units.length === 2);
});

test('after #161: no root runner active or enabled opens the gate; a disabled, stopped root unit does not block', async () => {
  const fixed = { ...VPS_TODAY, [EMARGO]: { User: 'github-runner-emargo' }, [DROP]: { User: 'github-runner-drop', ActiveState: 'inactive' } };
  const { run } = fakeSystemctl(fixed);
  const probe = await assertWriteGate(parseRemotePolicy({ remote_writes: 'enabled' }), { systemctl: run });
  assert.equal(probe.ok, true);
  assert.equal(probe.units.length, 4);
  const none = fakeSystemctl({});
  assert.deepEqual(await checkRunnerUsers({ systemctl: none.run }), { ok: true, units: [] });
});

test('the gate fails closed when systemctl cannot answer or omits a unit', async () => {
  const policy = parseRemotePolicy({ remote_writes: 'enabled' });
  for (const fail of [{ 'list-units': 1 }, { 'list-unit-files': 4 }, { show: 1 }]) {
    const { run } = fakeSystemctl({ [LAB]: { User: 'runner' } }, { fail });
    await assert.rejects(assertWriteGate(policy, { systemctl: run }), error => error.code === 'probe_failed', JSON.stringify(fail));
  }
  const hidden = fakeSystemctl({ [LAB]: { User: 'runner' }, [EMARGO]: { User: 'root', hidden: true } });
  assert.equal((await checkRunnerUsers({ systemctl: hidden.run })).error, 'probe_failed');
  // A systemctl that is not there at all (the default runner on a Mac) fails closed as well.
  const missing = async () => ({ code: -1, stdout: '' });
  await assert.rejects(assertWriteGate(policy, { systemctl: missing }), error => error.code === 'probe_failed');
});

test('with writes disabled (the default) the probe is not run at all', async () => {
  let ran = false;
  const systemctl = async () => { ran = true; return { code: 1, stdout: '' }; };
  assert.deepEqual(await assertWriteGate(parseRemotePolicy({}), { systemctl }), { ok: true, skipped: true });
  assert.deepEqual(await assertWriteGate(UNCONFIGURED_POLICY, { systemctl }), { ok: true, skipped: true });
  assert.equal(ran, false);
});

test('remote policy: validation, defaults, and an unreadable file fails closed', () => {
  assert.deepEqual({ ...parseRemotePolicy({}) }, { projects: [], session_binding: 'warn', soft_deadline_ms: 40_000,
    remote_writes: 'disabled', owner_sub: null, configured: true });
  // The lab-infra remote.json shape: owner/repo entries name the catalog project, the soft
  // deadline and the owner sub come from their sections.
  assert.deepEqual({ ...parseRemotePolicy({ projects: ['memolabs-dev/memo-bridge', 'drop'], budgets: { soft_deadline_sec: 30 },
    oidc: { owner_sub: 'a1b2' }, remote_writes: 'enabled' }) },
  { projects: ['memo-bridge', 'drop'], session_binding: 'warn', soft_deadline_ms: 30_000, remote_writes: 'enabled', owner_sub: 'a1b2',
    configured: true });
  for (const bad of [null, [], { projects: 'drop' }, { projects: ['Drop!'] }, { session_binding: 'strict' },
    { soft_deadline_ms: 10 }, { soft_deadline_ms: 400_000 }, { remote_writes: 'yes' }, { budgets: { soft_deadline_sec: 0.5 } },
    { projects: ['owner/../x'] }, { oidc: { owner_sub: 'a b' } }, { oidc: [] }]) {
    assert.throws(() => parseRemotePolicy(bad), /invalid_remote_policy/, JSON.stringify(bad));
  }
  assert.equal(remotePolicyFromEnv({}), UNCONFIGURED_POLICY);
  assert.equal(remotePolicyFromEnv({ MEMO_BRIDGE_REMOTE_CONFIG: 'relative.json' }), UNCONFIGURED_POLICY);
  assert.equal(remotePolicyFromEnv({ MEMO_BRIDGE_REMOTE_CONFIG: '/nonexistent/remote-a.json' }), UNCONFIGURED_POLICY);
  const policy = remotePolicyFromEnv({ MEMO_BRIDGE_REMOTE_CONFIG: '/virtual/remote-b.json' },
    { readFile: () => JSON.stringify({ projects: ['drop'], session_binding: 'block' }) });
  assert.deepEqual([policy.configured, policy.projects, policy.session_binding], [true, ['drop'], 'block']);
});
