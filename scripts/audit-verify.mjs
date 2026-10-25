// Verify an operator host journal (issue #291), outside any conversation:
//   node scripts/audit-verify.mjs <audit.jsonl> [--anchor <seq>:<sha256>]
// Prints one JSON document (bridge/operator-audit.mjs verifyJournal): chain state, the first
// broken line and why (unparsable, sequence, prev_mismatch, hash_mismatch, truncated,
// anchor_mismatch), and the lines of each session in order. Exit 0 when the chain is clean,
// 1 when it is broken, 2 when the arguments or the file cannot be used: missing, a symlink, not a
// regular file, or larger than the 64 MiB the journal reader takes (never a partial verdict).
// The journal is read with O_NOFOLLOW and never written. On lab it is root-only:
//   sudo node scripts/audit-verify.mjs /var/log/memo-operator/audit.jsonl
import { lstatSync } from 'node:fs';
import { MAX_AUDIT_READ_BYTES, fileAuditStore, verifyJournal } from '../bridge/operator-audit.mjs';

const [path, ...rest] = process.argv.slice(2);
const usage = message => { console.error(JSON.stringify({ ok: false, error: message, usage: 'audit-verify.mjs <audit.jsonl> [--anchor <seq>:<sha256>]' })); process.exit(2); };
if (!path || path.startsWith('-')) usage('journal_path_required');
let anchor = null;
if (rest.length) {
  if (rest[0] !== '--anchor' || rest.length !== 2) usage('unknown_arguments');
  const m = /^([1-9]\d{0,11}):([0-9a-f]{64})$/.exec(rest[1]);
  if (!m) usage('invalid_anchor');
  anchor = { seq: Number(m[1]), hash: m[2] };
}
let info;
try { info = lstatSync(path); } catch (error) { usage(error?.code === 'ENOENT' ? 'journal_not_found' : 'journal_unreadable'); }
if (info.isSymbolicLink()) usage('journal_is_symlink');
if (!info.isFile()) usage('journal_not_regular_file');
if (info.size > MAX_AUDIT_READ_BYTES) usage('journal_too_large');
let text;
try { text = fileAuditStore(path).read(); } catch (error) { usage(error?.code === 'ELOOP' ? 'journal_is_symlink' : 'journal_unreadable'); }
let out;
try { out = verifyJournal(text, { anchor }); } catch { usage('verify_failed'); }
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
