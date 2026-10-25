// Root helper (Phase 6, TODO-P6-10, spec D3, D4, D7): on lab, and on the Mac since the owner's
// decision of 2026-10-14 (spec §13, Mac root follow-up, DEV-P6-32 to 39).
//
// The host comes from the helper's own policy (policy.host). On lab each call runs in a transient
// systemd unit (below). On the Mac there is no systemd: each call is spawned in its own process
// group (runArgvGroup), the whole group is killed at the timeout and once the program exits, and
// the environment is a fixed system PATH (never /opt/homebrew or /usr/local, which the owner's
// user can rewrite). The Mac entry point is bridge/operator-root-mac.mjs.
//
// A small root process (memo-operator-root.service, lab-infra) listening on a Unix socket in a
// directory only root and the memo-operator group can reach (policy root_helper.socket, for
// example /run/memo-operator/root.sock). It never trusts the agent for authority: every call
// carries the hub's Ed25519 operator signature, which the helper verifies itself with its own
// nonce cache (operator-signing.mjs), then checks its own copy of the policy (max_tier root,
// FROZEN, rate limit, approval required by approval_mode), exactly like the agent does.
//
// Repatriation D-R11: operator_docker (lab only) runs here too, over the Engine API socket
// (bridge/operator-docker.mjs), at T2 (operator:exec).
// What it runs: operator_run with as_root and operator_script (bash or python3, at most 64 KiB),
// each in a transient systemd service started by systemd-run(1), argv only:
//   systemd-run --quiet --collect --wait --pipe --unit=memo-op-<id> --description=...
//     --property=RuntimeMaxSec=<timeout> --property=MemoryMax=<limit> --property=TasksMax=<n>
//     --working-directory=<cwd> --setenv=NAME=value ... -- <argv>
// Sources (man7.org, systemd 262~devel pages, read 2026-10-14; lab runs systemd 257, U-P6-03):
//  - systemd-run(1): --wait "Synchronously wait for the transient service to terminate";
//    --pipe: "standard input, output, and error of the transient service are inherited from the
//    systemd-run command itself"; --collect: "Unload the transient unit after it completed, even
//    if it failed"; with --wait "the return value will be propagated from the service";
//    --property sets a unit property; --working-directory, --setenv, --unit as named.
//  - systemd.service(5): RuntimeMaxSec= sets "a maximum time for the service to run", after which
//    it is "terminated and put into a failure state".
//  - systemd.resource-control(5): MemoryMax= is "the absolute limit on memory usage of the
//    executed processes in this unit"; TasksMax= "the maximum number of tasks".
// The executor is injectable: tests assert the argv and never call systemd. The real behaviour
// on lab (unit gone after the call, limits applied) is a runtime check, AC-P6-09, pending.
//
// It also owns the host journal (operator-audit.mjs): the agent appends through this socket and
// cannot rewrite the file (root, 0600). The agent forwards the hub's 15-minute anchoring request
// (audit_head) here.
//
// Wire: one JSON object per connection, newline-terminated, answered by one JSON line. At most
// 512 KiB per request.
import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorCallTier } from '../server/coordinator/policy.mjs';
import { isGrantApproval, needsApproval } from './operator-dangerous.mjs';
import { checkCwd, checkRun } from './operator-exec.mjs';
import { createDenylist } from './operator-paths.mjs';
import { controlRefusal } from './operator-authority.mjs';
import { finalizeResult, untrusted } from './operator-output.mjs';
import { argsSha256 } from './operator-signing.mjs';
import { createDockerActions } from './operator-docker.mjs';
import { LIMITS, runArgv, SAFE_ENV } from './operator-tools.mjs';

