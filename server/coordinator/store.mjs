// Storage contract for the Coordinator's local state (workspaces, claim mirror, checkpoints, audit). This is the only module that knows the engine.
// Callers use `transaction(fn)` and the repository methods passed to `fn`; they never
// write SQL. A future Postgres adapter must provide the same contract and pass
// tests/coordinator-store-contract.test.mjs.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MEMORY_SCHEMA, memoryRepository } from './memory-store.mjs';
import { CONTINUITY_SCHEMA, continuityRepository } from './continuity-store.mjs';
import { delegationRepository, migrateV7 } from './delegation-store.mjs';
import { SOURCE_SCHEMA, sourceRepository } from './source-store.mjs';

// v5: context memory across conversations (server/coordinator/memory-store.mjs), additive.
// v6: structured handoffs and learning counters (server/coordinator/continuity-store.mjs), additive.
// v9: partial UNIQUE indexes on live rows (one claimed row per Issue, one active worktree per
// branch and per path of a host), so the store itself refuses what two parallel sessions of one
// host must never share.
export const SCHEMA_VERSION = 9;
const DB_FILE = 'coordinator.sqlite';

export function defaultStateDir(env = process.env) {
  if (env.MEMO_BRIDGE_STATE_DIR) return env.MEMO_BRIDGE_STATE_DIR;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'memo-bridge');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'memo-bridge');
}

function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpathSync(current);
}

function isGitDir(path) {
  if (existsSync(join(path, '.git'))) return true;
  // Bare repositories have no .git entry; recognise their layout instead.
  return existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')) && existsSync(join(path, 'refs'));
}

