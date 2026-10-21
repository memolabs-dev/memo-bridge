// Owner-wide reads for the reader contract (#252, docs/READER_CONTRACT.md): workspaces, claims,
// jobs and audit events of every principal, filtered by project and by "changed since". Read
// queries only; part of the store contract (tests/coordinator-store-contract.test.mjs).
//
// `since` (ms) keeps a row that changed at or after it, or that is still live (an active
// workspace, a claimed lease, a job in one of `live` statuses). `limit` is the caller's bound;
// callers ask for one more row to know whether the list was cut.
const plain = row => (row ? { ...row } : null);
const marks = list => list.map(() => '?').join(',');

export function readerRepository(db) {
  return {
    readerWorkspaces({ project_id: project = null, since = null, limit }) {
      const where = []; const values = [];
      if (project !== null) { where.push('project_id = ?'); values.push(project); }
      if (since !== null) {
        where.push("(status = 'active' OR updated_at >= ? OR created_at >= ? OR closed_at >= ?)");
        values.push(since, since, since);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM workspaces ${clause} ORDER BY updated_at DESC, id LIMIT ?`).all(...values, limit).map(plain);
    },
    // Claims with the project and principal of their workspace.
    readerClaims({ project_id: project = null, since = null, limit }) {
      const where = []; const values = [];
      if (project !== null) { where.push('w.project_id = ?'); values.push(project); }
      if (since !== null) { where.push("(c.state = 'claimed' OR c.updated_at >= ?)"); values.push(since); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT c.*, w.project_id AS project_id, w.principal AS principal FROM claims c
        JOIN workspaces w ON w.id = c.workspace_id ${clause} ORDER BY c.updated_at DESC, c.claim_id LIMIT ?`)
        .all(...values, limit).map(plain);
    },
    // Jobs with the principal of their workspace and the Issue of their worktree.
    readerJobs({ project_id: project = null, since = null, live = [], limit }) {
      const where = []; const values = [];
      if (project !== null) { where.push('j.project_id = ?'); values.push(project); }
      if (since !== null) {
        const alive = live.length ? `j.status IN (${marks(live)}) OR ` : '';
        where.push(`(${alive}j.created_at >= ? OR j.started_at >= ? OR j.ended_at >= ?)`);
        values.push(...live, since, since, since);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT j.*, w.principal AS workspace_principal, t.issue_ref AS issue_ref FROM jobs j
        JOIN workspaces w ON w.id = j.workspace_id LEFT JOIN worktrees t ON t.id = j.worktree_id
        ${clause} ORDER BY j.created_at DESC, j.id LIMIT ?`).all(...values, limit).map(plain);
    },
    // Audit events after a cursor, oldest first. With a project, only events naming one of its
    // workspaces.
    readerEvents({ project_id: project = null, since = null, after_seq: after = 0, limit }) {
      const where = ['seq > ?']; const values = [after];
      if (since !== null) { where.push('at >= ?'); values.push(since); }
      if (project !== null) { where.push('workspace_id IN (SELECT id FROM workspaces WHERE project_id = ?)'); values.push(project); }
      return db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...values, limit).map(plain);
    },
    // The newest checkpoint recorded under one claim.
    readerLastCheckpoint(claimId) {
      return plain(db.prepare('SELECT * FROM checkpoints WHERE claim_id = ? ORDER BY id DESC LIMIT 1').get(claimId));
    }
  };
}
