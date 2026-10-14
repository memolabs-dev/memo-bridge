// Root helper on lab (Phase 6, TODO-P6-10, spec D3, D4, D7).
//
// A small root process (memo-operator-root.service, lab-infra) listening on a Unix socket in a
// directory only root and the memo-operator group can reach (policy root_helper.socket, for
// example /run/memo-operator/root.sock). It never trusts the agent for authority: every call
// carries the hub's Ed25519 operator signature, which the helper verifies itself with its own
// nonce cache (operator-signing.mjs), then checks its own copy of the policy (max_tier root,
// FROZEN, rate limit, approval required by approval_mode), exactly like the agent does.
//
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
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPERATOR_SCHEMAS } from '../server/tools/operator-tools.mjs';
import { operatorCallTier } from '../server/coordinator/policy.mjs';
import { needsApproval } from './operator-dangerous.mjs';
import { checkCwd, checkRun } from './operator-exec.mjs';
import { createDenylist, catalogProjects } from './operator-paths.mjs';
import { finalizeResult, untrusted } from './operator-output.mjs';
import { argsSha256 } from './operator-signing.mjs';
import { runArgv, SAFE_ENV } from './operator-tools.mjs';

export const ROOT_LIMITS = Object.freeze({ memoryMax: '2G', tasksMax: 512, requestBytes: 512 * 1024, marginS: 15 });
const ROOT_OPS = new Set(['operator_run', 'operator_script', 'operator_job_status']);
const OP_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOMES = new Set(['ok', 'denied', 'error']);
const INTERPRETERS = Object.freeze({ bash: { program: '/bin/bash', ext: 'sh' }, python3: { program: '/usr/bin/python3', ext: 'py' } });

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// The systemd-run argv of one root call. Pure; every caller value fills one argv slot.
export function systemdRunArgv({ unit, description, argv, cwd = '/', env = {}, timeoutS, memoryMax = ROOT_LIMITS.memoryMax,
  tasksMax = ROOT_LIMITS.tasksMax }) {
  return ['systemd-run', '--quiet', '--collect', '--wait', '--pipe', `--unit=${unit}`, `--description=${description}`,
    `--property=RuntimeMaxSec=${timeoutS}s`, `--property=MemoryMax=${memoryMax}`, `--property=TasksMax=${tasksMax}`,
    `--working-directory=${cwd}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), '--', ...argv];
}

// policy, verifier (createOperatorVerifier with the hub key), guard (createOperatorGuard with
// the helper's own marker), chain (createAuditChain over the root-owned file), jobs
// (createJobStore prefix 'rj'), executor (argv runner: runArgv; tests inject a recorder).
export function createRootHelper({ policy, verifier, guard, chain, jobs = null, executor = runArgv, scriptDir,
  projects = catalogProjects(policy.repositories), now = Date.now, random = randomBytes, log = () => {} }) {
  if (!policy || !verifier || !guard || !chain || !scriptDir) throw new Error('root helper needs policy, verifier, guard, chain, scriptDir');
  const denylist = createDenylist(policy);

  const journal = (fields, out) => chain.append({ ...fields, source: 'root-helper', output: out });

  async function call(msg) {
    const started = now();
    const { id, op, args = {}, operator } = msg;
    const principal = typeof msg.principal === 'string' ? msg.principal : null;
    const tier = operatorCallTier(op, args);
    const base = { request_id: msg.request_id ?? id ?? null, ref: typeof args?.ref === 'string' ? args.ref.slice(0, 128) : null, op, tier,
      principal, args, args_sha256: argsSha256(args) };
    const refuse = code => {
      guard.refused(code);
      const out = fail(code);
      journal({ ...base, outcome: 'denied', code, ms: now() - started }, out);
      log('root_refused', { op, code });
      return out;
    };
    if (!ROOT_OPS.has(op)) return refuse('unsupported_op');
    const signed = verifier.verify(operator, { id, op, args, principal });
    if (!signed.ok) return refuse(signed.error);
    if (signed.tier !== tier) return refuse('tier_mismatch');
    if (op !== 'operator_job_status' && tier !== 3) return refuse('tier_mismatch');
    if (tier > policy.maxTier) return refuse('tier_not_allowed');
    const admitted = guard.admit(tier);
    if (admitted) return refuse(admitted);
    if (needsApproval(policy.approvalMode, op, args, tier) && !signed.approval) return refuse('approval_required');
    const parsed = OPERATOR_SCHEMAS[op].safeParse(args);
    if (!parsed.success || parsed.data.host !== 'vps') return refuse('invalid_arguments');
    const a = parsed.data;

    let data;
    try { data = await execute(op, a, { id, principal }); } catch { data = fail('internal_error'); }
    const { data: out } = finalizeResult(base.ref !== null ? { ...data, ref: base.ref } : data);
    journal({ ...base, approval: signed.approval, outcome: data.ok === false ? 'denied' : 'ok', code: data.ok === false ? data.error : null,
      ms: now() - started }, out);
    return out;
  }

  async function execute(op, a, { principal }) {
    if (op === 'operator_job_status') {
      if (!jobs) return fail('unknown_job');
      const s = await jobs.status(a.job_id);
      if (!s.ok) return s;
      const { stdout, stderr, ...rest } = s;
      return { ...rest, host: 'vps', as_root: true, ...(s.status === 'done' ? untrusted({ stdout, stderr }) : {}) };
    }
    let program;
    let script = null;
    if (op === 'operator_script') {
      const interp = INTERPRETERS[a.interpreter];
      await mkdir(scriptDir, { recursive: true, mode: 0o700 });
      script = join(scriptDir, `${random(12).toString('hex')}.${interp.ext}`);
      await writeFile(script, a.content, { mode: 0o700, flag: 'wx' });
      program = [interp.program, script, ...(a.args ?? [])];
    }
    const checked = checkRun(op === 'operator_script' ? { argv: program, timeout_s: a.timeout_s, background: a.background } : a, policy,
      { baseEnv: {} });
    if (!checked.ok) { if (script) await unlink(script).catch(() => {}); return checked; }
    const cwd = await checkCwd(policy, a.cwd, { denylist, projects });
    if (!cwd.ok) { if (script) await unlink(script).catch(() => {}); return cwd; }
    const unit = `memo-op-${random(6).toString('hex')}`;
    const argv = systemdRunArgv({ unit, description: `memo-operator ${op} for ${principal ?? 'unknown'}`, argv: checked.argv, cwd: cwd.path,
      env: checked.env, timeoutS: checked.timeoutS });
    if (checked.background) {
      if (!jobs) return fail('background_unavailable');
      const { job_id: jobId } = await jobs.start({ op, argv, cwd: '/', env: { ...SAFE_ENV }, timeout_s: checked.timeoutS + ROOT_LIMITS.marginS });
      return { ok: true, host: 'vps', as_root: true, status: 'running', job_id: jobId, unit };
    }
    const started = now();
    try {
      const r = await executor(argv, { env: { ...SAFE_ENV }, timeoutMs: (checked.timeoutS + ROOT_LIMITS.marginS) * 1000 });
      if (r.code === null && !r.timedOut) return fail('systemd_run_unavailable');
      return { ok: true, host: 'vps', as_root: true, unit, exit_code: r.code, timed_out: r.timedOut === true, output_capped: r.truncated === true,
        duration_ms: now() - started, ...untrusted({ stdout: r.stdout, stderr: r.stderr }) };
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
          case 'audit_append': return appendFromAgent(msg.fields);
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

// The socket server. The socket file is created 0660; the directory's owner and mode
// (root:memo-operator 0750, lab-infra RuntimeDirectory=) decide who can connect at all.
export function createRootHelperServer({ helper, socketPath, log = () => {} }) {
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
      await chmod(socketPath, 0o660);
      log('root_helper_listening', {});
    },
    stop: () => new Promise(resolve => server.close(() => resolve()))
  };
}

// The agent's client: one request per connection. Resolves with the answer or
// {ok:false, error:'root_helper_unavailable'}.
export function createRootHelperClient({ socketPath, timeoutMs = 700_000 }) {
  return Object.freeze({
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