export const ROOT_LIMITS = Object.freeze({ memoryMax: '2G', tasksMax: 512, requestBytes: 512 * 1024, marginS: 15 });
const ROOT_OPS = new Set(['operator_run', 'operator_script', 'operator_job_status', 'operator_docker']);
const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOMES = new Set(['ok', 'denied', 'error']);
const INTERPRETERS = Object.freeze({ bash: { program: '/bin/bash', ext: 'sh' }, python3: { program: '/usr/bin/python3', ext: 'py' } });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
// The Mac root environment: system directories only, so a bare program name never resolves into
// a directory the owner's user can write (/opt/homebrew/bin, /usr/local/bin).
export const MAC_ROOT_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: '/var/root' });

// One argv in its own process group (Mac root calls, DEV-P6-32). spawn with detached: true calls
// setsid(2), so the child leads a new group; at the timeout, and again when the program exits,
// the whole group gets SIGKILL: a grandchild cannot outlive the call by staying in the group.
// Same result shape as runArgv. A program that leaves its group on purpose (setsid, launchctl)
// is out of reach: macOS has no cgroup.
export function runArgvGroup(argv, { timeoutMs = LIMITS.commandTimeoutMs, maxBytes = LIMITS.commandMaxBytes, env = MAC_ROOT_ENV, cwd,
  kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env },
        ...(cwd ? { cwd } : {}) });
    } catch { resolve({ code: null, error: 'spawn_failed', stdout: '', stderr: '', timedOut: false, truncated: false }); return; }
    const out = []; const err = []; let size = 0; let truncated = false; let timedOut = false;
    const take = (chunks, chunk) => {
      if (size >= maxBytes) { truncated = true; return; }
      const room = maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      if (chunk.length > room) truncated = true;
      size += Math.min(chunk.length, room);
    };
    const killGroup = () => { if (child.pid) { try { kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } } };
    child.stdout.on('data', c => take(out, c));
    child.stderr.on('data', c => take(err, c));
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    // The leader exited: whatever it left in its group goes too, so the pipes close.
    child.on('exit', () => { clearTimeout(timer); killGroup(); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, error: 'spawn_failed', stdout: '', stderr: '', timedOut, truncated }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated });
    });
  });
}

