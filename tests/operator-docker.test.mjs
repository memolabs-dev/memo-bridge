// Repatriation (spec .agent/project/repatriate, RR-13, RR-7 helper part, D-R11, D-R5):
// operator_docker through the root helper over a fake Docker Engine API on a real Unix socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDockerActions, demultiplex, socketRequest, DOCKER_API } from '../bridge/operator-docker.mjs';
import { createRootHelper } from '../bridge/operator-root-helper.mjs';
import { createOperatorGuard } from '../bridge/operator-guard.mjs';
import { createAuditChain, fileAuditStore } from '../bridge/operator-audit.mjs';
import { createOperatorVerifier } from '../bridge/operator-signing.mjs';
import { createJobStore } from '../bridge/operator-jobs.mjs';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorCallTier } from '../server/coordinator/policy.mjs';
import { operatorTargets } from '../bridge/operator-locks.mjs';
import { makeHost, signingPair, GITHUB_TOKEN } from './helpers/operator-fixture.mjs';

const CONTAINERS = [
  { Names: ['/traefik'], Image: 'traefik:v3', State: 'running', Status: 'Up 2 days', Ports: [{ IP: '0.0.0.0', PrivatePort: 443, PublicPort: 443, Type: 'tcp' }],
    Labels: { 'com.docker.compose.project': 'edge', 'com.docker.compose.service': 'traefik' } },
  { Names: ['/beszel'], Image: 'henrygd/beszel', State: 'running', Status: 'Up 1 hour', Ports: [], Labels: { 'com.docker.compose.project': 'monitoring' } },
  { Names: ['/old-job'], Image: 'x', State: 'exited', Status: 'Exited (0)', Ports: [], Labels: {} }
];
const frame = (type, text) => { const body = Buffer.from(text); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };

// A fake daemon: records every request, answers like the Engine API.
async function fakeDocker(t) {
  const dir = realpathSync(mkdtempSync(join('/tmp', 'mdk-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'docker.sock');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://docker');
    const path = url.pathname.slice(DOCKER_API.length);
    if (req.method === 'GET' && path === '/containers/json') { res.end(JSON.stringify(CONTAINERS)); return; }
    let m = /^\/containers\/([^/]+)\/json$/.exec(path);
    if (m && req.method === 'GET') {
      res.end(JSON.stringify({ Name: `/${m[1]}`, Id: 'abcdef1234567890', Created: '2026-10-01', RestartCount: 2,
        Config: { Image: 'traefik:v3', Env: [`GITHUB_TOKEN=${GITHUB_TOKEN}`, 'PASSWORD=hunter2'], Labels: { 'com.docker.compose.project': 'edge', 'traefik.http.middlewares.auth.basicauth.users': 'admin:$apr1$x' } },
        State: { Status: 'running', Running: true, ExitCode: 0, StartedAt: 's', Health: { Status: 'healthy' } },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, NetworkSettings: { Networks: { edge: {} }, Ports: {} },
        Mounts: [{ Type: 'bind', Source: '/srv/edge', Destination: '/etc/traefik', RW: false }] }));
      return;
    }
    m = /^\/containers\/([^/]+)\/logs$/.exec(path);
    if (m) { res.end(Buffer.concat([frame(1, 'line one\n'), frame(2, `token ${GITHUB_TOKEN}\n`), frame(1, 'line three\n')])); return; }
    m = /^\/containers\/([^/]+)\/(restart|stop|start)$/.exec(path);
    if (m && req.method === 'POST') { res.statusCode = 204; res.end(); return; }
    res.statusCode = 404; res.end('{"message":"page not found"}');
  });
  await new Promise(r => server.listen(socketPath, r));
  t.after(() => server.close());
  return { socketPath, seen };
}

test('RR-13: ps, compose_ps, inspect without the environment, logs demultiplexed; unknown names refused before any call', async t => {
  const d = await fakeDocker(t);
  const act = createDockerActions({ request: socketRequest({ socketPath: d.socketPath }), now: () => 1_800_000_000_000 });
  const ps = await act({ action: 'ps' });
  assert.deepEqual(ps.untrusted_content.containers.map(c => [c.name, c.state, c.compose_project]),
    [['traefik', 'running', 'edge'], ['beszel', 'running', 'monitoring'], ['old-job', 'exited', null]]);
  assert.deepEqual(ps.untrusted_content.containers[0].ports, ['0.0.0.0:443->443/tcp']);
  const projects = await act({ action: 'compose_ps' });
  assert.deepEqual(projects.untrusted_content.projects, [{ name: 'edge', containers: 1, running: 1 }, { name: 'monitoring', containers: 1, running: 1 }]);
  assert.deepEqual((await act({ action: 'compose_ps', project: 'edge' })).untrusted_content.containers.map(c => c.service), ['traefik']);
  assert.equal((await act({ action: 'compose_ps', project: 'nope' })).error, 'project_not_found');
  const inspect = await act({ action: 'inspect', container: 'traefik' });
  const text = JSON.stringify(inspect);
  assert.doesNotMatch(text, /hunter2|GITHUB_TOKEN|ghp_|basicauth/, 'never the environment, never non-compose labels');
  assert.deepEqual([inspect.untrusted_content.inspect.restart_count, inspect.untrusted_content.inspect.state.health], [2, 'healthy']);
  const logs = await act({ action: 'logs', container: 'beszel', lines: 2, since: '-2h' });
  assert.deepEqual(logs.untrusted_content.lines, [`token ${GITHUB_TOKEN}`, 'line three'], 'stdout and stderr interleaved, last N lines');
  assert.ok(d.seen.some(r => /\/containers\/beszel\/logs\?stdout=1&stderr=1&tail=2&since=1799992800$/.test(r)), d.seen.join('\n'));
  const before = d.seen.length;
  assert.equal((await act({ action: 'restart', container: 'ghost' })).error, 'container_not_running_here');
  assert.deepEqual(d.seen.slice(before), [`GET ${DOCKER_API}/containers/json?all=1`], 'only the live list was read');
  assert.deepEqual(await act({ action: 'restart', container: 'beszel' }), { ok: true, host: 'vps', action: 'restart', container: 'beszel', changed: true });
  assert.ok(d.seen.includes(`POST ${DOCKER_API}/containers/beszel/restart?t=10`));
  assert.equal(demultiplex(Buffer.from('raw tty text\n')), 'raw tty text\n');
  // Unreachable daemon: a code, never a throw.
  assert.equal((await createDockerActions({ request: socketRequest({ socketPath: '/tmp/nope.sock' }) })({ action: 'ps' })).error, 'docker_unavailable');
});