// Operational state must never land in iCloud or another synced folder, a repository or a
// shared worktree. macOS volumes are usually case-insensitive, so compare lowercased paths.
export function assertPrivateLocation(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('state_dir_not_absolute');
  const real = nearestExisting(dir);
  const synced = p => {
    const lower = p.toLowerCase();
    return lower.includes(`${sep}mobile documents`) || lower.includes(`${sep}icloud drive`) ||
      lower.includes(`${sep}library${sep}cloudstorage${sep}`) || lower.endsWith(`${sep}library${sep}cloudstorage`);
  };
  if (synced(resolve(dir)) || synced(real)) throw new Error('state_dir_in_synced_folder');
  let current = real;
  for (;;) {
    if (isGitDir(current)) throw new Error('state_dir_in_git_repository');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  client_type TEXT NOT NULL,
  client_label TEXT,
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
-- Local mirror of claims held by this machine's workspaces. The authority is the Git-ref
-- ledger in memolabs-dev/.github (scripts/issue_lease.py); this table only remembers which
-- workspace holds which claim so the session can resume and close cleanly.
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  issue_ref TEXT NOT NULL,
  fence_sha TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed','released')),
  outcome TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_workspace ON claims(workspace_id, state);
CREATE INDEX IF NOT EXISTS claims_issue ON claims(issue_ref);
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_ref TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  fence_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  durability TEXT NOT NULL CHECK (durability IN ('remote','local_only','unverified')),
  note TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_issue ON checkpoints(issue_ref, id);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  principal TEXT NOT NULL,
  workspace_id TEXT,
  issue_ref TEXT,
  op TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  code TEXT
);
CREATE INDEX IF NOT EXISTS events_issue ON events(issue_ref, seq);
CREATE INDEX IF NOT EXISTS events_workspace ON events(workspace_id, seq);
`;

// v2: runner state (Phase 3). Worktrees and jobs belong to a workspace; job events are append-only.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  issue_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS worktrees_workspace ON worktrees(workspace_id, status);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  recipe TEXT NOT NULL,
  argv_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out','interrupted')),
  exit_code INTEGER,
  pid INTEGER,
  timeout_ms INTEGER NOT NULL,
  log_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS jobs_workspace ON jobs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(host, status);
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);
`;

// v3: VPS runner (Phase 4). SQLite cannot change a CHECK constraint in place, so the jobs
// table is rebuilt with the new statuses and columns, keeping every row
// (https://www.sqlite.org/lang_altertable.html, "Making Other Kinds Of Table Schema Changes").
//   deferred         admission said no (pressure, disk); retried by the supervisor
//   dispatched       handed to the root dispatcher (spool file written), unit not seen yet
//   oom, budget_exceeded  final statuses from systemd (OOM killer) and the disk budget
//   claim_id         the claim the job was submitted under; the supervisor renews it
//   unit             memo-job@<id>.service for jobs run by the systemd executor, NULL on the Mac
//   limits_json      the budgets recorded for the job (context record)
//   release_on_finish  release the claim once the job ends (0/1)
//   principal        who submitted it; the supervisor acts for that principal
//   status_reason    why a job is deferred, or why it ended (stale_lease, dispatch_refused...)
// requests: idempotency of mutating operations by client_request_id; the first result wins.
export const JOB_STATUS_VALUES = Object.freeze(['queued', 'deferred', 'dispatched', 'running', 'succeeded', 'failed',
  'cancelled', 'timed_out', 'oom', 'budget_exceeded', 'interrupted']);
const JOBS_V2_COLUMNS = ['id', 'workspace_id', 'worktree_id', 'project_id', 'host', 'recipe', 'argv_json', 'status', 'exit_code',
  'pid', 'timeout_ms', 'log_path', 'created_at', 'started_at', 'ended_at', 'summary'];
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS requests (
  key TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  op TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
CREATE TABLE jobs_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  project_id TEXT NOT NULL,
  host TEXT NOT NULL,
  recipe TEXT NOT NULL,
  argv_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${JOB_STATUS_VALUES.map(s => `'${s}'`).join(',')})),
  exit_code INTEGER,
  pid INTEGER,
  timeout_ms INTEGER NOT NULL,
  log_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  summary TEXT,
  claim_id TEXT,
  unit TEXT,
  limits_json TEXT,
  release_on_finish INTEGER NOT NULL DEFAULT 0 CHECK (release_on_finish IN (0,1)),
  principal TEXT,
  status_reason TEXT
);
INSERT INTO jobs_v3 (${JOBS_V2_COLUMNS.join(', ')}) SELECT ${JOBS_V2_COLUMNS.join(', ')} FROM jobs ORDER BY rowid;
DROP TABLE jobs;
ALTER TABLE jobs_v3 RENAME TO jobs;
CREATE INDEX IF NOT EXISTS jobs_workspace ON jobs(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(host, status);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(host, status, created_at, id);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(claim_id, status);
`;

// v4: remote clients (Phase 5). Additive only, so a v3 database keeps every row:
//   events.via          'stdio' | 'hub' when the principal says where it came from
//   events.client_type  the client kind derived by the server (D6), never from arguments
//   events.request_id   the hub's request id: joins the hub journal line and this event
//   workspaces.client_session  hash of the conversation hint recorded at workspace_open (D8)
// ALTER TABLE ADD COLUMN is applied only to a column that is missing: a database rewound to an
// older user_version (tests, a partial restore) may already have them.
const V4_COLUMNS = Object.freeze([
  ['events', 'via', 'TEXT'], ['events', 'client_type', 'TEXT'], ['events', 'request_id', 'TEXT'],
  ['workspaces', 'client_session', 'TEXT']
]);
function migrateV4(db) {
  for (const [table, column, type] of V4_COLUMNS) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS events_request ON events(request_id)');
}

// v9: the SQLite mirror is shared by every workspace of a host, so a live row must be unique.
// Duplicates left by an older server are settled before the indexes exist: claim rows whose
// lease already ran out are closed ('released', outcome 'expired') keeping the newest by epoch
// then updated_at; anything still unexpired, and every duplicate active worktree, is refused
// (state_duplicate_live_rows, error.rows = [{ table, key, ids }]) and the transaction rolls
// back, leaving the store at v8 with its rows intact.
function migrateV9(db, now = Date.now()) {
  const refused = [];
  const dupes = (sql, ...columns) => db.prepare(sql).all().map(r => ({ key: columns.map(c => r[c]).join('|'), ids: String(r.ids).split('\u0001') }));
  const claimIssues = db.prepare("SELECT issue_ref FROM claims WHERE state = 'claimed' GROUP BY issue_ref HAVING COUNT(*) > 1").all();
  for (const { issue_ref: issue } of claimIssues) {
    const rows = db.prepare("SELECT claim_id, epoch, expires_at, updated_at FROM claims WHERE state = 'claimed' AND issue_ref = ?").all(issue)
      .map(r => ({ ...r, epoch: Number(r.epoch), updated_at: Number(r.updated_at) }));
    // An unparseable expiry is treated as unexpired: refuse rather than guess.
    const live = rows.filter(r => !(Date.parse(r.expires_at) <= now));
    if (live.length > 1) { refused.push({ table: 'claims', key: issue, ids: live.map(r => r.claim_id) }); continue; }
    const keep = live[0] ?? [...rows].sort((a, b) => b.epoch - a.epoch || b.updated_at - a.updated_at || (a.claim_id < b.claim_id ? 1 : -1))[0];
    for (const r of rows) {
      if (r.claim_id === keep.claim_id) continue;
      db.prepare("UPDATE claims SET state = 'released', outcome = 'expired', updated_at = ? WHERE claim_id = ?").run(now, r.claim_id);
    }
  }
  const sep = '\u0001';
  for (const [columns, sql] of [
    [['project_id', 'host', 'branch'], `SELECT project_id, host, branch, GROUP_CONCAT(id, '${sep}') AS ids FROM worktrees WHERE status = 'active' GROUP BY project_id, host, branch HAVING COUNT(*) > 1`],
    [['host', 'path'], `SELECT host, path, GROUP_CONCAT(id, '${sep}') AS ids FROM worktrees WHERE status = 'active' GROUP BY host, path HAVING COUNT(*) > 1`]
  ]) refused.push(...dupes(sql, ...columns).map(d => ({ table: 'worktrees', ...d })));
  if (refused.length) throw Object.assign(new Error('state_duplicate_live_rows'), { rows: refused });
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS claims_live_issue ON claims(issue_ref) WHERE state = 'claimed';
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_live_branch ON worktrees(project_id, host, branch) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_live_path ON worktrees(host, path) WHERE status = 'active';`);
}

