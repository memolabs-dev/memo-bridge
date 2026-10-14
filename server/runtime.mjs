// Shared, lazily opened services for every tool module, so all of them use the same private
// store, the same server-derived principal and the same ledger client. Tests build their own
// runtime with createRuntime({...}) and never touch the user's state.
//
// Phase 4: one runtime can serve several principals. The stdio entry point keeps its local
// owner. The VPS runner (agent-cli in runtime mode) receives requests forwarded by the hub,
// each with the identity the hub authenticated; it maps that claim with principalFromHub() and
// runs the request on runtime.as(principal), a view that shares the store, the ledger and the
// host but authorizes, owns workspaces and journals as that principal. The runtime authorizes
// again on every operation, whatever the hub decided (spec flow G, step 4).
import { join } from 'node:path';
import { platform } from 'node:os';
import { createCoordinator } from './coordinator/index.mjs';
import { createIssueLeaseClient } from './coordinator/issue-lease.mjs';
import { authorize, hubGrantsFromEnv, isPrincipal, localOwnerPrincipal, parseHubGrants,
  principalFromHub as mapHubPrincipal } from './coordinator/policy.mjs';
import { defaultStateDir, openSqliteStore } from './coordinator/store.mjs';

export function currentHost() {
  return platform() === 'darwin' ? 'mac' : 'vps';
}

// Views kept per principal; a handful exist in practice (owner, read-only test bearer).
const MAX_VIEWS = 64;

export function createRuntime({ stateDir = defaultStateDir(), principal = localOwnerPrincipal(), ledger, now = Date.now,
  catalogOptions = {}, host = currentHost(), resolveProject, projectRemote, hubGrants, env = process.env } = {}) {
  let store;
  const coordinators = new Map();
  const views = new Map();
  let grants;

  // The ledger's private gh configuration directories live under the state directory: with
  // ProtectSystem=strict and no PrivateTmp, /tmp is read-only for the runner (systemd.exec(5),
  // systemd 257, ProtectSystem=: "strict" mounts the entire hierarchy read-only except /dev,
  // /proc and /sys; only ReadWritePaths= such as /var/lib/memo-runner stay writable).
  const sharedLedger = ledger ?? createIssueLeaseClient({ env, scratchDir: join(stateDir, 'ledger-gh') });

  const openStore = () => { store ??= openSqliteStore({ dir: stateDir }); return store; };
  const coordinatorFor = p => {
    if (!coordinators.has(p)) {
      coordinators.set(p, createCoordinator({ store: openStore(), principal: p, ledger: sharedLedger, now, catalogOptions, host,
        ...(resolveProject ? { resolveProject } : {}), ...(projectRemote ? { projectRemote } : {}) }));
    }
    return coordinators.get(p);
  };
  // Append one audit event; never throws (the journal must not take an operation down).
  const auditAs = p => async (op, outcome, code, ids = {}) => {
    try {
      await openStore().transaction(repo => repo.appendEvent({ at: now(), principal: p.id,
        workspace_id: ids.workspace_id ?? null, issue_ref: ids.issue ?? null, op, outcome, code: code ?? null }));
    } catch { /* journal unavailable */ }
  };

  const runtime = {
    now, host, stateDir, catalogOptions,
    store: openStore,
    ledger: sharedLedger,
    coordinator: () => coordinatorFor(principal),
    authorize: op => authorize(principal, op),
    audit: auditAs(principal),

    // A view of this runtime acting as `p`, a principal minted by policy.mjs (makePrincipal,
    // principalFromHub). It shares everything except the identity: authorization, workspace
    // ownership, the coordinator and the journal all use `p`. Anything that is not a minted
    // principal throws, so a request body can never become an identity. Views are cached per
    // principal so per-runtime services (worktree runner, job service) are reused.
    as(p) {
      if (!isPrincipal(p)) throw new Error('invalid_principal');
      if (p === principal) return runtime;
      const key = `${p.id}\0${[...p.capabilities].sort().join(',')}`;
      const cached = views.get(key);
      if (cached) return cached;
      const view = Object.create(runtime);
      Object.defineProperties(view, {
        principal: { value: p, enumerable: true },
        coordinator: { value: () => coordinatorFor(p) },
        authorize: { value: op => authorize(p, op) },
        audit: { value: auditAs(p) },
        // The view does not own the store: closing it is the base runtime's job.
        close: { value: async () => {} }
      });
      if (views.size >= MAX_VIEWS) {
        const oldest = views.keys().next().value;
        coordinators.delete(views.get(oldest).principal);
        views.delete(oldest);
      }
      views.set(key, Object.freeze(view));
      return views.get(key);
    },

    // Map an identity claim forwarded by the hub to a principal, or null when it is refused
    // (unknown id, malformed claim, invalid grants configuration: always fail closed).
    principalFromHub(claim) {
      try {
        grants ??= hubGrants !== undefined ? parseHubGrants(hubGrants) : hubGrantsFromEnv(env);
      } catch {
        return null;
      }
      return mapHubPrincipal(claim, grants);
    },

    async close() { if (store) await store.close(); }
  };
  // The identity of the base runtime is fixed for its lifetime.
  Object.defineProperty(runtime, 'principal', { value: principal, enumerable: true, writable: false, configurable: false });
  return runtime;
}

let shared;
export function getRuntime() {
  shared ??= createRuntime();
  return shared;
}
