// Context memory across conversations (repatriated SentinelX context_*, spec D4): the SQL of the
// store's v5 tables. Only server/coordinator/store.mjs opens the database; it runs MEMORY_SCHEMA in
// its migration and merges memoryRepository(db) into the repository its transactions receive.
//
//   memories          one row per entry: its latest revision
//   memory_revisions  every revision kept (the newest MEMORY_REVISIONS_KEPT), for memory_get
// tags_text is the tags joined with spaces between leading and trailing spaces (" a b "), so a tag
// filter is one LIKE '% a %' with no JSON function needed.
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_text TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('owner','environment')),
  project TEXT,
  host TEXT,
  issue_ref TEXT,
  evidence TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_principal ON memories(principal, updated_at);
CREATE INDEX IF NOT EXISTS memories_project ON memories(principal, project, updated_at);
CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_text TEXT NOT NULL,
  scope TEXT NOT NULL,
  project TEXT,
  host TEXT,
  issue_ref TEXT,
  evidence TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision)
);
`;
export const MEMORY_REVISIONS_KEPT = 20;

const plain = row => (row ? { ...row } : null);
// LIKE with an escape character: the caller's % and _ are literal.
export const likeEscape = text => String(text).replace(/[\\%_]/g, c => `\\${c}`);

export function memoryRepository(db) {
  return {
    getMemory(id) { return plain(db.prepare('SELECT * FROM memories WHERE id = ?').get(id)); },
    countMemories(principal) { return Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE principal = ?').get(principal).n); },
    // m: {id, principal, title, body, tags_text, project, host, issue_ref, revision, created_at, updated_at}
    putMemory(m) {
      const archived = m.archived ? 1 : 0;
      db.prepare(`INSERT INTO memories (id, principal, title, body, tags_text, scope, project, host, issue_ref, evidence, archived, revision,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, tags_text = excluded.tags_text, scope = excluded.scope,
          project = excluded.project, host = excluded.host, issue_ref = excluded.issue_ref, evidence = excluded.evidence,
          archived = excluded.archived, revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(m.id, m.principal, m.title, m.body, m.tags_text, m.scope, m.project ?? null, m.host ?? null, m.issue_ref ?? null,
          m.evidence ?? null, archived, m.revision, m.created_at, m.updated_at);
      db.prepare(`INSERT INTO memory_revisions (memory_id, revision, title, body, tags_text, scope, project, host, issue_ref, evidence,
        archived, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.id, m.revision, m.title, m.body, m.tags_text, m.scope, m.project ?? null, m.host ?? null, m.issue_ref ?? null,
          m.evidence ?? null, archived, m.updated_at);
      db.prepare('DELETE FROM memory_revisions WHERE memory_id = ? AND revision <= ?').run(m.id, m.revision - MEMORY_REVISIONS_KEPT);
    },
    getMemoryRevision(id, revision) {
      return plain(db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? AND revision = ?').get(id, revision));
    },
    listMemoryRevisions(id) {
      return db.prepare('SELECT revision, at FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC').all(id).map(plain);
    },
    // The live (not archived) entries of one budget: a scope, and for environment its key.
    budgetRows({ principal, scope, project = null, host = null }) {
      if (scope === 'owner') return db.prepare("SELECT * FROM memories WHERE principal = ? AND scope = 'owner' AND archived = 0").all(principal).map(plain);
      return project
        ? db.prepare("SELECT * FROM memories WHERE principal = ? AND scope = 'environment' AND archived = 0 AND project = ?").all(principal, project).map(plain)
        : db.prepare("SELECT * FROM memories WHERE principal = ? AND scope = 'environment' AND archived = 0 AND project IS NULL AND host = ?")
          .all(principal, host).map(plain);
    },
    // Live entries with exactly this title or this body (one fact, one entry), case-insensitive title.
    sameFact({ principal, title, body }) {
      return db.prepare('SELECT * FROM memories WHERE principal = ? AND archived = 0 AND (lower(title) = lower(?) OR body = ?)')
        .all(principal, title, body).map(plain);
    },
    // filter: {principal, words: [string], scope, project, host, tag, issue_ref, archived, limit, offset}. Every
    // word must appear in the title, the body or the tags (case-insensitive for ASCII, SQLite LIKE).
    findMemories({ principal, words = [], scope, project, host, tag, issue_ref: issueRef, archived = false, limit, offset = 0 }) {
      const where = ['principal = ?', 'archived = ?']; const values = [principal, archived ? 1 : 0];
      if (scope) { where.push('scope = ?'); values.push(scope); }
      for (const word of words) {
        where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags_text LIKE ? ESCAPE '\\')");
        const like = `%${likeEscape(word)}%`;
        values.push(like, like, like);
      }
      if (project) { where.push('project = ?'); values.push(project); }
      if (host) { where.push('host = ?'); values.push(host); }
      if (issueRef) { where.push('issue_ref = ?'); values.push(issueRef); }
      if (tag) { where.push("tags_text LIKE ? ESCAPE '\\'"); values.push(`% ${likeEscape(tag)} %`); }
      const clause = where.join(' AND ');
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${clause}`).get(...values).n);
      const rows = db.prepare(`SELECT * FROM memories WHERE ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
        .all(...values, limit, offset).map(plain);
      return { total, rows };
    }
  };
}
