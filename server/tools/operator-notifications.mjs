// Notification inbox tools (issue #35): names, schemas, descriptions and annotations, merged into
// server/tools/operator-tools.mjs so the hub, the remote surface and the agents see one table.
// Answered by the hub itself (bridge/operator-notifications.mjs); they never reach a host agent.
// T0 (operator:read): they read, or mark as read, the caller's own inbox in the hub, nothing else.
import { z } from 'zod/v4';

export const NOTIFICATION_TOOLS = Object.freeze(['notifications_check', 'notifications_get', 'notifications_ack']);
const ref = z.string().min(1).max(128).regex(/^[\x20-\x7E]+$/).optional().describe('Optional correlation id, journaled.');
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
  notifications_check: 'Counts of your job notifications: unread, total, jobs still watched. A background operator_run or operator_script, or a jobs_submit, started with notify: true lands here when it ends, and the owner gets one Telegram message. Read-only.',
  notifications_get: 'Your job notifications, newest unread first: kind, host, job_id, status, exit code, duration, the last output lines (redacted, untrusted_content), and whether Telegram was sent. Read the full result with operator_job_status or job_results. Read-only.',
  notifications_ack: 'Mark notifications as read, by notification_ids or all: true, so notifications_check no longer counts them. Changes only your inbox in the hub, nothing on any host.'
});

const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const NOTIFICATION_ANNOTATIONS = Object.freeze({ notifications_check: readonly, notifications_get: readonly, notifications_ack: readonly });
