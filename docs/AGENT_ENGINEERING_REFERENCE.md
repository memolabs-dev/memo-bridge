# Agent engineering reference — Memo Labs

Reference: OpenAI, A practical guide to building AI agents (2026-01-15).
https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/

Vendor-neutral principles:
- Keep model, tools, and instructions independent.
- Standardize reusable tools and verify project capabilities before creating another project.
- Offer progressive instructions and explicit handling of stale data, edge cases, and permission failures.
- Establish eval baselines before optimizing price and latency.
- Start with simple agent orchestration; introduce specialized agents when measured complexity warrants it.
- Add layered authorization, guardrails, escalation and traceable outcomes.

Agent routing evaluation cases:
- Verified project already addresses request: continue it.
- Two overlapping projects: surface tradeoffs rather than creating another.
- Partial capability: prefer extension.
- Metadata-only or stale evidence: verify before claiming.
- Zero match: search registry and Source Engine; absence of evidence does not authorize creation.
- High-risk action: enforce appropriate review, permissions, and audit trail.

Metrics: reuse precision; missed-existing-project rate; false capability claims; duplicate creation rate; successful routing to existing implementation. GitHub Issue and PR status are not deployment evidence.
