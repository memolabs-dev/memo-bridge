// Standalone one-shot Source Engine poller. No MCP/tool caller and NO GitHub writes.
// Enabled only by a private operator-owned configuration; the systemd unit supplies flock.
import { readFile, appendFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../runtime.mjs';
import { listProjects } from '../catalog.mjs';
import { createGitHub } from '../integrations/github.mjs';
import { runSourcePollOnce, validatePollPolicy } from './poll.mjs';

export async function loadPollPolicy(file, { uid = process.getuid?.() } = {}) {
  try {
    const info = await lstat(file); // Refuse symlinks: operator policy must be a private regular file.
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 8192 ||
        (uid !== undefined && info.uid !== uid)) {
      return { ok: false, error: 'policy_permissions_or_size' };
    }
    return validatePollPolicy(JSON.parse(await readFile(file, 'utf8')));
  } catch { return { ok: false, error: 'policy_missing_or_invalid' }; }
}

export function pollBackoffMs(consecutiveFailures) {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  return Math.min(120, 15 * 2 ** Math.min(consecutiveFailures - 1, 4)) * 60_000;
}

export function backoffDecision(receipts, at = Date.now()) {
  if (!Array.isArray(receipts) || !receipts.length) return { delay_ms: 0, retry_after: null };
  let failures = 0, last = null;
  for (const row of receipts.slice(-20).reverse()) {
    if (!row || typeof row !== 'object' || row.ok !== false || !Number.isFinite(Date.parse(row.at))) break;
    failures++;
    if (!last) last = Date.parse(row.at);
  }
  const delay = pollBackoffMs(failures);
  const until = last === null ? null : last + delay;
  return { delay_ms: Math.max(0, (until ?? at) - at),
    retry_after: until && until > at ? new Date(until).toISOString() : null };
}

async function recentReceipts(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) return [];
    const lines = (await readFile(file, 'utf8')).trim().split('\n').slice(-20);
    return lines.flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });
  } catch { return []; }
}

export async function main({ runtime = createRuntime(), print = line => process.stdout.write(line + '\n') } = {}) {
  try {
    const policyFile = join(runtime.stateDir, 'source-poll-policy.json');
    const loaded = await loadPollPolicy(policyFile);
    if (!loaded.ok) { print(JSON.stringify(loaded)); return 2; }
    if (!loaded.policy.enabled) { print(JSON.stringify({ ok: false, error: 'disabled' })); return 2; }
    const receiptFile = join(runtime.stateDir, 'source-poll-receipts.jsonl');
    const backoff = backoffDecision(await recentReceipts(receiptFile), runtime.now());
    if (backoff.delay_ms) {
      print(JSON.stringify({ ok: false, error: 'retry_backoff', retry_after: backoff.retry_after }));
      return 75;
    }
    const gh = createGitHub({
      catalogOptions: runtime.catalogOptions, now: runtime.now,
      credentials: runtime.githubCredentials, scratchDir: join(runtime.stateDir, 'gh-pr')
    });
    const outcome = await runSourcePollOnce({
      store: runtime.store(), github: gh,
      catalog: filters => listProjects(filters, runtime.catalogOptions),
      policy: loaded.policy, now: runtime.now
    });
    const receipt = { at: new Date(runtime.now()).toISOString(), ok: outcome.ok,
      dry_run: outcome.dry_run ?? true, results: (outcome.projects ?? []).map(p => ({
        project: p.project, ok: p.ok, error: p.error ?? null,
        discovered: p.discovery?.recorded ?? p.recorded ?? 0,
        reconciled: p.reconciliation?.committed ?? 0
      })) };
    await appendFile(receiptFile, JSON.stringify(receipt) + '\n', { mode: 0o600 });
    await runtime.audit('source_poll', outcome.ok ? 'ok' : 'error',
      outcome.ok ? null : 'source_poll_failed');
    print(JSON.stringify(receipt));
    return outcome.ok ? 0 : 1;
  } finally { await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('source_poll_failed\n');
    process.exitCode = 1;
  });
}
