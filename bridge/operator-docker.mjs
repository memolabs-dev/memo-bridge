// operator_docker (repatriation spec D-R11): Docker on lab without putting memo-operator in the
// docker group, the way SentinelX's local_api does it. Runs inside the root helper (root reaches
// /var/run/docker.sock), with declared actions only, over the Docker Engine API (no CLI, no shell):
//   ps          GET  /containers/json?all=1                      projected: name, image, state, status, ports, compose project
//   inspect     GET  /containers/{name}/json                     projected; never Config.Env, never non-compose labels
//   logs        GET  /containers/{name}/logs?stdout=1&stderr=1&tail=N[&since=t]  demultiplexed, redacted by the helper
//   compose_ps  GET  /containers/json?all=1 grouped by the label com.docker.compose.project
//   restart, stop, start  POST /containers/{name}/{action}[?t=10]
// The container must be in the live list (GET /containers/json?all=1) by its exact name; a compose
// project must appear in the live labels. No run, exec, pull, rm: those stay operator_run as_root
// ["docker", ...], T3 plus approval, and docker rm/prune are on the hard list.
// Source: Docker Engine API v1.56 (docs.docker.com/reference/api/engine/version/v1.56.yaml, read
// 2026-10-14): a version-prefixed path locks the API version ("/v1.30/info"); the daemon on lab
// answers MinAPIVersion 1.40 and APIVersion 1.56 (docker version, read 2026-10-14). Logs of a
// container without a TTY are multiplexed: frames of an 8-byte header
// [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4] (big-endian uint32 size) and the payload.
import { request as httpRequest } from 'node:http';
import { untrusted } from './operator-output.mjs';

export const DOCKER_API = '/v1.44';
export const DOCKER_SOCKET = '/var/run/docker.sock';
const MAX_BODY = 8 * 1024 * 1024;
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// One request to the Engine API over its Unix socket. Resolves {status, body: Buffer} or {error}.
export function socketRequest({ socketPath = DOCKER_SOCKET, timeoutMs = 60_000 } = {}) {
  return (method, path) => new Promise(resolve => {
    const req = httpRequest({ socketPath, method, path, headers: { host: 'docker' }, timeout: timeoutMs }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), truncated: size > MAX_BODY }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'docker_timeout' }); });
    req.on('error', () => resolve({ error: 'docker_unavailable' }));
    req.end();
  });
}

// Split a multiplexed log body into text (stdout and stderr interleaved, in order).
export function demultiplex(buf) {
  let out = ''; let at = 0;
  while (at + 8 <= buf.length) {
    const type = buf[at];
    const size = buf.readUInt32BE(at + 4);
    if (type > 2 || buf[at + 1] !== 0 || buf[at + 2] !== 0 || buf[at + 3] !== 0) return buf.toString('utf8'); // not framed: a TTY container
    out += buf.subarray(at + 8, at + 8 + size).toString('utf8');
    at += 8 + size;
  }
  return out;
}

