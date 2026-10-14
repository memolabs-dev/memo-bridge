# Job notifications and log tails (issues #35, #44)

Branch `feat/notifications-and-read-tail`, from `origin/main` d3852a7. Reference UX: SentinelX
`notify_telegram` on background exec and `notifications_check/get/ack`
(`workspace/research/2026-10-14-sentinelx-parity.md`).

## Requirements

| Id | Requirement | Acceptance | Test |
|---|---|---|---|
| R1 | `operator_run` and `operator_script` with `background: true` accept `notify: true` | the hub answers `notify: {registered: true}` and watches the job | `#35 hub: operator_run background notify:true ...` |
| R2 | `jobs_submit` through the hub (remote chats, 9443) accepts `notify: true` | the runtime never receives `notify`; the job is watched | `#35 hub: jobs_submit notify:true ...` |
| R3 | `notify` never reaches a host or a signature | removed before the approval hash and the signature; absent from the host journal | same, plus mutation N1 |
| R4 | On completion ONE Telegram message, to the owner chat only | one `sendMessage`, `chat_id` = owner chat, no buttons; status, duration, job id, at most 5 redacted lines | `#35: the Telegram message goes to the owner chat only ...` |
| R5 | No tool takes a recipient | no schema key like chat, recipient, to, telegram | same test |
| R6 | Inbox: last N completions per principal, bounded | 50 per principal, 256 principals, in hub memory (justified below) | `#35: the inbox is per principal and bounded ...` |
| R7 | `notifications_check` (counts), `notifications_get`, `notifications_ack` | check counts; get returns; ack removes from unread; a second check no longer counts it | `#35: a finished notify job lands once ...` and the hub test |
| R8 | The inbox is listed in `sessions_overview` | `notifications: {unread, total, watching, latest_unread_at}` | `#35 hub: jobs_submit ...` |
| R9 | Telegram unavailable: the completion still lands in the inbox, the failure is journaled | `telegram: unavailable` or `failed`, hub event `notification_unsent` with the reason | `#35: without Telegram ...`, `#35 hub: without a Telegram bot ...` |
| R10 | Watches end: finished, lost, permanent errors, expiry; bounded; older jobs polled less | `unknown` after 3 permanent errors, `watch_expired` after timeout + 30 min | `#35: runtime statuses ...` |
| R11 | `operator_read tail_lines` (1 to 2000) returns exactly the last N lines | 10 MB log, `tail_lines: 30`, exact last 30 lines | `#44: tail_lines 30 on a 10 MB log ...` |
| R12 | Read from the end without loading the file | 2 GiB sparse file read in milliseconds, only the end decoded | `#44: the end of a 2 GiB sparse file ...` |
| R13 | Same policy, denylist and bounds | refusals identical with and without `tail_lines`; redaction; 128 KiB window; `offset` exclusive | `#44: refusals are unchanged ...`, `#44: lines larger than the window ...` |

## Decisions

- **D1 notify is the hub's.** The hub strips it (operator: in `signedCall`, before `argsSha256`;
  runtime: in `requestAgent`), so no agent or runtime upgrade is needed, approvals match with or
  without it, and the host journals stay as they were.
- **D2 polling, not push.** The hub polls the job's own read tool with the starter's principal
  (`operator_job_status` signed T0; `job_status`). Results are already durable on the hosts; a push
  channel would need a new protocol frame. Cost: one T0 journal line per poll on the host. Every
  20 s tick for the first 2 min, then 60 s, then 120 s after 15 min.
- **D3 inbox in memory.** Same lifetime as approvals, grants, locks and transfers in the hub; the
  hub has no state directory today (lab-infra unit). A restart loses notices and watches, never a
  job result (`operator_job_status`, `job_status`, `job_results` still answer). Bounded: 50 notices
  per principal, 256 principals, 200 watches, 20 per principal.
- **D4 tools are T0 hub tools** in `OPERATOR_OPERATION_CAPABILITY` (operator:read), so both
  surfaces list them from the existing tables. `notifications_ack` is annotated read-only: it
  changes only the caller's own inbox, nothing on any host (the registry requires T0 tools to be
  read-only).
- **D5 Telegram content.** The issue text asked for no output in the message; the task brief asked
  for a short redacted tail. The brief is newer: at most 5 lines of 160 characters, redacted on the
  host and again in the hub. Removing them is one line in `telegramText`.
- **D6 tail_lines.** Backwards 16 KiB chunks until N line ends, within one window of
  min(max_bytes, 128 KiB). A final newline ends the last line. Lines over the window: the complete
  ones that fit, `truncated: "max_bytes"`, `offset` to continue.

## Out of scope

Push from the agents, a durable inbox, email, notifications for dev jobs started on stdio,
follow or streaming of logs.
