// Durable, local-only landing queue metadata. Never stores credentials or GitHub responses.
export const LANDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_landing_queue (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','landed','blocked','cancelled')),
  lease_id TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, pr_number)
);
CREATE INDEX IF NOT EXISTS source_landing_queue_fifo
  ON source_landing_queue (repo, status, enqueued_at, pr_number);
`;

const plain = row => row ? { ...row } : null;

export function landingRepository(db) {
  return {
    getLanding(repo, pr_number) {
      return plain(db.prepare('SELECT * FROM source_landing_queue WHERE repo = ? AND pr_number = ?').get(repo, pr_number));
    },
    insertLanding(row) {
      db.prepare(`INSERT INTO source_landing_queue
      (repo, pr_number, head_sha, base_sha, base_ref, status, enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(row.repo, row.pr_number, row.head_sha, row.base_sha, row.base_ref, row.enqueued_at, row.updated_at);
    },
    firstLanding(repo) {
      return plain(db.prepare(`SELECT * FROM source_landing_queue
        WHERE repo = ? AND status IN ('queued','leased')
        ORDER BY enqueued_at, pr_number LIMIT 1`).get(repo));
    },
    updateLandingLease(repo, pr_number, lease_id, lease_owner, expiry, at) {
      return db.prepare(`UPDATE source_landing_queue SET status = 'leased', lease_id = ?,
          lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE repo = ? AND pr_number = ? AND status IN ('queued','leased')`)
        .run(lease_id, lease_owner, expiry, at, repo, pr_number).changes;
    },
    completeLanding(repo, pr_number, lease_id, status, at) {
      return db.prepare(`UPDATE source_landing_queue SET status = ?, lease_id = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE repo = ? AND pr_number = ? AND status = 'leased'
          AND lease_id = ? AND lease_expires_at > ?`)
        .run(status, at, repo, pr_number, lease_id, at).changes;
    },
    listLandings(repo, limit = 50) {
      return db.prepare(`SELECT * FROM source_landing_queue WHERE repo = ?
        ORDER BY enqueued_at, pr_number LIMIT ?`).all(repo, limit).map(plain);
    }
  };
}