test('RR-13: schema, tier and lock; no run, exec or pull action exists', () => {
  assert.equal(OPERATOR_SCHEMAS.operator_docker.safeParse({ host: 'vps', action: 'exec', container: 'x' }).success, false);
  assert.equal(OPERATOR_SCHEMAS.operator_docker.safeParse({ host: 'vps', action: 'restart', container: '-x' }).success, false, 'a name is never a flag');
  assert.equal(OPERATOR_SCHEMAS.operator_docker.safeParse({ host: 'vps', action: 'logs', container: 'beszel', since: '2h' }).success, true);
  assert.equal(operatorCallTier('operator_docker', { action: 'ps' }), 2);
  assert.deepEqual(operatorTargets('operator_docker', { host: 'vps', action: 'ps' }), []);
  assert.deepEqual(operatorTargets('operator_docker', { host: 'vps', action: 'restart', container: 'beszel' }).map(x => [x.kind, x.key]), [['container', 'beszel']]);
});

function helperHost(t, { docker, host = 'vps' } = {}) {
  const sockDir = realpathSync(mkdtempSync(join('/tmp', 'mop-')));
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));
  const h = makeHost(t, { host, policy: { max_tier: 'root', approval_mode: 'dangerous', root_helper: { socket: join(sockDir, 'root.sock') } } });
  const pair = signingPair({ host, clock: { t: Date.now() } });
  const verifier = createOperatorVerifier({ publicKeys: [pair.keys.publicKeyPem], host, now: () => pair.clock.t });
  const helper = createRootHelper({ policy: h.policy, verifier, guard: createOperatorGuard(h.policy, { autoFrozenFile: h.p('state/RAF') }),
    chain: createAuditChain({ store: fileAuditStore(h.p('state/root-audit.jsonl')) }), executor: async () => ({ code: 0, stdout: '', stderr: '' }),
    scriptDir: h.p('state/scripts'), jobs: createJobStore({ dir: h.p('state/rjobs'), prefix: 'rj' }), projects: async () => [], now: () => pair.clock.t,
    ...(docker ? { docker } : {}) });
  let n = 0;
  const sign = (op, args, { tier = operatorCallTier(op, args), approval = null } = {}) => {
    const id = `req_${String(++n).padStart(16, '0')}`;
    return { type: 'call', id, op, args, principal: 'oidc:owner', operator: pair.signer.sign({ id, op, host, tier, principal: 'oidc:owner', args, approval }) };
  };
  return { helper, sign };
}

test('RR-13 (helper): operator_docker runs at T2 in the helper; restarting traefik needs an approval; Mac refuses', async t => {
  const calls = [];
  const fake = async a => { calls.push(a); return { ok: true, host: 'vps', action: a.action }; };
  const r = helperHost(t, { docker: fake });
  assert.equal((await r.helper.handle(r.sign('operator_docker', { host: 'vps', action: 'restart', container: 'beszel' }))).ok, true);
  assert.equal((await r.helper.handle(r.sign('operator_docker', { host: 'vps', action: 'restart', container: 'traefik' }))).error, 'approval_required');
  assert.equal((await r.helper.handle(r.sign('operator_docker', { host: 'vps', action: 'restart', container: 'traefik' }, { approval: `ap_${'b'.repeat(24)}` }))).ok, true);
  assert.equal((await r.helper.handle(r.sign('operator_docker', { host: 'vps', action: 'ps' }, { tier: 3 }))).error, 'tier_mismatch');
  assert.deepEqual(calls.map(c => c.container ?? c.action), ['beszel', 'traefik']);
  const mac = helperHost(t, { host: 'mac' });
  assert.equal((await mac.helper.handle(mac.sign('operator_docker', { host: 'mac', action: 'ps' }))).error, 'docker_unavailable_on_host');
});

test('RR-7 (helper): a standing approval id is refused for anything the root helper runs', async t => {
  const r = helperHost(t, { docker: async () => ({ ok: true }) });
  const st = 'ap_st_AAAAAAAAAAAAAAAAAAAAAA';
  assert.equal((await r.helper.handle(r.sign('operator_run', { host: 'vps', argv: ['id'], as_root: true }, { approval: st }))).error, 'approval_scope');
  assert.equal((await r.helper.handle(r.sign('operator_script', { host: 'vps', interpreter: 'bash', content: 'id', as_root: true }, { approval: st }))).error, 'approval_scope');
  assert.equal((await r.helper.handle(r.sign('operator_docker', { host: 'vps', action: 'restart', container: 'traefik' }, { approval: st }))).error, 'approval_scope');
  // Root scripts keep bash and python3 only.
  assert.equal((await r.helper.handle(r.sign('operator_script', { host: 'vps', interpreter: 'node', content: '1', as_root: true }, { approval: `ap_${'c'.repeat(24)}` }))).error,
    'interpreter_unavailable_as_root');
});
