# Experimental intent surface (#280, first safe slice)

Source-only opt-in: `surface: "intent"` is accepted by the listener and factory parsers.
No shipped config is changed. `simple` remains the default with its existing 26 tools;
`full` remains available. This slice is not a production replacement or completion of #280.

| Tool | Typed input | Existing operation |
| --- | --- | --- |
| intent_inspect | optional search/status filters | projects_list |
| intent_status | target=policy, host=mac/vps | operator_policy |
| intent_status | target=snapshot, host=mac/vps, path | operator_snapshot |
| intent_guidance | empty object | operator_help, fixed refusals topic, limit 10 |

Guidance only retrieves existing help; it never executes a playbook. Each call makes one
existing dispatcher call. Tools are filtered by underlying capabilities and resolved operations
are authorized again at call time. Token scopes, configured ceiling, verifier intersection,
backend grants, host read roots, session context, error handling and result budgets still apply.
Operator rights remain opt-in under the existing ceiling. No new scope or wire op exists.
Strict input schemas reject extra fields; raw simple/full tools are not registered on intent,
even when all scopes and remote writes are enabled. Results remain untrusted data.

Rollback is the existing `simple` selection. No deployment, live configuration, policy or
secret changes were made. Tests use the MCP HTTP handler and fake dispatch; production
Mac/VPS/ChatGPT behavior is not asserted by that evidence.

Remaining issue blockers: durable typed plans with per-step authorization and fencing,
cost limits, idempotency, recovery, cancellation and progress/evidence must be designed
against #263/#266/#267 before execute/verify/cancel can be offered. The ten representative
end-to-end requests and comparative completion/calls/latency/tokens/false-success/safety
benchmark from #280 remain unperformed. No scheduler or arbitrary command envelope is added.
