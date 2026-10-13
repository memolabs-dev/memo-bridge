import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHost, collectHost } from '../server/probe.mjs';

test('unknown machines are rejected', () => {
  for (const host of ['router', '', 'vps; rm -rf /', '../etc']) {
    assert.throws(() => validateHost(host));
  }
});
test('mac probe is read only, structured, and bounded', async () => {
  const r = await collectHost('mac');
  assert.equal(r.host, 'mac');
  assert.equal(r.online, true, JSON.stringify(r));
  assert.ok(['Darwin', 'Linux', 'Windows'].includes(r.system));
  assert.ok(r.disk_free_gib > 0);
});
test('vps probe returns bounded availability response', async () => {
  const r = await collectHost('vps');
  assert.equal(r.host, 'vps');
  assert.equal(typeof r.online, 'boolean');
  if (r.online) {
    assert.equal(r.system, 'Linux');
    assert.equal(typeof r.docker_running_containers, 'number');
  }
});