// The idempotency key of a mutating call: sha256(principal|op|client_request_id), the same
// derivation the hub uses, so a retry through either path finds the first result.
export const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export function requestKey(principalId, op, clientRequestId) {
  return createHash('sha256').update(`${principalId}|${op}|${clientRequestId}`).digest('hex');
}

// Run a mutating operation once per client_request_id (REQ-P4-07, Phase 4 FU-5, REQ-P5-15).
// - a stored first result is returned as is, with replayed: true, and `run` is not called;
// - a retry that arrives while the first call is still running in this process waits for it
//   and gets the same result (the soft deadline path answers 'accepted' and the model retries);
// - only a successful result is stored: a refusal or a failure can be retried for real.
// Results kept in the requests table must stay small (ids, shas, URLs).
const inflight = new WeakMap(); // store -> Map(key -> Promise)
export async function runOnce(store, { principal, op, clientRequestId, now = Date.now() }, run) {
  if (clientRequestId === undefined || clientRequestId === null) return run();
  if (!CLIENT_REQUEST_ID_RE.test(String(clientRequestId))) return { ok: false, error: 'invalid_input', detail: 'client_request_id' };
  const key = requestKey(principal, op, clientRequestId);
  const decode = row => { try { return { ...JSON.parse(row.result_json), replayed: true }; } catch { return { ok: false, error: 'store_unavailable' }; } };
  const first = await store.transaction(repo => repo.getRequest(key), { write: false });
  if (first) return decode(first);
  let running = inflight.get(store);
  if (!running) { running = new Map(); inflight.set(store, running); }
  if (running.has(key)) return { ...(await running.get(key)), replayed: true };
  const attempt = (async () => {
    const result = await run();
    if (result?.ok === true) {
      const stored = await store.transaction(repo => {
        repo.insertRequest({ key, principal, op, result_json: JSON.stringify(result), created_at: now });
        return repo.getRequest(key);
      }).catch(() => null);
      // Another process recorded a result first: the first result wins.
      if (stored && stored.result_json !== JSON.stringify(result)) return decode(stored);
    }
    return result;
  })();
  running.set(key, attempt);
  try { return await attempt; } finally { running.delete(key); }
}

// project_id: task_next may move an idle workspace to the project of the task it takes (multi-session D-MS7).
// delegation_id: a child workspace names its delegation (#47, delegation spec D1).
const WORKSPACE_COLUMNS = ['status', 'branch', 'updated_at', 'closed_at', 'client_session', 'project_id', 'delegation_id'];
const CLAIM_COLUMNS = ['fence_sha', 'expires_at', 'state', 'outcome', 'updated_at'];
const WORKTREE_COLUMNS = ['status', 'issue_ref', 'updated_at', 'removed_at'];
const JOB_COLUMNS = ['status', 'exit_code', 'pid', 'started_at', 'ended_at', 'summary', 'unit', 'status_reason'];

