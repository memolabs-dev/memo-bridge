// Operator tools repatriated from SentinelX, part 2 (spec .agent/project/repatriate-tools): names,
// schemas, descriptions and annotations, merged into server/tools/operator-tools.mjs so the hub,
// the remote surface and the agents see one table. Kept in their own file so parallel work on
// the other operator tools merges cleanly.
//
//  - operator_snapshot, operator_read_media: T0, run by the host agent (bridge/operator-snapshot.mjs,
//    bridge/operator-media.mjs);
//  - operator_help, operator_transfer_status: T0, operator_transfer: T1, answered by the hub itself
//    (bridge/operator-help.mjs, bridge/operator-transfer.mjs); they never reach an agent as such.
import { z } from 'zod/v4';

const HOSTS = ['mac', 'vps'];
const host = z.enum(HOSTS).optional()
  .describe('mac (the owner\'s Mac, as user memo) or vps (lab). Default: mac when connected, else vps.');
const ref = z.string().min(1).max(128).regex(/^[\x20-\x7E]+$/).optional().describe('Optional correlation id, journaled.');
const path = z.string().min(1).max(4096).describe('Absolute path on that host ("~/" on the Mac).');
const workspaceId = z.string().max(40).optional()
  .describe('Your workspace_id (ws_...). Required from a ChatGPT conversation, with an operator_lock on dst_path.');
const name = z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]{0,39}$/);

// Operations the hub answers itself, without an agent.
export const HUB_OPERATOR_TOOLS = Object.freeze(['operator_help', 'operator_transfer', 'operator_transfer_status']);
export const REPATRIATED_OPERATOR_TOOLS = Object.freeze(['operator_snapshot', 'operator_read_media', ...HUB_OPERATOR_TOOLS]);
export const TRANSFER_ID_RE = /^tr_[A-Za-z0-9_-]{16,40}$/;

export const REPATRIATED_SCHEMAS = Object.freeze({
  operator_snapshot: z.object({ host, ref, path: path.describe('A directory inside the host\'s read roots ("~/" on the Mac).') }),
  operator_read_media: z.object({ host, ref, path,
    pages: z.string().regex(/^\d{1,4}(?:-\d{1,4})?$/).optional().describe('PDF pages, "3" or "2-4", at most 5 per call. Default "1".'),
    dpi: z.number().int().min(36).max(150).optional().describe('PDF rendering, 36 to 150. Default 100.') }),
  operator_help: z.object({ ref,
    topic: name.optional().describe('start, hosts, locks, approvals, files, transfer, media, memory, playbooks, refusals.'),
    playbook: name.optional().describe('read_logs, restart_stack, free_disk, deploy_check, git_sync, backup_status, rotate_key, freeze.'),
    offset: z.number().int().min(0).max(1000).optional(),
    limit: z.number().int().min(1).max(50).optional() }),
  operator_transfer: z.object({ ref, workspace_id: workspaceId,
    src_host: z.enum(HOSTS), src_path: path.describe('The file to copy, readable on src_host.'),
    dst_host: z.enum(HOSTS), dst_path: path.describe('Where to put it, inside the write roots of dst_host.'),
    overwrite: z.boolean().optional().describe('Replace an existing destination (a backup is kept). Default false.') }),
  operator_transfer_status: z.object({ ref, transfer_id: z.string().regex(TRANSFER_ID_RE) })
});

export const REPATRIATED_DESCRIPTIONS = Object.freeze({
  operator_snapshot: 'Orientation of a directory in one call, for any directory inside the host\'s read roots (not only registered projects): git branch, upstream, ahead and behind, changed and untracked counts, the last 10 commits, a tree summary (top entries, extensions, totals, project markers) and the head of the README. Secret paths are skipped. Read-only.',
  operator_read_media: 'Look at an image (png, jpeg, gif, webp) or PDF pages on a host, returned as image content plus a text part (metadata; for PDFs the page text, as untrusted_content). Large images are downscaled on the Mac; PDFs: up to 5 pages per call, continue from next_page. Secret paths are refused. Read-only.',
  operator_help: 'Help on the operator tools, progressively: no argument lists the topics and the playbooks; topic gives details; playbook gives reviewed steps for frequent operations (restart a stack, read logs, free disk, deploy check, git sync, backup status, rotate a key, freeze). Every answer says what to call next. Read-only.',
  operator_transfer: 'Copy one file (up to 512 MiB) between hosts or within one: Mac to lab, lab to Mac. The hub relays it in 64 KiB chunks; the source is checked against its host\'s read policy (secrets refused), the destination against its write roots, under your operator_lock on dst_path; the SHA-256 is verified at the destination before the file is moved into place; overwrite keeps a backup. A long transfer answers status running with a transfer_id.',
  operator_transfer_status: 'Progress or result of an operator_transfer that answered status running: running (bytes done), done (destination, SHA-256) or failed (the refusal). Read-only.'
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const REPATRIATED_ANNOTATIONS = Object.freeze({
  operator_snapshot: readonly, operator_read_media: readonly, operator_help: readonly, operator_transfer_status: readonly,
  operator_transfer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
});
