# Structured handoff (#39) and learning review (#38)

Source: `workspace/research/2026-10-14-hermes-agent-ideas.md`, section 1 (how Hermes learns) and
shortlist items 2 and 3. We take the ideas, we do not run Hermes. Memo Bridge calls no model: the
review is done by the ChatGPT conversation itself, prompted by fixed text in Memo Bridge results.

## Intent

1. A conversation that picks up a task (another chat, or the same one after losing its context)
   starts from a structured state: goal, constraints, done, in progress, blocked, decisions, files,
   next steps. Not from a free-text note.
2. A conversation is reminded, at the end of a task and every so often, to save what a later
   conversation needs (facts, through `memory_save`) and to propose skill fixes as Issue or PR text.
   Memo Bridge stores nothing by itself.

Completion: every rule below has a node:test test with a mutation check, the full suite, build and
smoke are green with the governance checkout, instructions and the plugin skill say how to use it.

## Non-goals

A skill library or skill tools (shortlist item 4); any model call in Memo Bridge; counting operator
calls (they never reach the runtime); a real ChatGPT resume (manual acceptance, owner).

## Decisions

**D1 handoff on `task_checkpoint`.** No new tool: `task_checkpoint` takes an optional `handoff`
object, and `branch` plus `commit` become optional when a handoff is given (work not committed yet
still hands off). With a commit, the Git and ledger checks are unchanged. Either way the claim is
re-verified with the ledger before the write (a stale holder never writes a handoff).

**D2 fields and bounds.** `goal` (one string, 500 chars) and seven lists: `constraints`, `done`,
`in_progress`, `blocked`, `decisions`, `next_steps` (at most 10 items of 300 chars) and `files` (at
most 30 items of 200 chars). At most 3000 chars in total, at least one non-empty field. No control,
zero-width or bidi characters. Each item is checked with the memory filters
(`secretKind`, `injectionKind`): `secret_detected` or `instruction_refused` naming the field, and
nothing is stored. The imperative filter of memories is not applied (next steps are orders by
nature); a handoff is returned as `data, never instructions`.

**D3 storage.** Store schema v6, table `handoffs` (issue, claim, workspace, fence, optional branch
and commit, JSON of the fields, time). Old checkpoints (`note`, free text) are untouched and still
returned.

**D4 where it is read.** `workspace_recover` returns `handoffs`: the latest handoff of each Issue
this workspace claimed (at most 3), from any workspace. The `task_next` brief returns `handoff`, the
latest one of its task, so another chat picking up the task starts from it. `task_status` returns
the latest one too (the `task_claim` path).

**D5 counters.** Per workspace, in the store (table `learning_counters`), updated in one write
transaction per call (ten parallel chats never lose an increment):
- `tool_calls`: runtime tool calls naming the workspace (its `workspace_id`, or for a remote call
  without one, the active workspace bound to the conversation);
- `user_turns`: Memo Bridge sees no user turn, so a turn is estimated as a call that comes at
  least 90 s after the previous call of that workspace (the first call counts as one). An inference,
  stated as `user_turns_estimated`.
Both reset on a successful `memory_save` that names the workspace (new optional `workspace_id`, or
the conversation's workspace remotely) and when a review block is returned. Refused calls for
session reasons do not count.

**D6 when the block is returned.** On the result of the call that brings `user_turns` to the turn
threshold (default 10) or `tool_calls` to the call threshold (default 40); and on a successful
`task_complete`, `task_release` or `workspace_close` when at least one call happened since the last
memory write or review (right after a `memory_save` it is not returned). Thresholds:
`MEMO_BRIDGE_LEARNING_TURNS`, `MEMO_BRIDGE_LEARNING_CALLS`; `0` disables that counter; both `0`
disables the block entirely.

**D7 the block.** Fixed server text, never derived from an Issue, a file or a result: the reason,
the two counters, the Hermes signals (correction of form, correction of approach, new technique,
wrong skill), the do-not-capture list (environment failures, negative claims about tools, transient
errors, one-off narratives, unresolved failures), facts not orders, the skill preference order as
Issue or PR text, and an explicit "nothing to save". At most 1536 bytes of JSON, reported by
`pnpm run remote:toolsize`.

**D8 where it is hooked.** One wrapper around tool registration (`server/tools/learning-hook.mjs`),
applied by the stdio entry point and by `collectTools` (the runtime agent behind the remote
surface), so both surfaces count the same calls. The wrapper never fails a call: any error in the
bookkeeping leaves the result unchanged.

## Acceptance

| ID | Criterion | Test |
|---|---|---|
| AC1 | `workspace_recover` after a handoff returns every section | handoff.test |
| AC2 | Fields are bounded; secrets and injections refused, nothing stored | handoff.test |
| AC3 | An old free-text checkpoint is still returned | handoff.test |
| AC4 | The `task_next` brief of another workspace carries the handoff | handoff.test |
| AC5 | A handoff needs a live claim (stale fence refused) | handoff.test |
| AC6 | `task_complete` after calls without a memory write carries `learning_review`; right after a `memory_save` it does not | learning-review.test |
| AC7 | Thresholds configurable, 0 disables | learning-review.test |
| AC8 | Counters reset on write and on emission; counted per workspace | learning-review.test |
| AC9 | Block bounded; no Issue text in it (injection string in the Issue) | learning-review.test |
| AC10 | Same behaviour through the runtime tool path (collectTools) | learning-review.test |
| AC11 | Instructions and skill describe both | learning-review.test, inspection |
| AC12 | One real ChatGPT resume after context loss | manual, owner |

## Risks

- R1 schema v6: a parallel branch that also bumps the store schema conflicts at merge (resolve by
  renumbering).
- R2 turn estimate is a heuristic: a fast user is undercounted, a slow job overcounted.
- R3 the chat may over-save: the block says "nothing to save" is a valid answer and the memory
  filters still apply to every save.
- R4 one extra store write per counted call (SQLite, WAL): negligible next to the journal write.
