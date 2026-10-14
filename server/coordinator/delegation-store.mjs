// Delegations (#47, .agent/project/delegation/spec.md D1): the SQL of the store's v7 tables. Only
// server/coordinator/store.mjs opens the database; it runs DELEGATION_SCHEMA and the v7 column in
// its migration and merges delegationRepository(db) into the repository its transactions receive.
//
//   delegations   one row per delegation: the parent workspace, the task and the parent's claim id
//                 (never shown to a child), the scope, the child workspace once joined, the end, and
//                 the child's latest report
//   fence_moves   fences a child write moved on the parent's behalf (lease renewal, D4), so the
//                 parent's next call with the fence it last saw is still recognised
export const DELEGATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  parent_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  issue_ref TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT,
  scope_mode TEXT NOT NULL,
  scope_paths TEXT NOT NULL DEFAULT '[]',
  brief TEXT,
  status TEXT NOT NULL,
  child_workspace_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  joined_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  report_json TEXT,
  report_at INTEGER,
  report_final INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parent_workspace_id, created_at);
CREATE INDEX IF NOT EXISTS delegations_child ON delegations(child_workspace_id);
CREATE TABLE IF NOT EXISTS fence_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  from_fence TEXT NOT NULL,
  to_fence TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fence_moves_claim ON fence_moves(claim_id, to_fence);
`;

export function migrateV7(db) {
  const present = db.prepare('PRAGMA table_info(workspaces)').all().some(c => c.name === 'delegation_id');
  if (!present) db.exec('ALTER TABLE workspaces ADD COLUMN delegation_id TEXT');
  db.exec(DELEGATION_SCHEMA);
}

const DELEGATION_COLUMNS = ['status', 'child_workspace_id', 'joined_at', 'ended_at', 'end_reason', 'report_json', 'report_at',
  'report_final'];
const plain = row => (row ? { ...row } : null);

export function delegationRepository(db) {
  return {
    insertDelegation(d) {
      db.prepare(`INSERT INTO delegations (id, principal, parent_workspace_id, issue_ref, claim_id, worktree_id, scope_mode,
        scope_paths, brief, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(d.id, d.principal, d.parent_workspace_id, d.issue_ref, d.claim_id, d.worktree_id ?? null, d.scope_mode,
          JSON.stringify(d.scope_paths ?? []), d.brief ?? null, d.created_at, d.expires_at);
    },
    getDelegation(id) { return plain(db.prepare('SELECT * FROM delegations WHERE id = ?').get(id)); },
    // Compare-and-set on the status when `expectedStatus` is given; returns the number of rows changed.
    updateDelegation(id, patch, expectedStatus = null) {
      const keys = Object.keys(patch);
      if (!keys.length || keys.some(k => !DELEGATION_COLUMNS.includes(k))) throw new Error('invalid_patch');
      const sql = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => patch[k] ?? null);
      const where = expectedStatus ? 'id = ? AND status = ?' : 'id = ?';
      return Number(db.prepare(`UPDATE delegations SET ${sql} WHERE ${where}`)
        .run(...values, id, ...(expectedStatus ? [expectedStatus] : [])).changes);
    },
    // A parent's delegations, newest first.
    delegationsOf(parentWorkspaceId, limit = 50) {
      return db.prepare('SELECT * FROM delegations WHERE parent_workspace_id = ? ORDER BY created_at DESC, id LIMIT ?')
        .all(parentWorkspaceId, limit).map(plain);
    },
    // The most recently created workspace of a principal bound to one conversation, any status.
    latestSessionWorkspace(principal, clientSession) {
      return plain(db.prepare(`SELECT * FROM workspaces WHERE principal = ? AND client_session = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(principal, clientSession));
    },
    insertFenceMove(m) {
      db.prepare('INSERT INTO fence_moves (claim_id, from_fence, to_fence, at) VALUES (?, ?, ?, ?)')
        .run(m.claim_id, m.from_fence, m.to_fence, m.at);
    },
    // The fences recorded as moved to `toFence` for one claim (D4 chain walk).
    fenceMovesTo(claimId, toFence) {
      return db.prepare('SELECT from_fence FROM fence_moves WHERE claim_id = ? AND to_fence = ? LIMIT 10')
        .all(claimId, toFence).map(r => r.from_fence);
    }
  };
}
