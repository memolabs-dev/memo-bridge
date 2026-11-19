// Child process used by the concurrency tests: one process = one MCP client session with its
// own SQLite connection, racing through the canonical ledger.
import { createIssueLeaseClient } from '../../server/coordinator/issue-lease.mjs';
import { readFileSync } from 'node:fs';
import { inspectDependencies } from '../../server/task-dependencies.mjs';
import { privateReceiptVerifier } from '../../server/task-acceptance-receipts.mjs';
import { GOVERNANCE_ROOT, FAKE_GH_DIR, coordinatorOn } from './coordinator-fixture.mjs';

const [stateDir, githubState, receiptRoot] = process.argv.slice(2);
const verifyNow = Date.parse('2026-10-23T12:00:00Z');
const tasks = receiptRoot ? {
  dependencyProtection: true,
  dependencyCheck: issue => inspectDependencies(issue, {
    now: verifyNow,
    loadIssue: async ref => {
      const data = JSON.parse(readFileSync(githubState, 'utf8')).issues?.[ref];
      return data ? { ref, state: data.state ?? 'open', body: data.body ?? '',
        updated_at: data.updated_at ?? null, closed_at: data.closed_at ?? null,
        observed_at: new Date(verifyNow).toISOString(), authorized: true } : null;
    },
    verifyAcceptance: privateReceiptVerifier({ stateDir: receiptRoot, now: () => verifyNow })
  })
} : {};
const ledger = createIssueLeaseClient({ root: GOVERNANCE_ROOT, timeoutMs: 30000,
  env: { ...process.env, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, FAKE_GH_STATE: githubState } });
const { store, coordinator } = coordinatorOn(stateDir, { ledger, tasks });
const opened = await coordinator.workspaceOpen({ project: 'drop', client_type: 'chatgpt', client_label: `worker ${process.pid}` });
process.send({ type: 'ready', workspace: opened });

process.on('message', async message => {
  if (message.type === 'claim') {
    const claim = await coordinator.taskClaim({ workspace_id: opened.workspace.workspace_id, issue: message.issue, ttl_seconds: 600 });
    process.send({ type: 'claimed', claim });
  }
  if (message.type === 'exit') {
    await store.close();
    process.exit(0);
  }
});
