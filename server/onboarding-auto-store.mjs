import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const KEY_RE = /^[a-f0-9]{24}$/;
const RECEIPT_RE = /^[A-Za-z0-9._:/-]{1,180}$/;

// Persistent CAS adapter for the trusted onboarding worker only. Database path is
// supplied by the administrator, never by a webhook or a repository manifest.
export class OnboardingActionStore {
  #db;
  #leases = new Map();
  #now;
  #ttl;
  constructor({ dbPath, now = () => Date.now(), leaseMs = 900_000 } = {}) {
    if (typeof dbPath !== 'string' || !isAbsolute(dbPath) ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000)
      throw new Error('invalid_action_store_config');
    this.#now = now;
    this.#ttl = leaseMs;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("CREATE TABLE IF NOT EXISTS onboarding_actions (key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('in_progress','finished','retryable')), token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, receipt TEXT, updated_at INTEGER NOT NULL)");
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_actions_state ON onboarding_actions(state)');
  }
  reserve(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid_action_key');
    const now = this.#now();
    const token = randomUUID();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#db.prepare('SELECT state, expires_at FROM onboarding_actions WHERE key = ?').get(key);
      if (existing && (existing.state === 'finished' ||
          (existing.state === 'in_progress' && existing.expires_at > now))) {
        this.#db.exec('COMMIT');
        return false;
      }
      this.#db.prepare(`INSERT INTO onboarding_actions (key, state, token, expires_at, receipt, updated_at)
        VALUES (?, 'in_progress', ?, ?, NULL, ?)
        ON CONFLICT(key) DO UPDATE SET state = 'in_progress', token = excluded.token,
        expires_at = excluded.expires_at, receipt = NULL, updated_at = excluded.updated_at`)
        .run(key, token, now + this.#ttl, now);
      this.#db.exec('COMMIT');
      this.#leases.set(key, token);
      return true;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  finish(key, receipt) {
    if (!KEY_RE.test(key) || !RECEIPT_RE.test(receipt?.id ?? ''))
      throw new Error('invalid_action_receipt');
    const token = this.#leases.get(key);
    if (!token) throw new Error('action_not_reserved');
    const result = this.#db.prepare(`UPDATE onboarding_actions SET state = 'finished',
      receipt = ?, token = NULL, expires_at = 0, updated_at = ?
      WHERE key = ? AND state = 'in_progress' AND token = ?`).run(receipt.id, this.#now(), key, token);
    this.#leases.delete(key);
    if (result.changes !== 1) throw new Error('action_lease_lost');
  }
  fail(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid_action_key');
    const token = this.#leases.get(key);
    if (!token) throw new Error('action_not_reserved');
    const result = this.#db.prepare(`UPDATE onboarding_actions SET state = 'retryable',
      token = NULL, expires_at = 0, updated_at = ?
      WHERE key = ? AND state = 'in_progress' AND token = ?`).run(this.#now(), key, token);
    this.#leases.delete(key);
    if (result.changes !== 1) throw new Error('action_lease_lost');
  }
  read(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid_action_key');
    const row = this.#db.prepare('SELECT state, receipt, expires_at FROM onboarding_actions WHERE key = ?').get(key);
    return row ? { state: row.state, receipt: row.receipt, expires_at: row.expires_at } : null;
  }
  close() { this.#db.close(); }
}
