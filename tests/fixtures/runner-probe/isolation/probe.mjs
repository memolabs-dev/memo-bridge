// Isolation probe for memo-job@<id>.service (Phase 4, AC-P4-12). TEST-ONLY FIXTURE.
//
// This file is the `test` script of a throwaway fixture repository (see ../README.md). Run as
// the recipe `npm test` inside a job unit on the VPS, it tries what a job must NOT be able to
// do and a few things it must be able to do, and prints one JSON line per check:
//
//   {"check":"tcp_loopback_9443","expect":"deny","outcome":"pass","detail":"EPERM"}
//
// outcome is `pass` (the expectation holds), `fail` (it does not) or `inconclusive` (the
// result does not prove the policy, e.g. a timeout instead of the EPERM that IPAddressDeny=
// gives). The exit status is 0 only when every check passes.
//
// It never prints file contents, environment values or anything it read: only check names,
// outcomes and error codes. Files it manages to create are removed at once. Nothing here
// sends data anywhere: network checks open a TCP connection and close it immediately.
//
// `node probe.mjs --plan` prints the checks without running any of them.
import { connect } from 'node:net';
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECT_TIMEOUT_MS = 4000;
const DENIED_NET = new Set(['EPERM', 'EACCES']);
const DENIED_FS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR']);
const FORBIDDEN_GROUPS = new Set(['root', 'sudo', 'wheel', 'adm', 'docker', 'lxd', 'disk', 'shadow',
  'systemd-journal', 'memo-runner', 'memo-bridge']);
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH)/i;
const SECRET_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'NPM_TOKEN',
  'CREDENTIALS_DIRECTORY', 'SSH_AUTH_SOCK', 'DATABASE_URL', 'GIT_ASKPASS']);

// What AC-P4-12 lists, plus the other paths of the InaccessiblePaths= list of spec §3.
export function plan(cwd = process.cwd(), env = process.env) {
  const checks = [];
  for (const port of [4000, 5000, 9443, 4096]) {
    checks.push({ check: `tcp_loopback_${port}`, kind: 'tcp', host: '127.0.0.1', port, expect: 'deny' });
  }
  checks.push({ check: 'tcp_loopback6_9443', kind: 'tcp', host: '::1', port: 9443, expect: 'deny' });
  checks.push({ check: 'tcp_private_10.0.4.1', kind: 'tcp', host: '10.0.4.1', port: 80, expect: 'deny' });
  checks.push({ check: 'tcp_private_172.17.0.1', kind: 'tcp', host: '172.17.0.1', port: 80, expect: 'deny' });
  for (const path of ['/run/docker.sock', '/var/run/docker.sock']) {
    checks.push({ check: `unix${path.replaceAll('/', '_')}`, kind: 'unix', path, expect: 'deny' });
  }
  for (const path of ['/var/lib/memo-bridge', '/etc/credstore', '/etc/github.env',
    '/var/lib/memo-runner/state', '/var/lib/memo-runner/spool', '/var/lib/memo-runner/governance',
    '/opt/memo-bridge-auth', '/opt/stacks', '/opt/data', '/opt/imports', '/var/backups/lab', '/root']) {
    checks.push({ check: `read${path.replaceAll('/', '_')}`, kind: 'read', path, expect: 'deny' });
  }
  for (const dir of ['/etc', '/opt', '/usr/local', '/var/lib/memo-runner', '/var/lib/memo-runner/jobs', '/home']) {
    checks.push({ check: `write${dir.replaceAll('/', '_')}`, kind: 'write', dir, expect: 'deny' });
  }
  checks.push({ check: 'write_worktree_parent', kind: 'write', dir: dirname(cwd), expect: 'deny' });
  checks.push({ check: 'write_worktree', kind: 'write', dir: cwd, expect: 'allow' });
  if (env.MEMO_JOB_OUT) checks.push({ check: 'write_job_out', kind: 'write', dir: env.MEMO_JOB_OUT, expect: 'allow' });
  checks.push({ check: 'tcp_github.com_443', kind: 'tcp', host: 'github.com', port: 443, expect: 'allow' });
  checks.push({ check: 'tcp_registry.npmjs.org_443', kind: 'tcp', host: 'registry.npmjs.org', port: 443, expect: 'allow' });
  checks.push({ check: 'env_no_secrets', kind: 'env', expect: 'deny' });
  checks.push({ check: 'groups_unprivileged', kind: 'groups', expect: 'deny' });
  checks.push({ check: 'no_new_privileges', kind: 'privileges', expect: 'deny' });
  return checks;
}

const result = (check, outcome, detail) => ({ check: check.check, expect: check.expect, outcome, detail });

function tcp(check) {
  return new Promise(resolve => {
    const socket = connect({ host: check.host, port: check.port });
    const done = (outcome, detail) => { socket.destroy(); clearTimeout(timer); resolve(result(check, outcome, detail)); };
    const timer = setTimeout(() => done(check.expect === 'deny' ? 'inconclusive' : 'fail', 'timeout'), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => done(check.expect === 'allow' ? 'pass' : 'fail', 'connected'));
    socket.once('error', error => {
      const code = String(error?.code ?? 'error');
      if (check.expect === 'allow') return done('fail', code);
      // Only EPERM/EACCES proves the cgroup filter; ECONNREFUSED means the packet got through.
      if (DENIED_NET.has(code)) return done('pass', code);
      if (code === 'ECONNREFUSED') return done('fail', code);
      return done('inconclusive', code);
    });
  });
}

