// Memo Bridge private hub: authenticated MCP over HTTPS on loopback, plus the agent
// WebSocket. Stateless router (spec D1): it authenticates the caller, maps the credential to
// a principal, checks the op registry (bridge/ops.mjs) and the principal's capabilities, and
// forwards the op to the agent that serves it. Protocol v2 is described in bridge/protocol.mjs.
//
// This listener (127.0.0.1:9443) takes the static owner bearer, the optional read-only bearer
// and the agents' WebSocket. It never takes OAuth tokens: ChatGPT reaches the hub through the
// separate, OIDC-only public listener (bridge/public-listener.mjs, Phase 5 decision D4), which
// shares nothing with this one except requestAgent(). The Phase 1 OIDC mode of this listener
// was removed in Phase 5: it switched the whole 9443 surface to OAuth and accepted any JWT
// with the right audience, ID tokens included.
//
// Phase 6 (operator access, spec D2, D4, D6): with the `operator` option the hub also routes
// the operator tools to the operator agents (identities operator-mac, operator-vps), each
// request signed with the dedicated operator key (bridge/operator-signing.mjs) through
// requestOperator(), the only way an operator op leaves the hub. The hub's own freeze flag
// refuses every operator op above T0; only the owner sets it (setOperatorFrozen, or the freeze
// file on lab), never a tool.
import { createServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { bearerValid, nonce, verifyChallenge, keyFingerprint } from './crypto.mjs';
import {
  MAX_FRAME_BYTES, MAX_IN_FLIGHT, MAX_REQUEST_BYTES, MAX_RESULT_BYTES, PING_INTERVAL_MS, PROTOCOL_VERSION, SUBPROTOCOL,
  CODE_RE, OP_RE, PACKAGE_VERSION, createReassembler, encodeFrames, idempotencyKey, makeRequest, newId, parseFrame,
  validateHello
} from './protocol.mjs';
import { AGENT_IDS, HOSTS, HUB_LOCAL_OPS, HUB_PRINCIPALS, OPERATOR_AGENT_IDS, OPERATOR_OPS, OPS, PRINCIPAL_IDS, RUNTIME_OPS, collectToolDefinitions,
  denialReason, isForwardable, isOperatorOp, servableBy } from './ops.mjs';
import { OPERATOR_TIER_CAPABILITIES, authorize, isRemotePrincipal, operatorCallTier } from '../server/coordinator/policy.mjs';
import { collectOperatorDefinitions } from '../server/registry.mjs';
import { APPROVAL_ID_RE, argsSha256, createOperatorSigner } from './operator-signing.mjs';
import { createApprovalStore } from './operator-approvals.mjs';
import { classifyCall, dangerReason, isPermanentApproval, needsApproval, readOnlyCommand } from './operator-dangerous.mjs';
import { createGrantStore, grantableCall, permanentCovers } from './operator-grants.mjs';
import { journalArgs } from './operator-audit.mjs';
import { sha256Hex } from './operator-output.mjs';
import { DEFAULT_HOMES, LOCK_OPS, createOperatorLocks, delegationTargetRefusal, mergeOverview } from './operator-locks.mjs';
import { HUB_OPERATOR_TOOLS } from '../server/tools/operator-repatriated.mjs';
import { operatorHelp } from './operator-help.mjs';
import { createTransfers } from './operator-transfer.mjs';
import { operatorContent } from './operator-content.mjs';
import { NOTIFY_LIMITS, createNotifier } from './operator-notifications.mjs';
import { createHubState } from './hub-state.mjs';
import { diagnoseHubJournal } from './hub-diagnose.mjs';
import { NOTIFICATION_TOOLS } from '../server/tools/operator-notifications.mjs';
import { untrusted } from './operator-output.mjs';

const tags = {readOnlyHint:true, destructiveHint:false,idempotentHint:true,openWorldHint:false};
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}]});
const fail = error => ({ok:false,error});
const MAX_HTTP_BYTES = 64 * 1024;

// Spec D6 (a): while the hub is frozen, every operator op above T0 is refused at the hub,
// before signing. Lot 1 serves T0 only; Lot 2's T1 to T3 ops go through this same check.
export const hubFreezeDenial = (tier, frozen) => (frozen && tier > 0 ? 'frozen' : null);

