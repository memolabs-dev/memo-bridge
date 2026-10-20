# Reuse-first project discovery (harness-agnostic skill source)

**When to load:** any user request to create an agent, app, tool, project, shared service, automator, skill, integration or infrastructure component, or when an agent cannot identify the correct existing repo.

**Inputs:** intent, constraints, available tool scopes, live Memo Bridge project registry, verified capabilities and issue/PR state.

**Procedure:** call projects_list -> search relevant capabilities and owners -> project_context on candidates -> validate repo code and evidence age -> compare overlapping projects -> recommend reuse, extension or composition. Creation of a new project requires a documented negative overlap check; no result is not sufficient. Output evidence sources and uncertainty explicitly.

**Avoid:** guessing implemented features from project names; marking metadata-only as verified; relying on a stale PR as proof of deployment; copying one harness's permission assumptions into another; creating an orchestration layer without owner review.

**Evaluation:** ask each target harness to handle (a) an existing full capability (b) partial overlap (c) two similar candidates (d) inaccessible metadata-only project (e) outdated manifest (f) genuine new need. Score proper routing, valid tools, factuality and duplicate avoidance.

See AGENT_PATTERNS_MATRIX.md for reference patterns and candidate owners. This file is documentation only, not yet an installed skill in every harness.
