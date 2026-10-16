// Source Engine V0 persistence: append-only snapshots and canonical current state.
// Added as a v8 migration to the Coordinator's private SQLite WAL database.
export const SOURCE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS source_changes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issue_ref TEXT NOT NULL, worktree_id TEXT, branch TEXT NOT NULL, base_sha TEXT, head_sha TEXT, pr_number INTEGER, ci_state TEXT NOT NULL CHECK (ci_state IN (\'unknown\',\'pending\',\'success\',\'failed\')), landing_state TEXT NOT NULL CHECK (landing_state IN (\'open\',\'queued\',\'blocked\',\'landed\',\'closed\')), source_at INTEGER, revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS source_changes_project ON source_changes(project_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS source_changes_issue ON source_changes(issue_ref)',
  'CREATE TABLE IF NOT EXISTS source_change_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL REFERENCES source_changes(id), event_id TEXT UNIQUE, input_hash TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS source_change_events_change ON source_change_events(change_id, seq)'
].join(';\n') + ';';

const plain = row => row ? { ...row } : null;

export function sourceRepository(db) {
  return {
    getSourceChange(id) {
      return plain(db.prepare('SELECT * FROM source_changes WHERE id = ?').get(id));
    },
    listSourceChanges({ project_id, issue_ref, limit = 30, offset = 0 } = {}) {
      const where = []; const values = [];
      if (project_id) { where.push('project_id = ?'); values.push(project_id); }
      if (issue_ref) { where.push('issue_ref = ?'); values.push(issue_ref); }
      const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
      return db.prepare('SELECT * FROM source_changes' + clause + ' ORDER BY updated_at DESC, id LIMIT ? OFFSET ?')
        .all(...values, limit, offset).map(plain);
    },
    createSourceChange(c) {
      db.prepare('INSERT INTO source_changes (id, project_id, issue_ref, worktree_id, branch, base_sha, head_sha, pr_number, ci_state, landing_state, source_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.id, c.project_id, c.issue_ref, c.worktree_id, c.branch, c.base_sha, c.head_sha, c.pr_number, c.ci_state, c.landing_state, c.source_at, c.revision, c.created_at, c.updated_at);
    },
    updateSourceChange(c, previousRevision) {
      return Number(db.prepare('UPDATE source_changes SET worktree_id = ?, branch = ?, base_sha = ?, head_sha = ?, pr_number = ?, ci_state = ?, landing_state = ?, source_at = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?')
        .run(c.worktree_id, c.branch, c.base_sha, c.head_sha, c.pr_number, c.ci_state, c.landing_state, c.source_at, c.revision, c.updated_at, c.id, previousRevision).changes);
    },
    getSourceEventById(eventId) {
      return plain(db.prepare('SELECT * FROM source_change_events WHERE event_id = ?').get(eventId));
    },
    appendSourceEvent(e) {
      db.prepare('INSERT INTO source_change_events (change_id, event_id, input_hash, revision, snapshot_json, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e.change_id, e.event_id, e.input_hash, e.revision, e.snapshot_json, e.at);
    },
    listSourceEvents(changeId, { after_seq = 0, limit = 50 } = {}) {
      return db.prepare('SELECT * FROM source_change_events WHERE change_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(changeId, after_seq, limit).map(plain);
    }
  };
}
