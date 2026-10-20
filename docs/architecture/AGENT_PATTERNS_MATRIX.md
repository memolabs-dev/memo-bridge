# Memo Labs — agentic architecture pattern coverage

Status: **discovery / review required**, not an assertion that capabilities are deployed. Review date: 2026-10-20.
Owner: Memo Labs. Vendor neutral (ChatGPT, Claude, OpenCode, Codex, custom harnesses).

## References

- OpenAI, *A practical guide to building AI agents*: https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
- Anthropic, *Building effective agents*: https://www.anthropic.com/engineering/building-effective-agents
- alirezadir, *Agentic-AI-Systems*: https://github.com/alirezadir/Agentic-AI-Systems
- Gerred, *Building an Agentic System*: https://gerred.github.io/building-an-agentic-system/

These are architecture references, never proof that a Memo Labs feature exists. No framework or model SDK is mandated.

## Proposed mapping (hypotheses, not verified implementation)

| Pattern | Candidate existing owner | Evidence status | Verification target | Test to require | Action before implementation |
|---|---|---|---|---|---|
| Project/capability discovery; reuse-first | memo-bridge; Source Engine | Partial: memo-bridge PR #234, pending integration | registry, source manifests, task and PR state | never creates duplicate on unknown or stale evidence | Check #232/#233 and PR #234; verify merge and deployment |
| Tool schemas / ACI and permission scope | memo-bridge | Project exists; runtime detail not audited here | MCP registry, operator policy, denied-call traces | tool selection and scope refusal cases | Audit existing tools before adding aliases |
| Dynamic orchestration / worker delegation | cuesheet; Memo Coordinator | Candidate only | agent lifecycle implementation, worker dispatch | parallel independent tasks and serialized conflicts | Audit owners and boundaries |
| Evidence-gated verification | world-kernel; valve | Candidate only | policies, fixtures and verifier source | accept/reject with evidence fixtures | Reuse established verifier first |
| Agent evaluation and regression | agent-reality-bench; problem-intelligence-engine | Candidate only | benchmark suite and scoring | golden routing trajectories across harnesses | Extend existing benchmark, do not fork |
| Context engineering / retrieval provenance | Source Engine; CDKF (domain-specific) | Candidate only | citations, snapshots, source ledger, freshness | stale/unavailable source abstention | Inspect current source authority |
| AgentOps, traces, cost per successful task | cuesheet; memo-bridge | Candidate only | execution log and trace schemas | correlated task/tool/approval trace | Consolidate, avoid duplicate telemetry |
| Worktree and durable workspace lifecycle | memo-bridge | Partial: PR #231, pending verification | lifecycle policy, cleanup, recovery | persistent project survives agent session | Continue #226 |
| Secure long-running agents and scheduling | memo-bridge; Memo Coordinator | Candidate only | scheduled job ledger, cancel and resumability | restart-safe, idempotent, revoke permissions | Inspect before new scheduler |

A name, past conversation, open PR or failing/green CI result is not evidence of production deployment. Fill in concrete source SHA, verification date, test run and state after inspection.

## Reuse-first decision contract

1. Run Memo Bridge projects_list and identify relevant project names and metadata-only entries.
2. Retrieve project_context, repository docs/code, Source Engine corroborated observations and current PRs before forming a capability claim.
3. Search verified, dated capability manifests; preserve uncertainty and provenance. If no match is found, broaden retrieval instead of assuming no solution exists.
4. Rank: continue existing implementation > extend existing module > compose existing tools > propose new project (only after explicit overlap review).
5. Do not imply the user requested a new app just because they described a feature. Keep tool calls and project mutations permission-scoped.
6. For each decision record suggested owner, alternative candidates, proof refs and current task/PR, plus whether execution is possible from the active runtime.

## Acceptance metrics

- Existing-project recall and precision on gold test requests
- Duplicate project / duplicate tool proposal rate
- Wrong-project routing rate and false capability claim rate
- Tool selection, authorization and error-recovery accuracy
- Task completion and successful cost; p95 latency; side-effect retries
- Model-agnostic parity across ChatGPT, Claude, Codex and OpenCode

## Rollout

Current sampled Memo Bridge projects_list (2026-10-20): 74 entries; 17 available in this execution environment; 57 metadata-only. This is not a complete verified feature inventory. Issue #233 tracks progressive verification across all projects, and #232 tracks live discovery integration. Do not promote these proposed mappings into trusted runtime facts without source review.
