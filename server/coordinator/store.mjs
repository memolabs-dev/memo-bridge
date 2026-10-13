// Storage contract for the Coordinator's local state (workspaces, claim mirror, checkpoints, audit). This is the only module that knows the engine.
// Callers use `transaction(fn)` and the repository methods passed to `fn`; they never
// write SQL. A future Postgres adapter must provide the same contract and pass
// tests/coordinator-store-contract.test.mjs.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const SCHEMA_VERSION = 1;
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

const WORKSPACE_COLUMNS = ['status', 'branch', 'updated_at', 'closed_at'];
const CLAIM_COLUMNS = ['fence_sha', 'expires_at', 'state', 'outcome', 'updated_at'];

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
        created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(w.id, w.principal, w.client_type, w.client_label ?? null, w.project_id, w.host, w.branch ?? null,
          w.status, w.created_at, w.updated_at);
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
    appendEvent(e) {
      db.prepare(`INSERT INTO events (at, principal, workspace_id, issue_ref, op, outcome, code)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(e.at, e.principal, e.workspace_id ?? null, e.issue_ref ?? null, e.op, e.outcome, e.code ?? null);
    },
    listEvents({ principal, issue_ref, workspace_id, limit }) {
      const where = []; const values = [];
      if (principal) { where.push('principal = ?'); values.push(principal); }
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
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (current < 1) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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
  const repo = repository(db);
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
