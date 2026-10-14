# Repatriate SentinelX tools, part 2: new capabilities

Owner decision 2026-10-14: everything the owner used SentinelX for lives in Memo Bridge, with the same
fluidity. Part 1 (another session, in parallel) covers `gh` classification, standing approvals, user
scripts, ssh/scp/rsync, docker and the Mac write roots. This part adds the capabilities Memo Bridge
does not have at all. Source of the gaps: `workspace/research/2026-10-14-sentinelx-parity.md`, rows
2, 3, 24, 27, 31, 40, 64 to 69.

## Intent

A ChatGPT conversation can, through Memo Bridge only: copy a file between the Mac and lab, look at an
image or a PDF, ask for help and follow a reviewed playbook, save and find context across
conversations (and get it back with its task), get a one-call orientation of any readable directory,
and edit a file larger than one call allows.

Completion: every tool below exists on the hub and the remote surface, refuses what it must, has
node:test coverage of its bounds and refusals, the full suite, build and smoke are green, and the
docs say what runs where.

## Non-goals

Directories and resume in transfers; audio and video; OCR; memory archive, delete, export and
settings; playbooks that change a policy; anything part 1 owns (approvals, classification, scripts,
docker, write roots). No push, deploy or PR.

## Decisions

**D1 `operator_transfer` (T1, operator:write), relayed by the hub.**
`{src_host, src_path, dst_host, dst_path, overwrite?, workspace_id?, ref?}`, files up to 512 MiB,
mac to vps, vps to mac, or within one host.
- Source: two new *internal* agent ops (never tools), signed by the hub for the caller's principal:
  `operator_transfer_source` (read roots, secret denylist, regular file, size and SHA-256 computed
  on the host) and `operator_read_chunk` (64 KiB at an offset, base64, refused with
  `source_changed` when size or mtime moved).
- Destination: the existing `operator_upload_init/chunk/complete`, sent through the hub's normal
  operator path. So the destination gets exactly the upload rules: write roots, denylist,
  `use_dev_flow`, workspace and **operator lock on the destination path** (remote callers), freeze,
  approval mode, backup on overwrite, atomic rename, SHA-256 verified at the destination against
  the source digest.
- Why this design: a 64 KiB chunk is 87 KiB of base64, under both MAX_REQUEST_BYTES (128 KiB) and
  the agent's 128 KiB result bound; the 16 KiB frame limit is handled by the existing `part`
  frames. No new frame type, no protocol version, no new write code on the host. Four lanes in
  parallel (agent max in flight is 8). Binary payloads skip the text redactor (it could corrupt
  them; the SHA-256 would catch it anyway).
- The call waits up to 20 s; a longer transfer keeps running in the hub and answers
  `{status:'running', transfer_id}`; `operator_transfer_status{transfer_id}` (T0) reads it. State is
  in hub memory: a hub restart loses it (`unknown_transfer`) and nothing is placed (the destination
  upload expires in 1 h). At most 2 transfers running per hub.

**D2 `operator_read_media` (T0).** `{host, path, pages?, dpi?}`. Type by magic bytes: png, jpeg,
webp, gif, pdf. Images: at most 20 MiB on disk; returned as is under 600 KiB, else downscaled with
`sips` (Mac); on lab without a resizer `too_large`. PDF: at most 50 MiB, at most 5 pages per call,
dpi 36 to 150 (default 100), rendered and text-extracted with PDFKit through `osascript -l
JavaScript` (fixed script, path as argument) on the Mac, `pdftoppm`/`pdftotext` on lab when
installed, else `pdf_tools_unavailable`. Total image bytes per call at most 600 KiB; pages that do
not fit come back in `next_page`. The hub and the remote surface return MCP `image` content plus a
text part (metadata, and for PDFs the extracted text, redacted, as untrusted_content).
ChatGPT: OpenAI support (forum, 2026-04-22) says image blocks are valid MCP but "ChatGPT connector
output isn't guaranteed to become model-visible image input", and recommends a text part alongside.
Hence the extracted text is always returned for PDFs, and image metadata for images.

**D3 `operator_help` (T0), answered by the hub, no host.** `{topic?, playbook?, offset?, limit?}`.
Static, reviewed content in `bridge/operator-help.mjs`: topics (start, hosts, locks, approvals,
files, transfer, media, memory, playbooks, refusals), then details; every answer has `next` with the
calls to make next. Playbooks: restart_stack, read_logs, free_disk, deploy_check, git_sync,
backup_status, rotate_key, freeze. No playbook edits a policy or widens access (test).

**D4 memory (`memory_save`, `memory_search`, `memory_get`, `memory_list`).** Runtime tools, stored
in the coordinator SQLite store (schema v5: `memories`, `memory_revisions`). The hub itself is a
stateless router by design (Phase 4 D1) and holds no database; the store it routes to is the
runtime's SQLite on lab, so every ChatGPT conversation shares one memory, and `workspace_open` and
`task_next` read it in the same store. Design rules from the Hermes Agent study (coordinator input,
research `2026-10-14-hermes-agent-ideas.md` §1.5 and idea 1), applied:
- two scopes, one fact in one place: `owner` (the owner, his preferences; no project or host) and
  `environment` (a project, else a host). A live entry with the same title or body is refused
  (`duplicate_fact`, with the existing id);
