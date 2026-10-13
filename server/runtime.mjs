// Shared, lazily opened services for every tool module, so all of them use the same private
// store, the same server-derived principal and the same ledger client. Tests build their own
// runtime with createRuntime({...}) and never touch the user's state.
import { platform } from 'node:os';
import { createCoordinator } from './coordinator/index.mjs';
import { createIssueLeaseClient } from './coordinator/issue-lease.mjs';
import { authorize, localOwnerPrincipal } from './coordinator/policy.mjs';
import { defaultStateDir, openSqliteStore } from './coordinator/store.mjs';

export function currentHost() {
  return platform() === 'darwin' ? 'mac' : 'vps';
}

export function createRuntime({ stateDir = defaultStateDir(), principal = localOwnerPrincipal(), ledger, now = Date.now,
  catalogOptions = {}, host = currentHost(), resolveProject, projectRemote } = {}) {
  let store; let coordinator;
  const runtime = {
    principal, now, host, stateDir, catalogOptions,
    store() { store ??= openSqliteStore({ dir: stateDir }); return store; },
    ledger: ledger ?? createIssueLeaseClient(),
    coordinator() {
      coordinator ??= createCoordinator({ store: runtime.store(), principal, ledger: runtime.ledger, now, catalogOptions, host,
        ...(resolveProject ? { resolveProject } : {}), ...(projectRemote ? { projectRemote } : {}) });
      return coordinator;
    },
    authorize: op => authorize(principal, op),
    // Append one audit event; never throws (the journal must not take an operation down).
    async audit(op, outcome, code, ids = {}) {
      try {
        await runtime.store().transaction(repo => repo.appendEvent({ at: now(), principal: principal.id,
          workspace_id: ids.workspace_id ?? null, issue_ref: ids.issue ?? null, op, outcome, code: code ?? null }));
      } catch { /* journal unavailable */ }
    },
    async close() { if (store) await store.close(); }
  };
  return runtime;
}

let shared;
export function getRuntime() {
  shared ??= createRuntime();
  return shared;
}
