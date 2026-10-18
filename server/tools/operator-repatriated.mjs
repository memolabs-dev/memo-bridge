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
  .describe('"mac" or "vps" (lab). Omitted: the Mac when connected.');
const ref = z.string().min(1).max(128).regex(/^[\x20-\x7E]+$/).optional().describe('Optional id, journaled.');
const path = z.string().min(1).max(4096).describe('Absolute path on that host, e.g. "~/Downloads/plan.pdf".');
const workspaceId = z.string().max(40).optional()
  .describe('Usually omit: your conversation\'s workspace and a lock on dst_path are used.');
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
    offset: z.number().int().min(0).max(1000).optional().describe('From next_offset.'),
    limit: z.number().int().min(1).max(50).optional().describe('e.g. 20.') }),
  operator_transfer: z.object({ ref, workspace_id: workspaceId,
    src_host: z.enum(HOSTS).describe('"mac" or "vps".'), src_path: path.describe('The file to copy, readable on src_host.'),
    dst_host: z.enum(HOSTS).describe('"mac" or "vps".'), dst_path: path.describe('Where to put it, inside the write roots of dst_host.'),
    overwrite: z.boolean().optional().describe('Replace an existing destination (a backup is kept). Default false.') }),
  operator_transfer_status: z.object({ ref, transfer_id: z.string().regex(TRANSFER_ID_RE).describe('From operator_transfer.') })
});

export const REPATRIATED_DESCRIPTIONS = Object.freeze({
  operator_snapshot: 'Use this first when the owner points at a folder on a machine and wants to know what it is («c\'est quoi ce dossier ?», "where does this repo stand?"): git branch, ahead/behind, changes, last 10 commits, tree summary, README head, in one call. Read-only.',
  operator_read_media: 'Use this when the owner wants you to look at an image or a PDF on the Mac or the VPS («regarde la capture sur mon bureau»): png, jpeg, gif, webp, or up to 5 PDF pages with their text. Read-only.',
  operator_help: 'Use this when unsure how to do an operator task, or for reviewed playbooks (restart a stack, read logs, free disk, deploy check, git sync, backup status, rotate a key, freeze). No argument lists topics and playbooks. Read-only.',
  operator_transfer: 'Use this when the owner asks to copy a file between the Mac and the VPS («envoie ce fichier sur le VPS»), up to 512 MiB, SHA-256 checked, backup on overwrite. Follow a long one with operator_transfer_status.',
  operator_transfer_status: 'Use this to follow an operator_transfer that answered status running: running, done or failed. Read-only.'
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const REPATRIATED_ANNOTATIONS = Object.freeze({
  operator_snapshot: readonly, operator_read_media: readonly, operator_help: readonly, operator_transfer_status: readonly,
  operator_transfer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
});