function unix(check) {
  return new Promise(resolve => {
    const socket = connect({ path: check.path });
    const done = (outcome, detail) => { socket.destroy(); clearTimeout(timer); resolve(result(check, outcome, detail)); };
    const timer = setTimeout(() => done('inconclusive', 'timeout'), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => done('fail', 'connected'));
    socket.once('error', error => {
      const code = String(error?.code ?? 'error');
      done(DENIED_FS.has(code) ? 'pass' : 'fail', code);
    });
  });
}

// Reading one byte (or one directory entry) is enough; nothing read is kept or printed.
function read(check) {
  try {
    const info = statSync(check.path);
    if (info.isDirectory()) {
      readdirSync(check.path);
    } else {
      const fd = openSync(check.path, 'r');
      try { readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { closeSync(fd); }
    }
    return result(check, 'fail', 'readable');
  } catch (error) {
    const code = String(error?.code ?? 'error');
    return result(check, DENIED_FS.has(code) ? 'pass' : 'inconclusive', code);
  }
}

function write(check) {
  const path = join(check.dir, `.memo-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, 'probe\n'); } finally { closeSync(fd); }
    try { unlinkSync(path); } catch { /* reported below */ }
    return result(check, check.expect === 'allow' ? 'pass' : 'fail', 'written');
  } catch (error) {
    const code = String(error?.code ?? 'error');
    if (check.expect === 'allow') return result(check, 'fail', code);
    return result(check, DENIED_FS.has(code) ? 'pass' : 'inconclusive', code);
  }
}

function envCheck(check, env) {
  const names = Object.keys(env).filter(name => SECRET_NAMES.has(name) || SECRET_NAME_RE.test(name)).sort();
  return result(check, names.length === 0 ? 'pass' : 'fail', names.length === 0 ? 'none' : `names:${names.join(',')}`);
}

function procStatus() {
  try { return readFileSync('/proc/self/status', 'utf8'); } catch { return null; }
}

function groupsCheck(check) {
  const status = procStatus();
  if (status === null) return result(check, 'inconclusive', 'no_proc');
  const field = name => (status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const uid = Number(field('Uid')[1] ?? field('Uid')[0]);
  const gids = new Set([...field('Gid').slice(0, 2), ...field('Groups')].map(Number));
  const names = new Map();
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , gid] = line.split(':');
      if (name && gid !== undefined) names.set(Number(gid), name);
    }
  } catch { /* gids only */ }
  const found = [...gids].map(gid => names.get(gid) ?? String(gid));
  const bad = found.filter(name => FORBIDDEN_GROUPS.has(name) || name === '0');
  if (uid === 0) return result(check, 'fail', 'uid_0');
  return result(check, bad.length === 0 ? 'pass' : 'fail', `uid:${uid} groups:${found.join(',')}`);
}

function privilegesCheck(check) {
  const status = procStatus();
  if (status === null) return result(check, 'inconclusive', 'no_proc');
  const nnp = status.match(/^NoNewPrivs:\s*(\d+)/m)?.[1];
  const capEff = status.match(/^CapEff:\s*([0-9a-f]+)/m)?.[1];
  const ok = nnp === '1' && capEff !== undefined && /^0+$/.test(capEff);
  return result(check, ok ? 'pass' : 'fail', `NoNewPrivs:${nnp ?? '?'} CapEff:${capEff ?? '?'}`);
}

export async function run(checks, env = process.env) {
  const results = [];
  for (const check of checks) {
    switch (check.kind) {
      case 'tcp': results.push(await tcp(check)); break;
      case 'unix': results.push(await unix(check)); break;
      case 'read': results.push(read(check)); break;
      case 'write': results.push(write(check)); break;
      case 'env': results.push(envCheck(check, env)); break;
      case 'groups': results.push(groupsCheck(check)); break;
      case 'privileges': results.push(privilegesCheck(check)); break;
      default: results.push(result(check, 'fail', 'unknown_kind'));
    }
  }
  return results;
}

async function main(args) {
  const checks = plan();
  if (args.includes('--plan')) {
    process.stdout.write(`${JSON.stringify({ plan: checks.map(({ check, kind, expect }) => ({ check, kind, expect })) })}\n`);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write('usage: node probe.mjs [--plan]\n');
    return 2;
  }
  const results = await run(checks);
  for (const line of results) process.stdout.write(`${JSON.stringify(line)}\n`);
  const count = outcome => results.filter(line => line.outcome === outcome).length;
  const summary = { pass: count('pass'), fail: count('fail'), inconclusive: count('inconclusive'),
    job_id: /^job_[A-Za-z0-9_-]{16}$/.test(process.env.MEMO_JOB_ID ?? '') ? process.env.MEMO_JOB_ID : null };
  const ok = summary.fail === 0 && summary.inconclusive === 0;
  process.stdout.write(`${JSON.stringify({ summary, ok })}\n`);
  return ok ? 0 : 1;
}

// Run only when executed directly, so the deploy tests can import plan() and run().
function isMain() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
