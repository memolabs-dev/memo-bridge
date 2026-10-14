// Structured handoffs (#39) and learning counters (#38): the SQL of the store's v6 tables. Only
// server/coordinator/store.mjs opens the database; it runs CONTINUITY_SCHEMA in its migration and
// merges continuityRepository(db) into the repository its transactions receive.
//
//   handoffs           one row per recorded handoff: the task, the claim and fence it was written
//                      under, the commit it goes with (optional) and its fields as JSON
//   learning_counters  one row per workspace: tool calls and estimated user turns since the last
//                      memory write or review block, and when those happened
export const CONTINUITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_ref TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  fence_sha TEXT NOT NULL,
  branch TEXT,
  commit_sha TEXT,
  fields_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_issue ON handoffs(issue_ref, id);
CREATE TABLE IF NOT EXISTS learning_counters (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  tool_calls INTEGER NOT NULL DEFAULT 0,
  user_turns INTEGER NOT NULL DEFAULT 0,
  last_call_at INTEGER,
  last_write_at INTEGER,
  last_review_at INTEGER,
  reviews INTEGER NOT NULL DEFAULT 0
);
`;

const plain = row => (row ? { ...row } : null);

export function continuityRepository(db) {
  return {
    insertHandoff(h) {
      db.prepare(`INSERT INTO handoffs (issue_ref, claim_id, workspace_id, fence_sha, branch, commit_sha, fields_json, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(h.issue_ref, h.claim_id, h.workspace_id, h.fence_sha, h.branch ?? null, h.commit_sha ?? null, h.fields_json, h.at);
    },
    // The newest handoff of one task, from any workspace, or null.
    latestHandoff(issueRef) {
      return plain(db.prepare('SELECT * FROM handoffs WHERE issue_ref = ? ORDER BY id DESC LIMIT 1').get(issueRef));
    },
    getLearning(workspaceId) {
      return plain(db.prepare('SELECT * FROM learning_counters WHERE workspace_id = ?').get(workspaceId));
    },
    putLearning(c) {
      db.prepare(`INSERT INTO learning_counters (workspace_id, tool_calls, user_turns, last_call_at, last_write_at, last_review_at, reviews)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET tool_calls = excluded.tool_calls, user_turns = excluded.user_turns,
          last_call_at = excluded.last_call_at, last_write_at = excluded.last_write_at, last_review_at = excluded.last_review_at,
          reviews = excluded.reviews`)
        .run(c.workspace_id, c.tool_calls, c.user_turns, c.last_call_at ?? null, c.last_write_at ?? null, c.last_review_at ?? null,
          c.reviews ?? 0);
    },
    // The active workspace of a principal bound to one conversation, most recently updated, or null.
    sessionWorkspace(principal, clientSession) {
      return plain(db.prepare(`SELECT * FROM workspaces WHERE principal = ? AND client_session = ? AND status = 'active'
        ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(principal, clientSession));
    }
  };
}