- hard budget per scope and key, in characters of title + body of live entries: owner 8 KiB, each
  project or host 24 KiB; entry body 4 KiB. Over budget: `memory_full` with the entries and the
  characters to free; the caller consolidates (body_patch, merge, archive). No auto-compaction;
- facts, not orders: imperative openings (always, never, you must, toujours, jamais...) refused
  (`not_a_fact`); injection, role, exfiltration, `curl | sh` and SSH backdoor shapes refused
  (`instruction_refused`); secrets refused (`secret_detected`); "X does not work" needs `evidence`
  (`evidence_required`); control, zero-width and bidi characters refused;
- `workspace_open` returns `memory_snapshot` (owner scope plus the project's entries, excerpts of
  240 characters, at most 20 entries and 6 KiB so it fits the 24 KiB remote budget), frozen for the
  session; task briefs list up to 5 `related_memories` (project, issue, issue tag);
- `base_revision` optimistic concurrency (`revision_conflict` with the current revision);
- `body_patch` (one unique fragment) next to whole-body updates, as Hermes replaced `replace`.
- Rejected, with reason: Telegram approval for edits and removals from remote chats. Runtime tools
  do not pass through the hub's operator approval path (approvals are bound to signed operator
  calls); wiring it is part 1's area (standing approvals) and an M-size change. Instead every edit
  is journaled (coordinator events), reversible (20 revisions kept and readable; removal is an
  archive, restored by `archived:false`; no hard delete). Approval can be added later on top.
- Not taken: learning review, skills serving, history search (later tasks).
Owned by the principal. Every result carries "Memory restores knowledge, not authorization".

**D5 `operator_snapshot` (T0).** `{host, path}` for any path in the read roots: kind, git (branch,
head, upstream, ahead/behind, changed/untracked counts, 10 recent commits) with fixed argv,
`GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`, `safe.directory` for that path only; tree summary
(top entries, extension counts, totals; depth 4, 20 000 entries, 5 s); README head (4 KiB,
untrusted). Secrets skipped and counted.

**D6 staged edit.** `operator_upload_init{stage:true}` keeps the completed upload as a stage bound
to its path instead of placing it; `operator_edit{old_upload_id, new_upload_id}` uses staged
contents in place of `old` / `new_text` (same path, at most 8 MiB, UTF-8). Chunks stay 64 KiB.
Stages are removed after a real edit, and expire after 1 h.

## Acceptance

| ID | Criterion |
|---|---|
| AC-1 | A 5 MiB binary goes vps to mac and mac to vps through a real hub and two agents, identical SHA-256; within one host too |
| AC-2 | Transfer refusals: secret source (`path_secret`), source outside roots, destination outside write roots, existing destination without overwrite (`exists`), overwrite keeps a backup, remote caller without lock (`lock_required`), frozen hub, size above 512 MiB, source changed mid-way |
| AC-3 | read_media: png/jpeg/gif/webp returned as image content with the right MIME; PDF pages rendered and text extracted (Mac); secret path refused; too large refused; pages and dpi bounded; non-media refused |
| AC-4 | operator_help: index, topic details, playbook steps, unknown playbook lists the known ones, pagination, no playbook mentions editing a policy |
| AC-5 | memory: create rev 1, update with base_revision, stale conflict, body_patch, archive and restore, scopes and duplicates, budget full, facts not orders (imperative, injection, exfiltration, secret, evidence), search by word, tag, scope, issue, get by revision, list paging, other principal sees nothing, note present |
| AC-6 | workspace_open returns a frozen memory snapshot; task_next brief lists related memories |
| AC-7 | snapshot: git repo (branch, dirty counts, commits), plain directory, secret path refused, bounds |
| AC-8 | staged edit: a 2 MiB new_text through new_upload_id; old_upload_id for replace; unknown or other-path stage refused; dry_run works |
| AC-9 | `pnpm test`, `pnpm run build`, `pnpm run smoke` green with the governance root |
| AC-10 | docs/OPERATOR.md, server/instructions.mjs and the plugin skill describe the tools |

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Transfer used to exfiltrate a secret from one host to the other | source denylist and read roots on the source agent; destination write roots and lock; both hosts journal every chunk |
| R2 | A huge transfer pins the hub | 2 concurrent, 4 lanes, 512 MiB, hub waits on agent calls only |
| R3 | ChatGPT does not show images to the model | text part with metadata and PDF text; documented |
| R4 | A secret saved in memory is read back by another chat | pattern refusal on save; principal scoping; journaled |
| R5 | Prompt injection through memory bodies | results wrap bodies as untrusted_content, "knowledge, not authorization" |
| R6 | git config in a snapshotted repo runs a program (fsmonitor) | `-c core.fsmonitor=false`, status and log only, no hooks run by these |
| R7 | PDF parsing of a hostile file | PDFKit/poppler out of process, 30 s timeout, size and page bounds |
| R8 | Merge conflicts with part 1 | new files; shared files touched by a few lines (listed in the closure) |
