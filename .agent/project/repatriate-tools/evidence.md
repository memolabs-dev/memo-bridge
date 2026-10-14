# Evidence, repatriated tools part 2

Branch `feat/operator-repatriate-tools`, worktree `workspace/worktrees/memo-bridge/repatriate-tools`,
from `origin/main` 255b3dc. Not pushed.

## Automated

- EV-0 baseline (2026-10-14 19:46 CEST, before any change): `pnpm test` 484/484.
- EV-1 (20:22 CEST): `MEMO_BRIDGE_GOVERNANCE_ROOT=/Users/memo/memolabs/os/integrations/github pnpm test`
  -> tests 514, pass 514, fail 0, skipped 0 (30 new tests: memory 8, transfer 7, media 9,
  snapshot/help/staged edit 6).
- EV-2: `pnpm run build` emits `plugin/server/dist/index.mjs` and `job-runner.mjs`;
  `pnpm run smoke` -> `{"ok":true,"tools":56,"roundTrip":true,...}` (the stdio list of main
  plus the 4 memory tools; the smoke saves, finds and reads a memory through the bundle).
- EV-3: `node scripts/build-operator.mjs --out <scratch>` bundles the Mac operator agent with the
  new tools (PDFKit script, read_chunk, snapshot, staged edit found in the bundle).
- EV-4 mutation checks, each caught by a test, then restored:
  - transfer without the caller's workspace on the destination calls: `operator-transfer.test.mjs` fails (lock test);
  - staged edit without the path check: `operator-snapshot-help.test.mjs` fails;
  - agent without the binary passthrough: `operator-media.test.mjs` fails (a 187 KiB image is cut by the 128 KiB bound).
- EV-5 transfer on loopback: about 10.5 MiB in three transfers in 0.8 s (test AC-1), SHA-256
  equal at both ends, both host journals record the chunk ops under the caller's principal.
- EV-6 macOS paths run for real on this Mac (Darwin 27.0): PDFKit through `osascript -l
  JavaScript` renders 612x792 pages at 72 dpi and extracts their text; `sips` downscales a
  700x400 noise PNG to JPEG under the budget.

## Sources

- ChatGPT and MCP image content: OpenAI developer community, "ChatGPT connector returns empty
  {} for MCP tool results with type: image", OpenAI_Support reply of 2026-04-22: image blocks
  are valid MCP, but connector output "isn't guaranteed to become model-visible image input";
  return a text part alongside. https://community.openai.com/t/chatgpt-connector-returns-empty-for-mcp-tool-results-with-type-image-while-same-tool-works-in-mcp-inspector/1375446
  Hence: text part first, metadata and PDF text always present. Not verified live (T12).
- Lab tools, read-only check over ssh (2026-10-14 19:45): no `pdftoppm`, `pdftotext`,
  `pdfinfo`, ImageMagick, PyMuPDF or PIL on lab; `poppler-utils` not installed.
- Lab operations in the playbooks: lab-infra `README.md` ("Déploiement continu", "Sauvegardes"),
  `docs/memo-operator.md` ("Rotation", "Freeze and unfreeze"), `Makefile` (`status`, `backup-list`).

## Deployment (T11, owner, lab-infra)

1. lab: install `poppler-utils` in the `memo-operator` role (pdfinfo, pdftotext, pdftoppm), so
   `operator_read_media` renders PDFs on lab. Without it lab answers `pdf_tools_unavailable`.
2. lab: deploy this commit to the hub (`memo-bridge-hub`), the runner (memory tools; the store
   migrates to schema v5 at first open, additive), and `memo-operator` (snapshot, media,
   transfer source, staged edits). The root helper is unchanged.
3. Mac: rebuild and reinstall the operator agent (`deploy/mac/install-operator-agent.sh`), so
   transfers to and from the Mac and Mac media work.
4. No change to remote.json, Pocket ID scopes or policies: the new tools use the existing
   `operator:read` / `operator:write` and `coordinator:*` scopes.

## Merge with part 1 (T13)

`git merge-tree` of `feat/operator-repatriate-exec` (e178133) with this branch: conflicts in
`bridge/hub.mjs`, `bridge/ops.mjs`, `bridge/remote-surface.mjs`, `server/instructions.mjs`,
`server/tools/operator-tools.mjs`, `docs/OPERATOR.md`, the skill. All are additions next to the
same lines (import lists, the timeout table, tool name and schema lists, instruction strings):
keep both sides. Two semantic points for whoever merges:
- part 1 makes operator writes "just work" with an implicit workspace and lock; the transfer
  sends its destination writes through the same `operatorCall`, so it inherits that, and the
  instruction "lock dst_path first" should then be softened;
- part 1 adds `operator_docker`: the `restart_stack` playbook should use it instead of
  `operator_run as_root docker compose`.

## Manual acceptance (T12)

1. From a ChatGPT conversation: `operator_help`, then `operator_help {playbook:"read_logs"}`.
2. `operator_snapshot {host:"mac", path:"~/memolabs/os/core/bridge"}`.
3. `operator_read_media` on a Simulator screenshot (Mac) and on a 2-page PDF: does ChatGPT
   describe the image? (If not, the text part still carries the PDF text.)
4. `operator_lock` on a lab directory, then `operator_transfer` of a ~50 MiB file Mac to lab;
   check the SHA-256 on lab, and the time over the tunnel.
5. `workspace_open` in two conversations: `memory_save` a fact in one; the next `workspace_open`
   in the other shows it in `memory_snapshot`; try a stale `base_revision`.