export function createHub(options) {
  const diagnosticEvents = [];
  // The OIDC options of Phase 1 are refused rather than ignored: a deployment still setting
  // them must fail visibly, not silently fall back to the bearer.
  for (const key of ['oidc', 'oidcPrincipal']) if (Object.hasOwn(options ?? {}, key)) throw new Error(`hub does not take ${key}: OAuth is served by the public listener only`);
  const { tlsKey, tlsCert, allowedAgentKeys, tokenSha256, readOnlyTokenSha256 = null, runtimeHost = null, mutatingOps = false,
    toolDefinitions = null, port = 9443, bind = '127.0.0.1', audit = () => {}, pingIntervalMs = PING_INTERVAL_MS, timeouts = {},
    operator = null, stateDir = null } = options;
  if (!tlsKey || !tlsCert) throw new Error('TLS is mandatory');
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error('Invalid bearer token digest');
  if (readOnlyTokenSha256 !== null && (!/^[0-9a-f]{64}$/.test(readOnlyTokenSha256) || readOnlyTokenSha256 === tokenSha256)) {
    throw new Error('Invalid read-only bearer token digest');
  }
  if (runtimeHost !== null && !HOSTS.includes(runtimeHost)) throw new Error('Invalid runtime host');
  // TODO-P4-40: mutating ops are enabled for the owner principal only, by explicit config.
  if (mutatingOps !== false && mutatingOps !== 'owner') throw new Error('mutatingOps must be false or "owner"');
  if (mutatingOps === 'owner' && runtimeHost === null) throw new Error('mutatingOps requires a runtime host');
  const permitted = new Map(Object.entries(allowedAgentKeys || {}).filter(([host])=>AGENT_IDS.includes(host) && typeof allowedAgentKeys[host]==='string'));
  // Phase 6. operator: {signingKeyPem, freezeFile?, now?}. Without it no operator op leaves the hub.
  const signer = operator ? createOperatorSigner({ privateKeyPem: operator.signingKeyPem, ...(operator.now ? { now: operator.now } : {}) }) : null;
  const freezeFile = operator?.freezeFile ?? null;
  // Durable state (bridge/hub-state.mjs): the /freeze flag, grants, locks and the notification
  // inbox survive a restart or a deploy when the hub has a state directory.
  const hubState = createHubState({ dir: stateDir, record: (event, details) => record(event, null, details) });
  const savedFreeze = hubState.load('freeze', null);
  let operatorFrozen = savedFreeze?.frozen === true;
  if (operatorFrozen) record('operator_frozen', null, { by: 'restored', since: typeof savedFreeze.at === 'string' ? savedFreeze.at.slice(0, 40) : null });
  const fileFrozen = () => {
    if (!freezeFile) return false;
    try { lstatSync(freezeFile); return true; } catch (error) { return error?.code !== 'ENOENT'; }
  };
  const hubFrozen = () => operatorFrozen || fileFrozen();
  // Phase 6 Lot 2: approvals (in memory), the Telegram bot (attachOperatorBot), approval mode
  // per host (default dangerous on both, fail closed without a bot), chain anchors.
  const approvals = createApprovalStore(operator?.now ? { now: operator.now } : {});
  const approvalModes = { mac: 'dangerous', vps: 'dangerous', ...(operator?.approvalModes ?? {}) };
  for (const mode of Object.values(approvalModes)) if (!['off', 'dangerous', 'all_root'].includes(mode)) throw new Error('invalid operator approval mode');
  let bot = null;
  // Issue #35: jobs started with notify: true are watched here until they end; the notice goes to
  // the starter's inbox and, through the bot, to the owner chat only.
  const notifier = createNotifier({
    poll: w => (w.kind === 'runtime'
      ? sendAgent(w.host, 'job_status', { args: { job_id: w.job_id }, principal: w.principal, clientSession: w.clientSession ?? null })
      : pollOperatorJob(w)),
    send: n => (bot?.notifyJob ? bot.notifyJob(n) : null),
    record: (event, details) => record(event, null, details),
    initial: hubState.load('notifications', null), onChange: data => hubState.save('notifications', data),
    ...(operator?.now ? { now: operator.now } : {}), ...(operator?.notifyLimits ? { limits: operator.notifyLimits } : {}) });
  const anchors = new Map();
  const anchorIntervalMs = operator?.anchorIntervalMs ?? 15 * 60_000;
  let anchorTimer = null;
  let operatorDefs = null;
  // Multi-session (spec D-MS4 to D-MS6): operator locks, in memory. A lock's workspace is checked
  // with the runtime (workspace_status for the caller's conversation) unless the caller injects
  // operator.verifyWorkspace (tests).
  const verifyWorkspace = operator?.verifyWorkspace ?? (async (principal, workspaceId, clientSession) => {
    const out = await sendAgent(runtimeHost ?? 'vps', 'workspace_status', { args: { workspace_id: workspaceId }, principal, clientSession });
    return out?.ok === true && out.workspace
      ? { ok: true, workspace: { ...out.workspace, ...(out.delegation ? { delegation: out.delegation } : {}) } }
      : { ok: false, error: out?.error ?? 'workspace_unverified' };
  });
  const locks = createOperatorLocks({ ...(operator?.now ? { now: operator.now } : {}), verifyWorkspace,
    homes: operator?.homes ?? DEFAULT_HOMES, initial: hubState.load('locks', null), onChange: data => hubState.save('locks', data) });
  // Repatriated tools (part 2): operator_transfer relayed here, source reads signed for the caller.
  const transfers = createTransfers({ readSource: (host, op, args, principal) => sendInternal(host, op, args, principal),
    writeDest: (host, op, args, ctx) => operatorCall(host, op, { args, principal: ctx.principal, clientSession: ctx.clientSession,
      requestId: ctx.requestId }),
    frozen: () => hubFrozen(), record: (event, details) => record(event, null, details),
    ...(operator?.transferLimits ? { limits: operator.transferLimits } : {}) });
  // Repatriation D-R14 (live bench 2026-10-14): a remote operator write or command without a
  // workspace gets the conversation's own one (sessions_overview "you"), or a new one on
  // autoWorkspaceProject, opened through the runtime for that conversation and journaled
  // workspace_auto_open. Needs the conversation's session hint; without it, one explicit step.
  const autoProject = typeof operator?.autoWorkspaceProject === 'string' ? operator.autoWorkspaceProject : 'ops';
  const sessionWorkspace = operator?.sessionWorkspace ?? (async (principal, clientSession) => {
    const runtime = runtimeHost ?? 'vps';
    const seen = await sendAgent(runtime, 'sessions_overview', { args: {}, principal, clientSession });
    const mine = seen?.ok === true ? seen.you?.workspaces?.[0] : null;
    if (typeof mine === 'string') return { ok: true, workspace_id: mine, opened: false };
    const opened = await sendAgent(runtime, 'workspace_open', { args: { project: autoProject, client_type: principal.client_type ?? 'chatgpt',
      client_label: 'operator (auto)', host: 'vps' }, principal, clientSession });
    return opened?.ok === true && typeof opened.workspace?.workspace_id === 'string'
      ? { ok: true, workspace_id: opened.workspace.workspace_id, opened: true, project: opened.workspace.project }
      : { ok: false, error: opened?.error ?? seen?.error ?? 'workspace_unavailable' };
  });
  // Repatriation D-R4: standing approvals. Durable with a state directory (pending approvals are not).
  const grants = createGrantStore({ ...(operator?.now ? { now: operator.now } : {}), homes: operator?.homes ?? DEFAULT_HOMES,
    initial: hubState.load('grants', []), onChange: rows => hubState.save('grants', rows) });
  // Issue #48: permanent grants, owner-set in each host's policy file. The hub keeps the copy its
  // operator agent reports in operator_policy (fetched on need, at most every 5 minutes and again
  // after a reconnect), only to know when it need not ask Telegram: the agent checks each ap_pm_
  // id against its own file, so a stale or forged copy can never widen a grant.
  const permanentCache = new Map(); // host -> {conn, at, grants}
  const PERMANENT_CACHE_MS = 5 * 60_000;
  const clock = operator?.now ?? Date.now;
  function permanentView(host, list) {
    if (!Array.isArray(list)) return null;
    const strings = v => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(x => typeof x === 'string' && x.length <= 1024);
    return list.filter(g => g && typeof g === 'object' && typeof g.grant_id === 'string' && APPROVAL_ID_RE.test(g.grant_id)
      && isPermanentApproval(g.grant_id) && g.host === host && strings(g.programs) && strings(g.cwd_prefixes)).slice(0, 8)
      .map(g => ({ grant_id: g.grant_id, host, programs: [...g.programs], cwd_prefixes: [...g.cwd_prefixes], source: 'permanent', expires_at: null }));
  }
  function rememberPermanent(host, list) {
    const conn = agents.get(OPERATOR_AGENT_IDS[host]);
    const view = permanentView(host, list);
    if (conn && view) permanentCache.set(host, { conn, at: clock(), grants: view });
    return view ?? [];
  }
  async function permanentGrants(host) {
    const conn = agents.get(OPERATOR_AGENT_IDS[host]);
    if (!signer || !conn) return [];
    const cached = permanentCache.get(host);
    if (cached && cached.conn === conn && clock() - cached.at < PERMANENT_CACHE_MS) return cached.grants;
    const id = newId();
    const args = { host };
    const owner = HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
    const signature = signer.sign({ id, op: 'operator_policy', host, tier: 0, principal: owner.id, args });
    const out = await sendAgent(OPERATOR_AGENT_IDS[host], 'operator_policy', { args, principal: owner, id, operator: signature });
    if (out?.ok === false || !out?.policy || typeof out.policy !== 'object') return [];
    return rememberPermanent(host, out.policy.permanent_grants ?? []);
  }
  async function allPermanentGrants() {
    const lists = await Promise.all(Object.keys(OPERATOR_AGENT_IDS).map(host => permanentGrants(host).catch(() => [])));
    return lists.flat();
  }
  const agents = new Map();   // host -> connection
  const presence = new Map(); // host -> {connected, since}: last change seen by this hub (#61)
  const pending = new Map();  // request id -> {conn, op, host, resolve, timer}
  const wss = new WebSocketServer({noServer:true, maxPayload:MAX_FRAME_BYTES, clientTracking:true, perMessageDeflate:false});
  const gate = { runtimeEnabled: runtimeHost !== null, mutatingOps };
  let definitions = toolDefinitions;
  let pinger = null;

  function record(event, host, details={}) {
    const at=new Date().toISOString();
    diagnosticEvents.push(`${at} ${String(event).slice(0,80)}`);
    if(diagnosticEvents.length>5000)diagnosticEvents.shift();
    audit({at,event,host,...details});
  }
  // Refusals are journaled with principal, op and reason only; never arguments or secrets.
  function denied(principal, op, reason) {
    record('op_denied', null, {principal: principal?.id ?? null, op: OP_RE.test(String(op)) ? op : 'invalid', reason});
    return fail(reason);
  }
  function inventory() {
    return HOSTS.map(host=>({host, online:agents.has(host), enrolled:permitted.has(host)}));
  }
  function availableOps(principal) {
    const ops = [...HUB_LOCAL_OPS, 'host_status'];
    if (gate.runtimeEnabled && definitions) for (const op of RUNTIME_OPS) {
      if (definitions.has(op) && !denialReason(principal, op, gate)) ops.push(op);
    }
    // Operator tools for a principal holding their capability (hub:owner): T0 always, T1 to T3
    // only with MEMO_BRIDGE_HUB_MUTATING_OPS=owner, like every other write on this listener.
    if (signer && operatorDefs) for (const op of OPERATOR_OPS) {
      if (operatorDefs.has(op) && (OPS[op].tier === 0 || gate.mutatingOps === 'owner') && authorize(principal, op)) ops.push(op);
    }
    return ops.sort();
  }

  // What the hub sees of an agent: connected now or not, and since when (this hub process).
  function hubPresence(host) {
    const conn = agents.get(host);
    const seen = presence.get(host);
    const online = Boolean(conn && conn.ws.readyState === WebSocket.OPEN);
    return { source: 'hub', via: 'agent_connection', online,
      since: seen && seen.connected === online ? new Date(seen.since).toISOString() : null,
      detail: online ? 'the agent of this host is connected to the hub'
        : 'no agent of this host is connected to the hub (asleep, off or offline); a lost connection shows within about 30 s (one missed ping, every 15 s)' };
  }
  // Only an answer that could not observe the host (online: null) is completed; a runtime that
  // saw the host itself keeps its own answer.
  function withHubPresence(out, op, host) {
    if (out?.ok !== true || out.local !== false) return out;
    if (op === 'host_capabilities' && out.reachability?.online === null) return { ...out, reachability: hubPresence(host) };
    if (op === 'host_resources' && out.online === null) {
      const seen = hubPresence(host);
      const { detail: _detail, ...rest } = out;
      return { ...rest, source: seen.source, via: seen.via, online: seen.online, since: seen.since, detail: seen.detail };
    }
    return out;
  }

  // Forward one op to `host`. Resolves with the agent's checked data, or {ok:false, error}.
  // requestId and clientSession (Phase 5, bridge/forward.mjs) travel in the envelope's meta,
  // never in args; the wire id stays the hub's own.
  // Operator ops are refused here: they leave the hub through requestOperator() only, signed.
  function requestAgent(host, op, options = {}) {
    if (isOperatorOp(op)) return Promise.resolve(fail('unsupported_op'));
    locks.seen(options.clientSession);
    // sessions_overview: the runtime knows the workspaces, the hub the operator locks.
    if (op === 'sessions_overview') {
      const who = options.principal ?? HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
      return sendAgent(host, op, options).then(async out => {
        const merged = mergeOverview(out, locks.overview(who, options.clientSession));
        if (merged?.ok !== true) return merged;
        const { ok: _ok, ...inbox } = notifier.check(who.id);
        return { ...merged, standing_approvals: grants.list(who.id), permanent_grants: await allPermanentGrants(), notifications: inbox };
      });
    }
    // #61: a runtime on the VPS cannot reach the Mac and answers online: null for it. The hub
    // holds the Mac agent's connection, so it fills in what it sees.
    if ((op === 'host_capabilities' || op === 'host_resources') && options.args?.host === 'mac') {
      return sendAgent(host, op, options).then(out => withHubPresence(out, op, 'mac'));
    }
    // Issue #35: notify is the hub's, never the runtime's; the job is watched once it is accepted.
    if (op === 'jobs_submit' && options.args && Object.hasOwn(options.args, 'notify')) {
      const { notify, ...rest } = options.args;
      return sendAgent(host, op, { ...options, args: rest }).then(out => {
        if (notify !== true || out?.ok !== true || typeof out.job?.job_id !== 'string') return out;
        const registered = notifier.watch({ kind: 'runtime', host, job_id: out.job.job_id, label: String(out.job.recipe ?? 'job').slice(0, 32),
          principal: options.principal ?? HUB_PRINCIPALS[PRINCIPAL_IDS.readonly], timeout_s: out.job.timeout_seconds, clientSession: options.clientSession ?? null });
        return { ...out, notify: registered };
      });
    }
    return sendAgent(host, op, options);
  }
  function sendAgent(host, op, { args = {}, principal = HUB_PRINCIPALS[PRINCIPAL_IDS.readonly], timeoutMs, requestId = null,
    clientSession = null, id: wireId = null, operator: signature = null } = {}) {
    if (!AGENT_IDS.includes(host) || !isForwardable(op) || !servableBy(host, op)) return Promise.resolve(fail('unsupported_op'));
    const spec = OPS[op];
    const conn = agents.get(host);
    if (!conn || conn.ws.readyState!==WebSocket.OPEN) return Promise.resolve(fail('host_offline'));
    if (!conn.ops.has(op)) return Promise.resolve(fail('unsupported_op'));
    if (conn.pending.size >= conn.maxInFlight) return Promise.resolve(fail('agent_busy'));
    const id = wireId ?? newId();
    let frames;
    if (conn.version === 1) {
      frames = [JSON.stringify({type:'request',id,op})];
    } else {
      const requestKey = spec.mutating ? idempotencyKey(principal.id, op, args.client_request_id) : null;
      frames = encodeFrames(makeRequest({id, op, args, principal, timeoutMs: timeoutMs ?? timeouts[op] ?? spec.timeoutMs, requestKey,
        meta: {request_id: requestId, client_session: clientSession}, operator: signature}),
        {maxMessageBytes:MAX_REQUEST_BYTES});
      if (!frames) return Promise.resolve(fail('request_too_large'));
    }
    return new Promise(resolve => {
      const timer = setTimeout(()=>{
        if (pending.delete(id)) { conn.pending.delete(id); record('op_timeout',host,{op}); resolve(fail('timeout')); }
      }, timeoutMs ?? timeouts[op] ?? spec.timeoutMs);
      pending.set(id,{conn,op,host,resolve,timer});
      conn.pending.add(id);
      for (const frame of frames) conn.ws.send(frame);
    });
  }
  // Phase 6: one operator op to the operator agent of `host` ('mac' | 'vps', taken from the
  // tool's own host argument by the caller), signed for exactly these arguments. The principal
  // must already be authorized for the op (remote surface or 9443 listing); the agent checks the
  // tier against its local policy again.
  // Owner decision 2026-10-14: `host` is optional on the operator tools. Without it the Mac is
  // used when its operator agent is connected, else vps; a root call, a script or a call on the
  // dangerous list must name it (host_required). Every result carries the host it ran on.
  function resolveOperatorHost(op, args) {
    if (args?.host !== undefined) return { host: args.host };
    if (op === 'operator_script' || (op === 'operator_run' && args?.as_root === true) || operatorCallTier(op, args) === 3 ||
      dangerReason(op, args ?? {}) !== null || (op === 'operator_grant' && args?.action === 'request')) {
      return { error: { ok: false, error: 'host_required', detail: 'Mac ou VPS ? This call needs host "mac" or "vps", named explicitly.' } };
    }
    const mac = agents.get(OPERATOR_AGENT_IDS.mac);
    return { host: mac && mac.ws.readyState === WebSocket.OPEN ? 'mac' : 'vps', defaulted: true };
  }
  async function requestOperator(host, op, options = {}) {
    if (!signer) return fail('operator_disabled');
    if (!isOperatorOp(op) || OPS[op].internal) return fail('unsupported_op');
    if (HUB_OPERATOR_TOOLS.includes(op)) return hubOperator(op, options);
    if (NOTIFICATION_TOOLS.includes(op)) return notificationCall(op, options);
    const given = options.args ?? {};
    if ((host === undefined || host === null) && given.host === undefined) {
      const resolved = resolveOperatorHost(op, given);
      if (resolved.error) {
        record('operator_refused', null, { principal: options.principal?.id ?? null, op, reason: 'host_required' });
        return resolved.error;
      }
      host = resolved.host;
      options = { ...options, args: { ...given, host } };
    }
    const out = await operatorCall(host, op, options);
    // The chat always says where the action ran.
    return out && typeof out === 'object' && !Array.isArray(out) && out.host === undefined && Object.hasOwn(OPERATOR_AGENT_IDS, host) &&
      options.args?.host === host
      ? { ...out, host } : out;
  }
  async function operatorCall(host, op, { args = {}, principal, requestId = null, clientSession = null } = {}) {
    if (!Object.hasOwn(OPERATOR_AGENT_IDS, host) || args?.host !== host) return fail('invalid_arguments');
    // The call's tier: operator_run with as_root is T3 and needs operator:root (spec D1).
    const tier = operatorCallTier(op, args);
    if (!principal?.id || !authorize(principal, op) || !principal.capabilities?.has(OPERATOR_TIER_CAPABILITIES[tier])) return fail('forbidden');
    // approval_status is answered here: approvals live in the hub (TODO-P6-11).
    if (op === 'approval_status') return approvals.status(args.approval_id, host);
    locks.seen(clientSession);
    if (op === 'operator_grant') return grantCall(host, args, principal);
    // Operator locks are answered here too (multi-session D-MS4), frozen or not: they change
    // nothing on a host.
    if (LOCK_OPS.includes(op)) {
      const out = await locks.handle(op, args, { principal, clientSession });
      record(op === 'operator_lock' ? 'operator_lock' : 'operator_unlock', OPERATOR_AGENT_IDS[host], { request_id: requestId, principal: principal.id,
        workspace_id: typeof args.workspace_id === 'string' ? args.workspace_id.slice(0, 40) : null, kind: args.kind ?? null,
        outcome: out?.ok === false ? 'refused' : 'ok', code: out?.ok === false ? out.error : null });
      return out;
    }
    const frozen = hubFrozen();
    if (hubFreezeDenial(tier, frozen)) {
      record('operator_refused', OPERATOR_AGENT_IDS[host], {principal: principal.id, op, reason: 'frozen'});
      return fail('frozen');
    }
    // D-MS5: the workspace and the locks of a T1 to T3 call, before any approval is asked. The
    // workspace_id is ours: it never reaches the agent, the signature or the approval hash.
    let lockedArgs = args;
    // Repatriation D-R13: a read-only command needs no workspace and no lock (still T2: signature,
    // rate limit, both journals; the agent checks its paths).
    const readOnly = op === 'operator_run' && args.as_root !== true && readOnlyCommand(args.argv) !== null;
    let auto = null;
    let implicit = null;
    if (tier > 0 && !readOnly) {
      // Delegation (#47): a child's call stays inside its scope, and stops once its delegation ended.
      const scoped = await delegationGate(host, op, args, principal, clientSession, args.workspace_id);
      if (!scoped.ok) {
        record('operator_refused', OPERATOR_AGENT_IDS[host], {principal: principal.id, op, reason: scoped.error});
        return scoped;
      }
      let gate = locks.check(op, args, { principal, clientSession });
      // Repatriation D-R14: a remote call without workspace or lock gets the conversation's
      // workspace and implicit locks for this call only.
      if (!gate.ok && ['workspace_required', 'lock_required'].includes(gate.error) && isRemotePrincipal(principal)) {
        const out = await implicitGate(host, op, args, principal, clientSession);
        if (out.ok) {
          args = { ...args, workspace_id: out.workspace_id }; lockedArgs = args; auto = out.auto; implicit = out.implicit;
          gate = locks.check(op, args, { principal, clientSession });
          if (!gate.ok) implicit.release();
        } else gate = out;
      }
      if (!gate.ok) {
        record('operator_refused', OPERATOR_AGENT_IDS[host], {principal: principal.id, op, reason: gate.error});
        return gate;
      }
    }
    try {
      return await signedCall(host, op, { args, lockedArgs, principal, requestId, clientSession, tier, readOnly, auto, frozen });
    } finally { implicit?.release(); }
  }

  async function signedCall(host, op, { args, lockedArgs, principal, requestId, clientSession, tier, readOnly, auto, frozen }) {
    if (Object.hasOwn(args, 'workspace_id')) { const { workspace_id: _ws, ...rest } = args; args = rest; }
    // Issue #35: notify is the hub's: removed before the hash, the approval and the signature.
    const notify = args.notify === true;
    if (Object.hasOwn(args, 'notify')) { const { notify: _n, ...rest } = args; args = rest; }
    const hash = argsSha256(args);
    let approval = null;
    let approvalSource = null;
    const mode = approvalModes[host];
    if (needsApproval(mode, op, args, tier)) {
      const call = { host, op, argsSha256: hash, principal: principal.id };
      // A single-use approval for this exact call first, then the host's permanent grants (#48),
      // then a standing approval (D-R4).
      approval = approvals.consume(call);
      if (approval) approvalSource = 'single_use';
      if (!approval && tier < 3 && grantableCall(op, args)) {
        approval = permanentCovers(await permanentGrants(host), { host, op, args }, operator?.homes ?? DEFAULT_HOMES);
        if (approval) approvalSource = 'permanent';
      }
      if (!approval) {
        approval = grants.covers({ host, op, args, principal: principal.id });
        if (approval) approvalSource = 'standing';
      }
      if (!approval) {
        if (!bot) {
          record('operator_refused', OPERATOR_AGENT_IDS[host], {principal: principal.id, op, reason: 'approval_unavailable'});
          return fail('approval_unavailable');
        }
        const reason = dangerReason(op, args) ?? (tier === 3 ? 'root' : 'policy');
        const asked = approvals.request({ ...call, reason });
        if (asked.error) return fail(asked.error);
        if (asked.created) {
          try {
            await bot.notifyApproval(asked.approval, { host, op, principal: principal.id, args: journalArgs(args), args_sha256: hash, reason,
              expires_at: new Date(asked.approval.expires).toISOString() });
          } catch {
            approvals.drop(asked.approval.id);
            record('operator_approval_unsent', OPERATOR_AGENT_IDS[host], {principal: principal.id, op});
            return fail('approval_unavailable');
          }
          record('operator_approval_requested', OPERATOR_AGENT_IDS[host], {principal: principal.id, op, tier, reason, args_sha256: hash,
            approval_id: asked.approval.id});
        }
        const danger = classifyCall(op, args);
        const grantable = tier < 3 && danger !== null && danger.hard === false;
        return { ok: false, error: 'pending_approval', approval_id: asked.approval.id, expires_at: new Date(asked.approval.expires).toISOString(),
          detail: 'the owner was asked in Telegram; poll approval_status, then repeat this exact call once it is approved',
          ...(grantable ? { standing_approval_hint: `avoid one approval per call: operator_grant action request with programs ${JSON.stringify(danger.programs)} and a cwd_prefixes entry covering this cwd, once per work session` } : {}) };
      }
    }
    const id = newId();
    const started = Date.now();
    const signature = signer.sign({ id, op, host, tier, principal: principal.id, args, approval });
    // A foreground run or script waits for its own timeout plus a margin.
    const foreground = ['operator_run', 'operator_script'].includes(op) && args.background !== true;
    const timeoutMs = foreground ? Math.max(OPS[op].timeoutMs, ((Number.isInteger(args.timeout_s) ? args.timeout_s : 30) + 30) * 1000) : undefined;
    const out = await sendAgent(OPERATOR_AGENT_IDS[host], op, { args, principal, requestId, clientSession, id, operator: signature, timeoutMs });
    if (op === 'operator_upload_init') locks.recordUpload(lockedArgs, out);
    let data = auto && out && typeof out === 'object' && !Array.isArray(out) ? { ...out, auto } : out;
    data = op === 'operator_freeze_status' && data && data.ok !== false
      ? { ...data, hub_frozen: frozen, frozen_above_t0: Boolean(data.frozen_above_t0) || frozen } : data;
    // The standing approvals live here: operator_policy shows the ones of this host (D-R4).
    if (op === 'operator_policy' && data && data.ok !== false) {
      data = { ...data, standing_approvals: grants.list(principal.id).filter(g => g.host === host) };
      if (data.policy && typeof data.policy === 'object') rememberPermanent(host, data.policy.permanent_grants ?? []);
    }
    // The agent refused our copy of a permanent grant (its file changed): ask it again next time.
    if (approvalSource === 'permanent' && data?.ok === false && data.error === 'approval_scope') permanentCache.delete(host);
    if (notify && ['operator_run', 'operator_script'].includes(op) && data && typeof data === 'object' && data.ok !== false) {
      data = { ...data, notify: args.background === true && typeof data.job_id === 'string'
        ? notifier.watch({ kind: 'operator', host, job_id: data.job_id, label: op, principal, timeout_s: args.timeout_s, clientSession })
        : { registered: false, reason: 'foreground' } };
    }
    // Hub journal (spec D7): tier, args hash and redacted args, approval, outcome, duration, output
    // hash. The wire id matches the host journal's request id when no request id travelled.
    record('operator_call', OPERATOR_AGENT_IDS[host], { request_id: requestId ?? id, principal: principal.id, op, tier,
      args_sha256: signature.args_sha256, args: journalArgs(args), approval_id: approval, ...(approvalSource ? { approval_source: approvalSource } : {}),
      ...(readOnly ? { read_only: true } : {}),
      outcome: data?.ok === false ? 'refused' : 'ok',
      code: data?.ok === false && CODE_RE.test(String(data.error)) ? data.error : null,
      exit_code: Number.isInteger(data?.exit_code) ? data.exit_code : null, ms: Date.now() - started, output_sha256: sha256Hex(data ?? null) });
    return data;
  }

  // operator_help, operator_transfer and operator_transfer_status: answered here, no host argument.
  async function hubOperator(op, { args = {}, principal, requestId = null, clientSession = null } = {}) {
    if (!principal?.id || !authorize(principal, op) || !principal.capabilities?.has(OPERATOR_TIER_CAPABILITIES[OPS[op].tier])) return fail('forbidden');
    locks.seen(clientSession);
    if (op === 'operator_help') return operatorHelp(args);
    if (op === 'operator_transfer_status') return transfers.status(args, { principal });
    return transfers.start(args, { principal, clientSession, requestId });
  }

  // Issue #35: the inbox tools, answered here for the caller's own principal.
  function notificationCall(op, { args = {}, principal, clientSession = null } = {}) {
    if (!principal?.id || !authorize(principal, op) || !principal.capabilities?.has(OPERATOR_TIER_CAPABILITIES[0])) return fail('forbidden');
    locks.seen(clientSession);
    if (op === 'notifications_check') return notifier.check(principal.id);
    if (op === 'notifications_ack') {
      const out = notifier.ack(principal.id, args);
      record('notifications_ack', null, { principal: principal.id, outcome: out.ok ? 'ok' : 'refused', acked: out.acked ?? 0 });
      return out;
    }
    const out = notifier.get(principal.id, args);
    if (!out.ok) return out;
    const { notifications, ...counts } = out;
    return { ...counts, ...untrusted({ notifications }) };
  }
  // The status of a watched operator job, signed for the principal that started it (T0).
  function pollOperatorJob(w) {
    if (!signer || !Object.hasOwn(OPERATOR_AGENT_IDS, w.host)) return Promise.resolve(fail('operator_disabled'));
    const id = newId();
    const args = { host: w.host, job_id: w.job_id };
    const signature = signer.sign({ id, op: 'operator_job_status', host: w.host, tier: 0, principal: w.principal.id, args });
    return sendAgent(OPERATOR_AGENT_IDS[w.host], 'operator_job_status', { args, principal: w.principal, id, operator: signature });
  }

  // D-R14 (bench 2026-10-14 19:57 and 20:04): the conversation's workspace, keyed by its session
  // hash: its own active one (runtime sessions_overview "you"), else one opened on
  // autoWorkspaceProject (journaled workspace_auto_open), else a coordination id derived from the
  // session (the runtime could not open one; journaled workspace_implicit). Then implicit locks on
  // what the call touches, the global one for root calls, scripts and commands without cwd,
  // released when the call returns (journaled lock_implicit). Without a session hint nothing can be
  // bound: one explicit next step.
  // Delegation (#47, spec D7): the runtime says whether a workspace is a delegated child (its
  // workspace_status carries the delegation, scope included) and refuses a child conversation that
  // names another workspace (outside_delegation_scope) or whose delegation ended (delegation_ended),
  // and, under session_binding enforce, a workspace of another conversation (workspace_other_session).
  // Asked for each (workspace, conversation) pair; a plain workspace is remembered for 30 s, a
  // child is asked again on every call so its end is seen at once. Other answers (an implicit
  // coordination id, a runtime that does not answer) leave the call to the lock rules as before.
  const plainWorkspaces = new Map(); // `${workspace}|${session}` -> ms when the runtime said "no delegation"
  const homes = operator?.homes ?? DEFAULT_HOMES;
  async function delegationGate(host, op, args, principal, clientSession, workspaceId) {
    if (typeof workspaceId !== 'string') return { ok: true };
    const key = `${workspaceId}|${clientSession ?? ''}`;
    const seenAt = plainWorkspaces.get(key);
    if (seenAt !== undefined && clock() - seenAt < 30_000) return { ok: true };
    let verified;
    try { verified = await verifyWorkspace(principal, workspaceId, clientSession); } catch { verified = null; }
    if (verified?.ok !== true) {
      // Under enforce the runtime also refuses a workspace bound to another conversation: a child
      // naming its parent's workspace meets that before the delegation rule.
      return ['delegation_ended', 'outside_delegation_scope', 'workspace_other_session', 'session_required'].includes(verified?.error)
        ? fail(verified.error) : { ok: true };
    }
    const delegation = verified.workspace?.delegation;
    if (!delegation) {
      plainWorkspaces.delete(key);
      plainWorkspaces.set(key, clock());
      while (plainWorkspaces.size > 1024) plainWorkspaces.delete(plainWorkspaces.keys().next().value);
      return { ok: true };
    }
    if (delegation.state === 'ended') return fail('delegation_ended');
    if (typeof delegation.parent_workspace_id === 'string') locks.setFamily(workspaceId, delegation.parent_workspace_id);
    const targets = locks.targetsOf(op, { ...args, host });
    if (targets.error) return fail(targets.error);
    return delegationTargetRefusal(delegation, host, targets.unknownUpload ? [] : targets, homes) ?? { ok: true };
  }

  const sessionWorkspaces = new Map(); // session hash -> {workspaceId, opened}
  async function implicitGate(host, op, args, principal, clientSession) {
    let workspaceId = args.workspace_id;
    let opened = false;
    if (workspaceId === undefined) {
      if (!clientSession) {
        return { ok: false, error: 'workspace_required', next_step: `call workspace_open {"project":"${autoProject}"}, then repeat this call with its workspace_id` };
      }
      const known = sessionWorkspaces.get(clientSession);
      if (known) workspaceId = known.workspaceId;
      else {
        let found;
        try { found = await sessionWorkspace(principal, clientSession); } catch { found = { ok: false }; }
        if (found?.ok && /^ws_[A-Za-z0-9_-]{16}$/.test(String(found.workspace_id))) {
          workspaceId = found.workspace_id;
          opened = found.opened === true;
          if (opened) record('workspace_auto_open', null, { principal: principal.id, workspace_id: workspaceId, project: found.project ?? autoProject, op });
        } else {
          workspaceId = `ws_${createHash('sha256').update(`memo-bridge/implicit-workspace|${clientSession}`).digest('base64url').slice(0, 16)}`;
          record('workspace_implicit', null, { principal: principal.id, workspace_id: workspaceId, code: typeof found?.error === 'string' ? found.error.slice(0, 64) : null });
        }
        sessionWorkspaces.set(clientSession, { workspaceId });
        while (sessionWorkspaces.size > 256) sessionWorkspaces.delete(sessionWorkspaces.keys().next().value);
      }
    }
    const targets = locks.targetsOf(op, { ...args, host });
    if (targets.error) return { ok: false, error: targets.error };
    if (targets.unknownUpload) return { ok: false, error: 'lock_required', next_step: 'start the upload again with operator_upload_init' };
    if (args.workspace_id === undefined) {
      const scoped = await delegationGate(host, op, args, principal, clientSession, workspaceId);
      if (!scoped.ok) return scoped;
    }
    const ttlMs = ((Number.isInteger(args.timeout_s) ? args.timeout_s : 30) + 120) * 1000;
    const held = locks.acquireImplicit(host, targets, { principal, clientSession, workspaceId, ttlMs });
    if (!held.ok) return held;
    if (held.ids.length) record('lock_implicit', OPERATOR_AGENT_IDS[host], { principal: principal.id, workspace_id: workspaceId, op,
      kinds: targets.map(t => t.kind) });
    return { ok: true, workspace_id: workspaceId, implicit: held,
      auto: { workspace_id: workspaceId, workspace_opened: opened, lock: 'implicit, released after this call' } };
  }

  // operator_grant (D-R4): list, request (the owner decides in Telegram), revoke. Answered here,
  // never signed: it changes nothing on a host. A request needs the exec capability it would serve.
  async function grantCall(host, args, principal) {
    if (args.action === 'list') return { ok: true, host, standing_approvals: grants.list(principal.id).filter(g => g.host === host) };
    if (args.action === 'revoke') {
      const out = grants.revoke(args.grant_id, { principal: principal.id });
      record('operator_grant_revoked', OPERATOR_AGENT_IDS[host], { principal: principal.id, grant_id: typeof args.grant_id === 'string' ? args.grant_id : null,
        outcome: out.ok ? 'ok' : 'refused' });
      return { ...out, host };
    }
    if (!principal.capabilities?.has(OPERATOR_TIER_CAPABILITIES[2])) return fail('forbidden');
    if (hubFrozen()) return fail('frozen');
    if (!bot?.notifyGrant) return fail('approval_unavailable');
    const out = grants.request({ host, programs: args.programs, cwd_prefixes: args.cwd_prefixes, ttl_hours: args.ttl_hours, reason: args.reason ?? null },
      principal.id);
    if (!out.ok) return { ...out, host };
    const view = grants.get(out.grant.id);
    try { await bot.notifyGrant(view, { principal: principal.id }); } catch {
      grants.revoke(out.grant.id);
      record('operator_approval_unsent', OPERATOR_AGENT_IDS[host], { principal: principal.id, op: 'operator_grant' });
      return fail('approval_unavailable');
    }
    record('operator_grant_requested', OPERATOR_AGENT_IDS[host], { principal: principal.id, grant_id: view.grant_id, programs: view.programs,
      cwd_prefixes: view.cwd_prefixes, ttl_hours: view.ttl_hours });
    return { ok: true, host, status: 'pending', grant_id: view.grant_id, programs: view.programs, cwd_prefixes: view.cwd_prefixes, ttl_hours: view.ttl_hours,
      detail: 'the owner was asked in Telegram; poll operator_grant action list until it is active, then run with cwd under a prefix' };
  }

  function setOperatorFrozen(value, by) {
    operatorFrozen = value === true;
    // Saved before it is journaled: an emergency stop must not be lifted by the next deploy.
    hubState.save('freeze', { frozen: operatorFrozen, by: typeof by === 'string' ? by.slice(0, 64) : 'owner', at: new Date().toISOString() });
    record(operatorFrozen ? 'operator_frozen' : 'operator_unfrozen', null, {by: typeof by === 'string' ? by.slice(0, 64) : 'owner'});
  }

  // Internal operator ops (never tools): signed by the hub as hub:owner, or for the caller whose
  // call they serve (the source reads of operator_transfer), so the host journal names that caller.
  function sendInternal(host, op, args, principal = HUB_PRINCIPALS[PRINCIPAL_IDS.owner]) {
    if (!signer || !OPS[op]?.internal || !Object.hasOwn(OPERATOR_AGENT_IDS, host)) return Promise.resolve(fail('unsupported_op'));
    const id = newId();
    const signature = signer.sign({ id, op, host, tier: 0, principal: principal.id, args });
    return sendAgent(OPERATOR_AGENT_IDS[host], op, { args, principal, id, operator: signature });
  }
  // The owner's Telegram /unfreeze: the hub flag, then each host's auto-freeze (signed internal
  // op). The FROZEN files stay the owner's to remove on the hosts.
  async function ownerUnfreeze(by = 'owner') {
    setOperatorFrozen(false, by);
    const hosts = {};
    for (const host of Object.keys(OPERATOR_AGENT_IDS)) {
      if (!agents.has(OPERATOR_AGENT_IDS[host])) continue;
      const out = await sendInternal(host, 'operator_owner_unfreeze', { host, by: String(by).slice(0, 64) });
      hosts[host] = out?.ok === true ? (out.cleared ? 'auto_freeze_cleared' : 'not_auto_frozen') : (out?.error ?? 'failed');
    }
    return hosts;
  }
  // Spec D7: every anchorIntervalMs the hub asks each operator agent for its chain head and the
  // hash of the last line it anchored. A shorter chain or a changed anchored line means the host
  // journal was rewritten: the hub journals it and freezes operator access above T0.
  async function anchorChains() {
    const results = {};
    for (const host of Object.keys(OPERATOR_AGENT_IDS)) {
      if (!agents.has(OPERATOR_AGENT_IDS[host])) continue;
      const last = anchors.get(host) ?? null;
      const out = await sendInternal(host, 'operator_audit_head', { host, ...(last ? { since_seq: last.seq } : {}) });
      if (out?.ok !== true || typeof out.head !== 'string' || !Number.isInteger(out.seq)) {
        record('operator_anchor_failed', OPERATOR_AGENT_IDS[host], { code: out?.error ?? 'invalid' });
        results[host] = 'failed';
        continue;
      }
      const rewritten = last && (out.seq < last.seq || out.at?.hash !== last.hash);
      if (rewritten || out.chain_ok === false) {
        record('operator_chain_tampered', OPERATOR_AGENT_IDS[host], { anchored_seq: last?.seq ?? null, seq: out.seq, chain_ok: out.chain_ok,
          first_broken_line: out.first_broken_line ?? null });
        setOperatorFrozen(true, 'chain_check');
        results[host] = 'tampered';
        continue;
      }
      if (out.seq > 0) anchors.set(host, { seq: out.seq, hash: out.head });
      record('operator_chain_anchor', OPERATOR_AGENT_IDS[host], { seq: out.seq, head: out.head });
      results[host] = 'anchored';
    }
    return results;
  }

  function settle(id, value) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id); job.conn.pending.delete(id); clearTimeout(job.timer);
    job.resolve(value);
  }
  // A closed connection fails its outstanding requests at once (spec REQ-P4-02).
  function flush(conn, code) {
    for (const id of [...conn.pending]) settle(id, fail(code));
  }

  function onAgentMessage(conn, msg) {
    if (msg.type === 'hello') {
      if (conn.version === 2) { conn.ws.close(1008,'duplicate hello'); return; }
      const hello = validateHello(msg, conn.host);
      if (!hello.ok) {
        record('agent_hello_refused', conn.host, {reason: hello.code});
        conn.ws.close(1008, hello.code); return;
      }
      // Effective ops: what the registry allows AND the agent serves. Anything else advertised
      // is ignored, so an agent can never widen what the hub forwards. Operator ops are taken
      // from operator identities only, and an operator identity serves nothing else.
      const effective = hello.ops.filter(op => isForwardable(op) && servableBy(conn.host, op));
      conn.version = 2; conn.ops = new Set(effective); conn.maxInFlight = hello.maxInFlight; conn.agentVersion = hello.version;
      record('agent_hello', conn.host, {version: hello.version, ops: effective.length, ignored: hello.ops.length - effective.length});
      conn.ws.send(JSON.stringify({v:PROTOCOL_VERSION,type:'welcome',ops:effective}));
      return;
    }
    if (msg.type !== 'result' && msg.type !== 'error') return;
    if (typeof msg.id !== 'string') return;
    const job = pending.get(msg.id);
    if (!job || job.conn !== conn) return;
    if (msg.type === 'error') {
      settle(msg.id, fail(typeof msg.code === 'string' && CODE_RE.test(msg.code) ? msg.code : 'invalid_agent_response'));
      return;
    }
    const spec = OPS[job.op];
    if (spec.checkResult(msg.data, conn.host)) settle(msg.id, msg.data);
    else { record('invalid_agent_response', conn.host, {op: job.op}); settle(msg.id, fail('invalid_agent_response')); }
  }

  wss.on('connection',ws=>{
    const value=nonce();
    let conn=null;
    const authTimer=setTimeout(()=>ws.close(1008,'authentication timeout'),6000);
    ws.send(JSON.stringify({type:'challenge',nonce:value}));
    ws.on('message',(raw,isBinary)=>{
      const msg = isBinary ? null : parseFrame(raw);
      if (!msg) { ws.close(1008,'invalid message'); return; }
      if (!conn) {
        if (msg.type!=='authenticate'|| typeof msg.host!=='string'||typeof msg.signature!=='string'|| !permitted.has(msg.host)|| !verifyChallenge(msg.host,value,msg.signature,permitted.get(msg.host))) {
          record('agent_auth_denied',null); ws.close(1008,'unauthorized'); return;
        }
        clearTimeout(authTimer);
        // Until a v2 hello arrives the agent is treated as v1: host_status only.
        conn = {ws, host:msg.host, version:1, ops:new Set(['host_status']), pending:new Set(), maxInFlight:MAX_IN_FLIGHT,
          alive:true, agentVersion:null, parts:createReassembler({maxMessageBytes:MAX_RESULT_BYTES, tooLarge:'result_too_large'})};
        const existing=agents.get(conn.host);
        if(existing && existing.ws!==ws) existing.ws.close(1000,'reconnected');
        agents.set(conn.host,conn);
        presence.set(conn.host, {connected:true, since:Date.now()});
        record('agent_connected',conn.host,{fingerprint:keyFingerprint(permitted.get(conn.host))});
        ws.send(JSON.stringify({type:'authenticated'}));
        return;
      }
      if (msg.type==='part') {
        const out = conn.parts.accept(msg);
        if (!out) return;
        if (out.error) { if (out.id) settle(out.id, fail(out.error)); return; }
        onAgentMessage(conn, out.message);
        return;
      }
      // v1 result (legacy agent), host_status only.
      if (conn.version===1 && msg.type==='result' && msg.v===undefined) { onAgentMessage(conn, msg); return; }
      if (msg.v!==undefined && msg.v!==PROTOCOL_VERSION) { ws.close(1008,'unsupported version'); return; }
      onAgentMessage(conn, msg);
    });
    ws.on('pong',()=>{ if (conn) conn.alive=true; });
    ws.on('close',()=>{
      clearTimeout(authTimer);
      if (!conn) return;
      flush(conn,'agent_disconnected');
      conn.parts.clear();
      if (agents.get(conn.host)===conn){
        agents.delete(conn.host);
        presence.set(conn.host, {connected:false, since:Date.now()});
        record('agent_disconnected',conn.host);
      }
    });
    ws.on('error',()=>{});
  });

  // Ping every agent; one that has not answered the previous ping is dropped (and its
  // pending requests flushed by the close handler).
  function heartbeat() {
    for (const conn of agents.values()) {
      if (!conn.alive) { record('agent_ping_timeout',conn.host); conn.ws.terminate(); continue; }
      conn.alive=false;
      try { conn.ws.ping(); } catch { /* closed meanwhile */ }
    }
  }

  async function forward(principal, op, args) {
    const reason = denialReason(principal, op, gate);
    if (reason) return denied(principal, op, reason);
    const out = await requestAgent(runtimeHost, op, {args, principal});
    if (out?.ok===false && out.error==='forbidden') record('op_denied_by_runtime',runtimeHost,{principal:principal.id,op,reason:'forbidden'});
    return out;
  }

  function makeMcp(principal) {
    const mcp=new McpServer({name:'memo-bridge-hub',version:PACKAGE_VERSION},{instructions:'Memo Bridge private hub. Read-only inventory of owner-enrolled Mac and VPS; when enabled, the VPS runtime tools (workspaces, tasks, worktrees, jobs) for the principal of your credential. No arbitrary commands.'});
    mcp.registerTool('list_hosts',{description:'Show authenticated and connected Mac/VPS agents',inputSchema:z.object({}),annotations:tags},async()=>result(inventory()));
    mcp.registerTool('host_status',{description:'Get fixed, read-only host information',inputSchema:z.object({host:z.enum(['mac','vps'])}),annotations:tags},async({host})=>{
      const out=await requestAgent(host,'host_status',{principal});
      return result(out?.ok===false ? {host,online:false,error:out.error} : out);
    });
    mcp.registerTool('bridge_diagnose',{description:'Read-only classification of bounded redacted hub events; no corrections.',inputSchema:z.object({}),annotations:tags},async()=>result(diagnoseHubJournal(diagnosticEvents)));
    mcp.registerTool('bridge_info',{description:'Show current security and feature limitations',inputSchema:z.object({}),annotations:tags},async()=>result({
      mode: gate.mutatingOps==='owner' ? 'read-write-owner' : 'read-only', protocol: PROTOCOL_VERSION, version: PACKAGE_VERSION,
      transport:'https private-loopback', agent_transport:'authenticated-wss',
      oauth:'public listener only (bridge/public-listener.mjs)', public_exposure:false, principal:{id:principal.id, capabilities:[...principal.capabilities].sort()},
      runtime_host: runtimeHost, mutating_ops: gate.mutatingOps==='owner' ? 'owner' : 'disabled',
      agents: [...agents.values()].map(c=>({host:c.host, protocol:c.version, version:c.agentVersion, ops:c.ops.size})),
      tools: availableOps(principal)
    }));
    if (signer && operatorDefs) {
      for (const op of availableOps(principal)) {
        if (!isOperatorOp(op)) continue;
        const def = operatorDefs.get(op);
        mcp.registerTool(op,{description:def.description,inputSchema:def.inputSchema,annotations:def.annotations},
          async args=>(operatorCallTier(op, args ?? {}) > 0 && gate.mutatingOps !== 'owner'
            ? result(fail('forbidden')) : operatorContent(await requestOperator(args?.host, op, {args: args ?? {}, principal}))));
      }
    }
    if (gate.runtimeEnabled && definitions) {
      for (const op of availableOps(principal)) {
        if (HUB_LOCAL_OPS.includes(op) || op==='host_status' || isOperatorOp(op)) continue;
        const def = definitions.get(op);
        mcp.registerTool(op,{description:def.description,inputSchema:def.inputSchema,annotations:def.annotations},
          async args=>result(await forward(principal, op, args ?? {})));
      }
    }
    return mcp;
  }
  // Journal every tools/call this principal may not make, before the MCP layer answers it
  // (an op that is not listed for the principal is "unknown tool" to the MCP SDK).
  function inspectCalls(principal, raw) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    for (const msg of Array.isArray(body) ? body : [body]) {
      if (msg?.method!=='tools/call' || typeof msg.params?.name!=='string') continue;
      const op = msg.params.name;
      if (availableOps(principal).includes(op)) continue;
      denied(principal, op, denialReason(principal, op, gate) ?? (isForwardable(op) ? 'runtime_disabled' : 'unsupported_op'));
    }
  }
  async function handleMcp(req,res,principal) {
    if (req.method!=='POST'){res.writeHead(405,{allow:'POST'}).end();return;}
    const ct=(req.headers['content-type']||'');
    if(!ct.startsWith('application/json')){res.writeHead(415).end();return;}
    const body=[];
    let size=0;
    try{
      for await (const chunk of req){size+=chunk.length;if(size>MAX_HTTP_BYTES)throw new Error('body_too_large');body.push(chunk);}
    }catch{res.writeHead(413).end();return;}
    const raw=Buffer.concat(body);
    inspectCalls(principal, raw);
    const mcp=makeMcp(principal);
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true,maxRequestBodySize:MAX_HTTP_BYTES});
    try{
      await mcp.connect(transport);
      const request=new Request('https://localhost/mcp',{method:'POST',headers:{'content-type':'application/json','accept':req.headers.accept||'application/json, text/event-stream'},body:raw});
      const response=await transport.handleRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {record('mcp_internal_error',null);if(!res.headersSent)res.writeHead(500).end();}
    finally{await transport.close().catch(()=>{});await mcp.close().catch(()=>{});}
  }
  // Credential -> principal (spec D9). Both bearer digests are always compared, in constant time.
  function principalOf(header) {
    const owner = bearerValid(header, tokenSha256);
    const reader = readOnlyTokenSha256 ? bearerValid(header, readOnlyTokenSha256) : false;
    if (owner) return HUB_PRINCIPALS[PRINCIPAL_IDS.owner];
    if (reader) return HUB_PRINCIPALS[PRINCIPAL_IDS.readonly];
    return null;
  }
  const server=createServer({key:tlsKey,cert:tlsCert,minVersion:'TLSv1.2',requestCert:false},async(req,res)=>{
    const path=new URL(req.url||'/', 'https://localhost').pathname;
    if (path==='/health' && req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end('{"status":"ok"}');return;
    }
    if (path!=='/mcp'){res.writeHead(404).end();return;}
    const principal = principalOf(req.headers.authorization);
    if(!principal){
      record('owner_auth_denied',null);
      res.writeHead(401,{'www-authenticate':'Bearer realm="memo-bridge"', 'cache-control':'no-store'}).end();return;
    }
    record('mcp_request',null,{principal:principal.id});
    await handleMcp(req,res,principal);
  });
  server.on('upgrade',(req,socket,head)=>{
    const path=(req.url||'').split('?')[0];
    if (path!=='/agent' || req.headers.origin || !req.headers['sec-websocket-protocol']?.split(',').map(x=>x.trim()).includes(SUBPROTOCOL)){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  return {
    async start(){
      if (gate.runtimeEnabled && !definitions) definitions = await collectToolDefinitions();
      if (signer && !operatorDefs) operatorDefs = await collectOperatorDefinitions();
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
      pinger = setInterval(heartbeat, pingIntervalMs); pinger.unref();
      notifier.start(operator?.notifyPollMs ?? NOTIFY_LIMITS.pollMs);
      if (signer && anchorIntervalMs > 0) { anchorTimer = setInterval(() => { anchorChains().catch(() => {}); }, anchorIntervalMs); anchorTimer.unref(); }
      return server.address();
    },
    async stop(){
      clearInterval(pinger); clearInterval(anchorTimer); bot?.stop?.(); notifier.stop();
      for (const id of [...pending.keys()]) settle(id, fail('shutting_down'));
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve=>server.close(resolve));
    },
    inventory, requestAgent, requestOperator, availableOps,
    diagnose: () => diagnoseHubJournal(diagnosticEvents),
    // Owner-only (spec D6): hub-cli and, in Lot 2, the Telegram bot call these. No tool does.
    setOperatorFrozen, operatorFrozen: hubFrozen, operatorKeyId: signer?.keyId ?? null, ownerUnfreeze, anchorChains,
    operatorApprovals: approvals, operatorLocks: locks, operatorTransfers: transfers, operatorGrants: grants, operatorNotifications: notifier,
    // The Telegram bot (bridge/operator-telegram.mjs), built by hub-cli with the hub's owner hooks.
    attachOperatorBot(value) { bot = value; },
    agentInfo(host){ const c=agents.get(host); return c ? {version:c.version, ops:[...c.ops].sort(), pending:c.pending.size} : null; }
  };
}
