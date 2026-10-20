# Dynamic project discovery — reuse existing capabilities first

**Authority:** `PROJECTS.md` defines registered projects, not what they can do. The live Memo Bridge `projects_list` read surface can combine 17 reachable repos with metadata snapshots for other projects. `project_context` provides observed Issues and PRs, not a reliable indicator of deployment. Source Engine can add corroborated source changes; no single surface should be taken as truth for everything.

## Contract

`server/project-capabilities.mjs` exports pure `matchProjects(projects, evidence, goal)` and `creationGate(matches)`, reusable from MCP / CLI / LLM independent of a particular harness. Records need explicit repository evidence (`evidence.kind=repository`, `evidence.ref`), `purpose`, `capabilities`, `verified_at` and matching `project` name. Missing metadata, missing provenance and stale evidence never become trusted capability claims. Only explicit capabilities and verified purpose are matched; stack/name alone are insufficient.

**Before starting a new application**: (1) list projects, (2) find verified capabilities matching the user goal, (3) inspect `project_context`, open PRs/issues and Source Engine for candidate projects, (4) verify repository code and existing skill docs, (5) favor continuing a project or expanding a module; create something new only after checking overlap with projects where evidence is missing.

`creationGate` reports `inspect_existing_first`, `verify_candidates`, or `verify_registry_and_source_engine`. These are advice, not permission to create a repository.

## Documentation per project

Keep short `AGENTS.md` index with links to `docs/architecture.md`, `docs/operations.md`, `docs/testing.md`; add a short machine-readable capability manifest documenting verified features, overlaps and boundary conditions. Generate current progress at query time from GitHub Issues/PRs and the task ledger, rather than hardcoding a claim like “fully implemented”. Invalid or inaccessible repositories must remain marked `unverified`.

## Rollout and acceptance

The registry currently contains 74 entries: 17 reachable from this runtime and 57 `metadata_only`. These figures are **point-in-time**, not permanent truths. No 74-project capability mapping is claimed yet; populate reviewed source-based manifests progressively, starting with core platform and reusable infrastructure before client/product apps. Prioritize Source Engine, Cuesheet, UNI, World Kernel, Drop, CDKF, then remaining projects. An agent must not automatically spin up new infrastructure on a zero-match result.