// The systemd-run argv of one root call. Pure; every caller value fills one argv slot.
export function systemdRunArgv({ unit, description, argv, cwd = '/', env = {}, timeoutS, memoryMax = ROOT_LIMITS.memoryMax,
  tasksMax = ROOT_LIMITS.tasksMax }) {
  return ['systemd-run', '--quiet', '--collect', '--wait', '--pipe', `--unit=${unit}`, `--description=${description}`,
    `--property=RuntimeMaxSec=${timeoutS}s`, `--property=MemoryMax=${memoryMax}`, `--property=TasksMax=${tasksMax}`,
    `--working-directory=${cwd}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), '--', ...argv];
}

// policy, verifier (createOperatorVerifier with the hub key), guard (createOperatorGuard with
// the helper's own marker), chain (createAuditChain over the root-owned file), jobs
// (createJobStore prefix 'rj'), executor (argv runner: runArgv on lab through systemd-run,
// runArgvGroup on the Mac; tests inject a recorder).
// authority: loadPolicyAuthority(...) of the helper's own policy copy (issue #290), checked before
// every call; null in tests only, the CLI always passes one.
export function createRootHelper({ policy, verifier, guard, chain, jobs = null, executor, scriptDir,
  now = Date.now, random = randomBytes, log = () => {}, authority = null,
  docker = policy?.host === 'vps' ? createDockerActions({ now }) : null }) {
  if (!policy || !verifier || !guard || !chain || !scriptDir) throw new Error('root helper needs policy, verifier, guard, chain, scriptDir');
  if (policy.maxTierName !== 'root' || !policy.rootHelper) throw new Error('root helper needs a policy with max_tier root and root_helper');
  const host = policy.host;
  const systemd = host === 'vps';
  const run = executor ?? (systemd ? runArgv : runArgvGroup);
  const denylist = createDenylist(policy);

  const journal = (fields, out) => chain.append({ ...fields, source: 'root-helper', output: out });

  async function call(msg) {
    const started = now();
    const { id, op, args = {}, operator } = msg;
    const principal = typeof msg.principal === 'string' ? msg.principal : null;
    const tier = operatorCallTier(op, args);
    const base = { request_id: msg.request_id ?? id ?? null, ref: typeof args?.ref === 'string' ? args.ref.slice(0, 128) : null, op, tier,
      principal, args, args_sha256: argsSha256(args) };
    const refuse = (code, extra = {}, { counted = true } = {}) => {
      if (counted) guard.refused(code);
      const out = fail(code, extra);
      journal({ ...base, outcome: 'denied', code, ms: now() - started }, out);
      log('root_refused', { op, code });
      return out;
    };
    if (!ROOT_OPS.has(op)) return refuse('unsupported_op');
    const signed = verifier.verify(operator, { id, op, args, principal });
    if (!signed.ok) return refuse(signed.error);
    if (signed.tier !== tier) return refuse('tier_mismatch');
    // T3 only, but for root job status and Docker (T2, repatriation D-R11).
    if (!['operator_job_status', 'operator_docker'].includes(op) && tier !== 3) return refuse('tier_mismatch');
    if (tier > policy.maxTier) return refuse('tier_not_allowed');
    // Its own policy file, read again: the agent's check is not taken on trust (#290).
    const lost = authority ? authority.check() : null;
    if (lost) return refuse(lost.error, { reason: lost.reason });
    const admitted = guard.admit(tier);
    if (admitted) return refuse(admitted);
    if (needsApproval(policy.approvalMode, op, args, tier) && !signed.approval) return refuse('approval_required');
    // Standing and permanent grants cover user runs only, never what reaches the root helper (D-R5, #48).
    if (isGrantApproval(signed.approval)) return refuse('approval_scope');
    const parsed = OPERATOR_SCHEMAS[op].safeParse(args);
    if (!parsed.success || parsed.data.host !== host) return refuse('invalid_arguments');
    const a = parsed.data;
    if (op === 'operator_run' || op === 'operator_script') {
      const named = await controlRefusal(denylist, policy, { argv: op === 'operator_run' ? a.argv : (a.args ?? []), cwd: a.cwd ?? '/',
        content: op === 'operator_script' ? a.content : null });
      if (named) return refuse(named.error, {}, { counted: false });
    }

    let data;
    try { data = await execute(op, a, { id, principal }); } catch { data = fail('internal_error'); }
    const { data: out } = finalizeResult(base.ref !== null ? { ...data, ref: base.ref } : data);
    journal({ ...base, approval: signed.approval, outcome: data.ok === false ? 'denied' : 'ok', code: data.ok === false ? data.error : null,
      ms: now() - started }, out);
    return out;
  }

  async function execute(op, a, { principal }) {
    if (op === 'operator_docker') {
      if (!systemd || !docker) return fail('docker_unavailable_on_host');
      return docker(a);
    }
    if (op === 'operator_job_status') {
      if (!jobs) return fail('unknown_job');
      const s = await jobs.status(a.job_id);
      if (!s.ok) return s;
      const { stdout, stderr, ...rest } = s;
      return { ...rest, host, as_root: true, ...(s.status === 'done' ? untrusted({ stdout, stderr }) : {}) };
    }
    let program;
    let script = null;
    if (op === 'operator_script') {
      const interp = INTERPRETERS[a.interpreter];
      if (!interp) return fail('interpreter_unavailable_as_root', { detail: 'root scripts: bash or python3' });
      await mkdir(scriptDir, { recursive: true, mode: 0o700 });
      script = join(scriptDir, `${random(12).toString('hex')}.${interp.ext}`);
      await writeFile(script, a.content, { mode: 0o700, flag: 'wx' });
      program = [interp.program, script, ...(a.args ?? [])];
    }
    const checked = checkRun(op === 'operator_script' ? { argv: program, timeout_s: a.timeout_s, background: a.background } : a, policy,
      { baseEnv: systemd ? {} : MAC_ROOT_ENV });
    if (!checked.ok) { if (script) await unlink(script).catch(() => {}); return checked; }
    const cwd = await checkCwd(policy, a.cwd, { denylist });
    if (!cwd.ok) { if (script) await unlink(script).catch(() => {}); return cwd; }
    if (!systemd) return executeDirect(op, checked, cwd.path, script);
    const unit = `memo-op-${random(6).toString('hex')}`;
    const argv = systemdRunArgv({ unit, description: `memo-operator ${op} for ${principal ?? 'unknown'}`, argv: checked.argv, cwd: cwd.path,
      env: checked.env, timeoutS: checked.timeoutS });
    if (checked.background) {
      if (!jobs) return fail('background_unavailable');
      const { job_id: jobId } = await jobs.start({ op, argv, cwd: '/', env: { ...SAFE_ENV }, timeout_s: checked.timeoutS + ROOT_LIMITS.marginS });
      return { ok: true, host, as_root: true, status: 'running', job_id: jobId, unit };
    }
    const started = now();
    try {
      const r = await run(argv, { env: { ...SAFE_ENV }, timeoutMs: (checked.timeoutS + ROOT_LIMITS.marginS) * 1000 });
      if (r.code === null && !r.timedOut) return fail('systemd_run_unavailable');
      return { ok: true, host, as_root: true, unit, exit_code: r.code, timed_out: r.timedOut === true, output_capped: r.truncated === true,
        duration_ms: now() - started, ...untrusted({ stdout: r.stdout, stderr: r.stderr }) };
    } finally { if (script) await unlink(script).catch(() => {}); }
  }

  // The Mac: the argv itself, in its own process group, with the fixed root environment.
  async function executeDirect(op, checked, cwd, script) {
    if (checked.background) {
      if (!jobs) { if (script) await unlink(script).catch(() => {}); return fail('background_unavailable'); }
      // The script stays until a cleanup (as on lab, DEV-P6-22); the supervisor kills the group.
      const { job_id: jobId } = await jobs.start({ op, argv: checked.argv, cwd, env: checked.env, timeout_s: checked.timeoutS, process_group: true });
      return { ok: true, host, as_root: true, status: 'running', job_id: jobId };
    }
    const started = now();
    try {
      const r = await run(checked.argv, { cwd, env: checked.env, timeoutMs: checked.timeoutS * 1000 });
      if (r.code === null && !r.timedOut && r.error === 'spawn_failed') return fail('program_not_found');
      return { ok: true, host, as_root: true, exit_code: r.code, signal: r.signal ?? null, timed_out: r.timedOut === true,
        output_capped: r.truncated === true, duration_ms: now() - started, ...untrusted({ stdout: r.stdout, stderr: r.stderr }) };
    } finally { if (script) await unlink(script).catch(() => {}); }
  }

  // Lines the agent reports: shape-checked fields only; the helper computes the chain.
  function appendFromAgent(fields) {
    if (!fields || typeof fields !== 'object' || !OP_RE.test(String(fields.op)) || !OUTCOMES.has(fields.outcome)) return fail('invalid_request');
    const pick = ['request_id', 'ref', 'op', 'tier', 'principal', 'args', 'args_sha256', 'approval', 'outcome', 'code', 'ms', 'output'];
    const clean = Object.fromEntries(pick.filter(k => fields[k] !== undefined).map(k => [k, fields[k]]));
    const { seq, hash } = chain.append({ ...clean, source: 'agent' });
    return { ok: true, seq, hash };
  }

  async function ownerUnfreeze(msg) {
    const args = msg.args ?? {};
    const signed = verifier.verify(msg.operator, { id: msg.id, op: 'operator_owner_unfreeze', args, principal: msg.principal });
    if (!signed.ok || msg.op !== 'operator_owner_unfreeze') { guard.refused(signed.ok ? 'request_mismatch' : signed.error); return fail(signed.ok ? 'request_mismatch' : signed.error); }
    const cleared = guard.clearAuto();
    chain.append({ op: 'operator_owner_unfreeze', tier: 0, principal: msg.principal ?? null, args, outcome: 'ok', source: 'root-helper' });
    return { ok: true, cleared };
  }

  return Object.freeze({
    async handle(msg) {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('invalid_request');
      try {
        switch (msg.type) {
          case 'call': return await call(msg);
          // On the Mac the agent keeps its own journal (DEV-P6-36): the root chain takes no line from
          // the socket, so the user that may connect cannot pad it either.
          case 'audit_append': return systemd ? appendFromAgent(msg.fields) : fail('invalid_request');
          case 'audit_verify': return { ok: true, verify: chain.verify() };
          case 'audit_head': return { ok: true, head: chain.headInfo(Number.isInteger(msg.since_seq) ? msg.since_seq : null) };
          case 'owner_unfreeze': return await ownerUnfreeze(msg);
          case 'status': return { ok: true, frozen: guard.status() };
          default: return fail('invalid_request');
        }
      } catch {
        log('root_helper_error', { type: String(msg.type).slice(0, 32) });
        return fail('internal_error');
      }
    }
  });
}

// The socket server. On lab the socket file is created 0660 and the directory's owner and mode
// (root:memo-operator 0750, lab-infra RuntimeDirectory=) decide who can connect at all. On the
// Mac (DEV-P6-34) the socket is handed to the agent user (owner {uid, gid}) with mode 0600: macOS
// checks the socket file's write permission on connect(2), so only that user and root connect.
export function createRootHelperServer({ helper, socketPath, mode = 0o660, owner = null, log = () => {} }) {
  const server = createServer(socket => {
    let buf = Buffer.alloc(0);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > ROOT_LIMITS.requestBytes) { socket.end(`${JSON.stringify(fail('request_too_large'))}\n`); socket.destroy(); return; }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { socket.end(`${JSON.stringify(fail('invalid_request'))}\n`); return; }
      socket.setTimeout(0);
      helper.handle(msg).then(out => socket.end(`${JSON.stringify(out)}\n`), () => socket.end(`${JSON.stringify(fail('internal_error'))}\n`));
    });
    socket.on('error', () => {});
  });
  return {
    async start() {
      await unlink(socketPath).catch(() => {});
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      if (owner) await chown(socketPath, owner.uid, owner.gid);
      await chmod(socketPath, mode);
      log('root_helper_listening', {});
    },
    stop: () => new Promise(resolve => server.close(() => resolve()))
  };
}

// The agent's client: one request per connection. Resolves with the answer or
// {ok:false, error:'root_helper_unavailable'}. With checkSocket (the Mac, where the helper is
// optional), available() says whether the socket exists right now; the agent forwards root calls
// only then and answers root_unavailable_on_host otherwise.
export function createRootHelperClient({ socketPath, timeoutMs = 700_000, checkSocket = false }) {
  return Object.freeze({
    ...(checkSocket ? { available() { try { return lstatSync(socketPath).isSocket(); } catch { return false; } } } : {}),
    request(msg) {
      return new Promise(resolve => {
        const socket = connect(socketPath);
        let buf = '';
        let settled = false;
        const done = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
        const timer = setTimeout(() => done(fail('root_helper_timeout')), timeoutMs);
        socket.on('connect', () => socket.write(`${JSON.stringify(msg)}\n`));
        socket.on('data', chunk => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          clearTimeout(timer);
          try { done(JSON.parse(buf.slice(0, nl))); } catch { done(fail('root_helper_unavailable')); }
        });
        socket.on('error', () => { clearTimeout(timer); done(fail('root_helper_unavailable')); });
        socket.on('close', () => { clearTimeout(timer); done(fail('root_helper_unavailable')); });
      });
    }
  });
}