function setClause(patch, allowed) {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(k => !allowed.includes(k))) throw new Error('invalid_patch');
  return { sql: keys.map(k => `${k} = ?`).join(', '), values: keys.map(k => patch[k] ?? null) };
}
const plain = row => (row ? { ...row } : null);

function repository(db) {
  return {
    insertWorkspace(w) {
      db.prepare(`INSERT INTO workspaces (id, principal, client_type, client_label, project_id, host, branch, status,
        created_at, updated_at, closed_at, client_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(w.id, w.principal, w.client_type, w.client_label ?? null, w.project_id, w.host, w.branch ?? null,
          w.status, w.created_at, w.updated_at, w.client_session ?? null);
    },
    getWorkspace(id) { return plain(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)); },
    listWorkspaces({ principal, status, limit }) {
      const where = ['principal = ?']; const values = [principal];
      if (status) { where.push('status = ?'); values.push(status); }
      return db.prepare(`SELECT * FROM workspaces WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id LIMIT ?`)
        .all(...values, limit).map(plain);
    },
    updateWorkspace(id, patch) {
      const { sql, values } = setClause(patch, WORKSPACE_COLUMNS);
      return Number(db.prepare(`UPDATE workspaces SET ${sql} WHERE id = ?`).run(...values, id).changes);
    },
    insertClaim(c) {
      db.prepare(`INSERT INTO claims (claim_id, workspace_id, issue_ref, fence_sha, epoch, expires_at, state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?)`)
        .run(c.claim_id, c.workspace_id, c.issue_ref, c.fence_sha, c.epoch, c.expires_at, c.updated_at);
    },
    getClaim(claimId) { return plain(db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId)); },
    claimsOf(workspaceId, state) {
      return db.prepare(`SELECT * FROM claims WHERE workspace_id = ?${state ? ' AND state = ?' : ''} ORDER BY updated_at`)
        .all(...(state ? [workspaceId, state] : [workspaceId])).map(plain);
    },
    // Every recorded claim on one Issue, any workspace, newest first (batch_status, task_next).
    claimsOfIssue(issueRef, limit = 20) {
      return db.prepare('SELECT * FROM claims WHERE issue_ref = ? ORDER BY updated_at DESC LIMIT ?').all(issueRef, limit).map(plain);
    },
    // Compare-and-set on the fence so an outdated local view never overwrites a newer one.
    updateClaim(claimId, patch, expectedFence) {
      const { sql, values } = setClause(patch, CLAIM_COLUMNS);
      return Number(db.prepare(`UPDATE claims SET ${sql} WHERE claim_id = ? AND fence_sha = ?`)
        .run(...values, claimId, expectedFence).changes);
    },
    insertCheckpoint(c) {
      db.prepare(`INSERT INTO checkpoints (issue_ref, claim_id, workspace_id, fence_sha, branch, commit_sha, durability, note, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.issue_ref, c.claim_id, c.workspace_id, c.fence_sha, c.branch, c.commit_sha, c.durability, c.note ?? null, c.at);
    },
    listCheckpoints(issueRef, limit) {
      return db.prepare('SELECT * FROM checkpoints WHERE issue_ref = ? ORDER BY id DESC LIMIT ?').all(issueRef, limit).map(plain);
    },
    insertWorktree(w) {
      db.prepare(`INSERT INTO worktrees (id, workspace_id, project_id, host, path, branch, base_ref, base_commit, issue_ref,
        status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(w.id, w.workspace_id, w.project_id, w.host, w.path, w.branch, w.base_ref, w.base_commit, w.issue_ref ?? null,
          w.created_at, w.updated_at);
    },
    getWorktree(id) { return plain(db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id)); },
    listWorktrees({ workspace_id, project_id, status, issue_ref, limit = 100 } = {}) {
      const where = []; const values = [];
      if (issue_ref) { where.push('issue_ref = ?'); values.push(issue_ref); }
      if (workspace_id) { where.push('workspace_id = ?'); values.push(workspace_id); }
      if (project_id) { where.push('project_id = ?'); values.push(project_id); }
      if (status) { where.push('status = ?'); values.push(status); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM worktrees ${clause} ORDER BY created_at DESC, id LIMIT ?`).all(...values, limit).map(plain);
    },
    updateWorktree(id, patch) {
      const { sql, values } = setClause(patch, WORKTREE_COLUMNS);
      return Number(db.prepare(`UPDATE worktrees SET ${sql} WHERE id = ?`).run(...values, id).changes);
    },
    insertJob(j) {
      db.prepare(`INSERT INTO jobs (id, workspace_id, worktree_id, project_id, host, recipe, argv_json, status, timeout_ms,
        log_path, created_at, claim_id, unit, limits_json, release_on_finish, principal)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(j.id, j.workspace_id, j.worktree_id, j.project_id, j.host, j.recipe, j.argv_json, j.timeout_ms, j.log_path, j.created_at,
          j.claim_id ?? null, j.unit ?? null, j.limits_json ?? null, j.release_on_finish ? 1 : 0, j.principal ?? null);
    },
    getJob(id) { return plain(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)); },
    listJobs({ workspace_id, host, status, claim_id, limit = 50 } = {}) {
      const where = []; const values = [];
      if (workspace_id) { where.push('workspace_id = ?'); values.push(workspace_id); }
      if (host) { where.push('host = ?'); values.push(host); }
      if (status) { where.push('status = ?'); values.push(status); }
      if (claim_id) { where.push('claim_id = ?'); values.push(claim_id); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC, id LIMIT ?`).all(...values, limit).map(plain);
    },
    // The FIFO queue of one host: jobs in the given statuses, oldest first (insertion order
    // breaks ties within the same millisecond).
    listQueue({ host, statuses, limit = 100 }) {
      const list = statuses.filter(s => JOB_STATUS_VALUES.includes(s));
      if (!list.length) return [];
      return db.prepare(`SELECT * FROM jobs WHERE host = ? AND status IN (${list.map(() => '?').join(',')})
        ORDER BY created_at, rowid LIMIT ?`).all(host, ...list, limit).map(plain);
    },
    countJobs({ host, statuses }) {
      const list = statuses.filter(s => JOB_STATUS_VALUES.includes(s));
      if (!list.length) return 0;
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE host = ? AND status IN (${list.map(() => '?').join(',')})`)
        .get(host, ...list).n);
    },
    getRequest(key) { return plain(db.prepare('SELECT * FROM requests WHERE key = ?').get(key)); },
    // INSERT OR IGNORE: under the write lock the first insert wins; callers read back with getRequest.
    insertRequest(r) {
      return Number(db.prepare('INSERT OR IGNORE INTO requests (key, principal, op, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(r.key, r.principal, r.op, r.result_json, r.created_at).changes);
    },
    pruneRequests(before) {
      return Number(db.prepare('DELETE FROM requests WHERE created_at < ?').run(before).changes);
    },
    // Compare-and-set on status so two processes never both move a job forward.
    updateJob(id, patch, expectedStatus) {
      const { sql, values } = setClause(patch, JOB_COLUMNS);
      const guard = expectedStatus ? ' AND status = ?' : '';
      return Number(db.prepare(`UPDATE jobs SET ${sql} WHERE id = ?${guard}`)
        .run(...values, id, ...(expectedStatus ? [expectedStatus] : [])).changes);
    },
    appendJobEvent(e) {
      db.prepare('INSERT INTO job_events (job_id, at, kind, detail) VALUES (?, ?, ?, ?)').run(e.job_id, e.at, e.kind, e.detail ?? null);
    },
    listJobEvents(jobId, afterSeq = 0, limit = 200) {
      return db.prepare('SELECT * FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(jobId, afterSeq, limit).map(plain);
    },
    getEvent(seq) { return plain(db.prepare('SELECT * FROM events WHERE seq = ?').get(seq)); },
    appendEvent(e) {
      db.prepare(`INSERT INTO events (at, principal, workspace_id, issue_ref, op, outcome, code, via, client_type, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.at, e.principal, e.workspace_id ?? null, e.issue_ref ?? null, e.op, e.outcome, e.code ?? null,
          e.via ?? null, e.client_type ?? null, e.request_id ?? null);
    },
    listEvents({ principal, issue_ref, workspace_id, request_id, with_request_id = false, limit }) {
      const where = []; const values = [];
      if (principal) { where.push('principal = ?'); values.push(principal); }
      if (request_id) { where.push('request_id = ?'); values.push(request_id); }
      if (with_request_id) where.push('request_id IS NOT NULL');
      if (issue_ref) { where.push('issue_ref = ?'); values.push(issue_ref); }
      if (workspace_id) { where.push('workspace_id = ?'); values.push(workspace_id); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM events ${clause} ORDER BY seq DESC LIMIT ?`).all(...values, limit).map(plain);
    }
  };
}

function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION) throw new Error('state_schema_newer_than_code');
  if (version === SCHEMA_VERSION) return;
  // The v3 rebuild drops and renames the jobs table that job_events references. Foreign keys
  // are switched off for that (the pragma is a no-op inside a transaction, so before BEGIN),
  // checked with foreign_key_check before COMMIT, and switched back on whatever happens.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have migrated while this one waited for the lock.
      const current = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (current > SCHEMA_VERSION) throw new Error('state_schema_newer_than_code');
      if (current < 1) db.exec(SCHEMA);
      if (current < 2) db.exec(SCHEMA_V2);
      if (current < 3) db.exec(SCHEMA_V3);
      if (current < 4) migrateV4(db);
      if (current < 5) db.exec(MEMORY_SCHEMA);
      if (current < 6) db.exec(CONTINUITY_SCHEMA);
      if (current < 7) migrateV7(db);
      if (current < 8) db.exec(SOURCE_SCHEMA);
      if (current < 9) migrateV9(db);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('state_foreign_key_violation');
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Switching a brand-new file to WAL takes an exclusive lock that the busy handler does not
// cover, so sessions opening a fresh store at the same moment retry with a short backoff.
function withOpenRetry(fn, attempts = 40) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (error) {
      if (i >= attempts || !/locked|busy/i.test(String(error?.message))) throw error;
      pause(10 + Math.floor(Math.random() * 40));
    }
  }
}

export function openSqliteStore({ dir = defaultStateDir(), busyTimeoutMs = 5000 } = {}) {
  assertPrivateLocation(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } else if ((statSync(dir).mode & 0o077) !== 0) {
    // Never re-mode a directory someone else created; refuse it instead.
    throw new Error('state_dir_not_private');
  }
  const file = join(dir, DB_FILE);
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600);
  const timeout = Math.max(0, Math.trunc(Number(busyTimeoutMs) || 0));
  const db = new DatabaseSync(file, { timeout });
  try {
    // Belt and braces with the constructor option (Node 22.16+): the busy handler must be set.
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    withOpenRetry(() => db.exec('PRAGMA journal_mode = WAL'));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    withOpenRetry(() => migrate(db));
  } catch (error) {
    db.close();
    throw error;
  }
  const repo = { ...repository(db), ...memoryRepository(db), ...continuityRepository(db), ...delegationRepository(db), ...sourceRepository(db) };
  // One connection per process: serialize transactions so concurrent MCP calls in the same
  // process never interleave inside BEGIN/COMMIT. Cross-process exclusion is SQLite's lock.
  let queue = Promise.resolve();
  let closed = false;

  return {
    engine: 'sqlite',
    file,
    // Writes take the write lock up front (BEGIN IMMEDIATE) so check-then-write is atomic
    // across processes; reads use a deferred transaction and keep WAL's concurrent readers.
    transaction(fn, { write = true } = {}) {
      const run = queue.then(async () => {
        if (closed) throw new Error('store_closed');
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        let open = true;
        try {
          const value = await fn(repo);
          db.exec('COMMIT');
          open = false;
          return value;
        } catch (error) {
          // Tracked locally: database.isTransaction does not exist on every supported Node.
          if (open) { try { db.exec('ROLLBACK'); } catch { /* connection already reset */ } }
          throw error;
        }
      });
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      await queue;
      if (!closed) { closed = true; db.close(); }
    },
    permissions() {
      return { dir: statSync(dir).mode & 0o777, file: statSync(file).mode & 0o777 };
    },
    settings() {
      return {
        journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        busy_timeout: Number(Object.values(db.prepare('PRAGMA busy_timeout').get())[0]),
        foreign_keys: Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys),
        schema_version: Number(db.prepare('PRAGMA user_version').get().user_version)
      };
    }
  };
}