const nameOf = c => String((c.Names ?? [])[0] ?? '').replace(/^\//, '');
const COMPOSE = 'com.docker.compose.project';
const portsOf = c => (c.Ports ?? []).slice(0, 32).map(p => `${p.IP ? `${p.IP}:` : ''}${p.PublicPort ?? ''}${p.PublicPort ? '->' : ''}${p.PrivatePort}/${p.Type}`);

// since: "-2h", "30m", "90s" -> Unix seconds.
const sinceSeconds = (since, now) => {
  const m = /^-?(\d{1,5})(s|m|h)$/.exec(since);
  return m ? Math.floor(now() / 1000) - Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : null;
};

export function createDockerActions({ request = socketRequest(), now = Date.now, host = 'vps' } = {}) {
  async function json(method, path) {
    const r = await request(method, `${DOCKER_API}${path}`);
    if (r.error) return fail(r.error);
    if (r.status === 404) return fail('container_not_found');
    if (r.status >= 400) return fail('docker_error', { status: r.status });
    if (r.status === 204 || r.status === 304 || r.body.length === 0) return { ok: true, value: null, status: r.status };
    try { return { ok: true, value: JSON.parse(r.body.toString('utf8')), status: r.status }; } catch { return fail('docker_bad_response'); }
  }
  async function live() {
    const r = await json('GET', '/containers/json?all=1');
    return r.ok ? { ok: true, list: Array.isArray(r.value) ? r.value : [] } : r;
  }
  // The live container with exactly this name, or a refusal.
  async function known(name) {
    const l = await live();
    if (!l.ok) return l;
    const c = l.list.find(x => nameOf(x) === name);
    return c ? { ok: true, container: c } : fail('container_not_running_here', { detail: 'not in the live list: operator_docker action ps' });
  }

  return async function dockerAction(a) {
    const base = { ok: true, host, action: a.action };
    switch (a.action) {
      case 'ps': {
        const l = await live();
        if (!l.ok) return l;
        const containers = l.list.slice(0, 300).map(c => ({ name: nameOf(c), image: c.Image, state: c.State, status: c.Status, ports: portsOf(c),
          compose_project: c.Labels?.[COMPOSE] ?? null }));
        return { ...base, count: containers.length, ...untrusted({ containers }) };
      }
      case 'compose_ps': {
        const l = await live();
        if (!l.ok) return l;
        const projects = new Map();
        for (const c of l.list) {
          const p = c.Labels?.[COMPOSE];
          if (!p) continue;
          projects.set(p, [...(projects.get(p) ?? []), { name: nameOf(c), service: c.Labels?.['com.docker.compose.service'] ?? null, state: c.State, status: c.Status }]);
        }
        if (a.project === undefined) {
          return { ...base, ...untrusted({ projects: [...projects].map(([name, cs]) => ({ name, containers: cs.length, running: cs.filter(c => c.state === 'running').length })) }) };
        }
        if (!projects.has(a.project)) return fail('project_not_found');
        return { ...base, project: a.project, ...untrusted({ containers: projects.get(a.project) }) };
      }
      case 'inspect': case 'logs': case 'restart': case 'stop': case 'start': {
        if (typeof a.container !== 'string') return fail('invalid_arguments', { detail: 'container' });
        const k = await known(a.container);
        if (!k.ok) return k;
        const id = encodeURIComponent(a.container);
        if (a.action === 'inspect') {
          const r = await json('GET', `/containers/${id}/json`);
          if (!r.ok) return r;
          const v = r.value ?? {};
          const labels = Object.fromEntries(Object.entries(v.Config?.Labels ?? {}).filter(([key]) => key.startsWith('com.docker.compose.')));
          const inspect = { name: String(v.Name ?? '').replace(/^\//, ''), id: String(v.Id ?? '').slice(0, 12), image: v.Config?.Image ?? null,
            created: v.Created ?? null, state: v.State ? { status: v.State.Status, running: v.State.Running, restarting: v.State.Restarting,
              exit_code: v.State.ExitCode, started_at: v.State.StartedAt, finished_at: v.State.FinishedAt, health: v.State.Health?.Status ?? null,
              oom_killed: v.State.OOMKilled } : null,
            restart_count: v.RestartCount ?? null, restart_policy: v.HostConfig?.RestartPolicy?.Name ?? null,
            networks: Object.keys(v.NetworkSettings?.Networks ?? {}), ports: v.NetworkSettings?.Ports ?? null,
            mounts: (v.Mounts ?? []).slice(0, 64).map(m => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW })),
            compose_labels: labels };
          return { ...base, container: a.container, ...untrusted({ inspect }) };
        }
        if (a.action === 'logs') {
          const lines = a.lines ?? 200;
          const since = a.since ? sinceSeconds(a.since, now) : null;
          const r = await request('GET', `${DOCKER_API}/containers/${id}/logs?stdout=1&stderr=1&tail=${lines}${since !== null ? `&since=${since}` : ''}`);
          if (r.error) return fail(r.error);
          if (r.status >= 400) return fail('docker_error', { status: r.status });
          const text = demultiplex(r.body);
          return { ...base, container: a.container, truncated: r.truncated === true, ...untrusted({ lines: text.split('\n').filter(Boolean).slice(-lines) }) };
        }
        const r = await json('POST', `/containers/${id}/${a.action}${a.action === 'start' ? '' : '?t=10'}`);
        if (!r.ok) return r;
        return { ...base, container: a.container, changed: r.status !== 304 };
      }
      default: return fail('invalid_arguments');
    }
  };
}
