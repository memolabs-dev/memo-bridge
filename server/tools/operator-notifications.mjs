// Notification inbox tools (issue #35): names, schemas, descriptions and annotations, merged into
// server/tools/operator-tools.mjs so the hub, the remote surface and the agents see one table.
// Answered by the hub itself (bridge/operator-notifications.mjs); they never reach a host agent.
// T0 (operator:read): they read, or mark as read, the caller's own inbox in the hub, nothing else.
import { z } from 'zod/v4';

export const NOTIFICATION_TOOLS = Object.freeze(['notifications_check', 'notifications_get', 'notifications_ack']);
const ref = z.string().min(1).max(128).regex(/^[\x20-\x7E]+$/).optional().describe('Optional id, journaled.');
const id = z.string().regex(/^nt_[A-Za-z0-9_-]{16,40}$/);

export const NOTIFICATION_SCHEMAS = Object.freeze({
  notifications_check: z.object({ ref }),
  notifications_get: z.object({ ref,
    notification_id: id.optional().describe('One notification (nt_...). Default: the newest unread ones.'),
    limit: z.number().int().min(1).max(50).optional().describe('At most 50. Default 10.'),
    include_acked: z.boolean().optional().describe('Also return acknowledged ones. Default false.') }),
  notifications_ack: z.object({ ref,
    notification_ids: z.array(id).min(1).max(50).optional().describe('The notifications to mark as read.'),
    all: z.boolean().optional().describe('Mark every notification of your inbox as read.') })
});

export const NOTIFICATION_DESCRIPTIONS = Object.freeze({
  notifications_check: 'Use this when the owner asks whether a long job finished («c\'est fini ?», "any news?"): counts of unread job notifications (jobs started with notify: true). Read-only.',
  notifications_get: 'Use this to read finished-job notifications: host, job_id, status, exit code, last output lines. Full output: operator_job_status or job_results. Read-only.',
  notifications_ack: 'Use this after reporting notifications to the owner: marks them read (notification_ids or all). Changes only your inbox.'
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const NOTIFICATION_ANNOTATIONS = Object.freeze({ notifications_check: readonly, notifications_get: readonly, notifications_ack: readonly });
