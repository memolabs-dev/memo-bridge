// The ratchet (scripts/uni-ratchet.mjs): an agent PR may change the judge of PRs only by making it
// stronger. One violating and one passing case per rule, then the CLI against a fake GitHub API
// (never the real one): fail closed on every read it cannot complete, one marked comment, GET only
// apart from that comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MARKER, compileWithUni, isJudgePath, main, ratchet } from '../scripts/uni-ratchet.mjs';

// ---- fixtures: a reduced copy of the real judge (uni/intents/delivery.uni and .uni/config.toml
// of PR #214, .mergify.yml, ci.yml), so the rules run on realistic text.

const CONTRACT = `VERSION 0.1
DOMAIN software
INTENT memo-bridge.delivery

GOAL
  A memo-bridge change is done only when this exact commit proves the whole suite.

CLAIM suite REQUIRED
  ENSURE the whole pnpm test suite passes on this commit
INVARIANT fence-monotonic CRITICAL
  ENSURE a stale fence never writes
INVARIANT mutants-killed CRITICAL
  ENSURE every mutant makes its invariant test fail

VERIFY suite
  USING suite.pnpm
VERIFY fence-monotonic
  USING invariant.fence-monotonic
VERIFY mutants-killed
  USING invariant.mutants-killed

ACCEPT WHEN
  required_claims == VERIFIED
  AND critical_failures == 0
`;

const CONFIG = `# Trusted registry for uni/intents/delivery.uni.

[verifiers."suite.pnpm"]
run = 'MEMO_BRIDGE_REQUIRE_GOVERNANCE=1 pnpm test'
files = [
  "server/**",
  "tests/**",
]
timeout = 1800

[verifiers."invariant.fence-monotonic"]
run = 'MEMO_BRIDGE_REQUIRE_GOVERNANCE=1 node --test tests/invariants/fence.test.mjs'
files = [
  "tests/invariants/fence.test.mjs",
  "server/**",
]
timeout = 900

[verifiers."invariant.mutants-killed"]
run = 'node tests/mutations/run.mjs'
files = [
  "tests/mutations/**",
  "server/**",
]
timeout = 2400

# GitHub Actions OIDC.
[identities."https://token.actions.githubusercontent.com"]
source = "oidc"
jwks_file = ".uni/identity/github.jwks.json"
audiences = ["uni-cli"]
algorithms = ["RS256"]
`;

const MERGIFY = `# Memo Labs autoloop.
shared:
  land_conditions: &land_conditions
    - base = main
    - -draft
    - or:
        - author = memo-labs-automation[bot]
        - author = guillaume-flambard
    - label != hold-merge
    - -files ~= ^\\.env
    - check-success = @github-actions/test (22)
    - check-success = @github-actions/uni

queue_rules:
  - name: memo-labs-autoloop
    queue_conditions: *land_conditions
    merge_conditions: *land_conditions
`;

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  uni:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - run: uni check uni/intents/delivery.uni
`;

const PACKAGE = `{
  "name": "memo-bridge",
  "type": "module",
  "scripts": {
    "build": "esbuild server/index.mjs",
    "test": "node --test --test-timeout=180000 tests/*.test.mjs",
    "test:hub": "node --test tests/hub-auth.test.mjs"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
`;

const FENCE_PATCH = `# test: a zombie holder writes nothing after a reclaim
diff --git a/server/runners/worktrees.mjs b/server/runners/worktrees.mjs
index c3b3a8f..0b2b205 100644
--- a/server/runners/worktrees.mjs
+++ b/server/runners/worktrees.mjs
@@ -661,6 +661,4 @@ export function createWorktreeRunner(rt) {
     if (held.error) return held;
     if (inExpiryWindow(held.claim.expires_at, now())) return { error: leaseExpiring() };
-    const verified = await rt.ledger.verify(held.claim.claim_id);
-    if (!verified?.ok) return { error: fail('ledger_unavailable') };
     return held;
   }
`;

const SKEW_PATCH = `# test: two skewed clocks
diff --git a/server/coordinator/issue-lease.mjs b/server/coordinator/issue-lease.mjs
--- a/server/coordinator/issue-lease.mjs
+++ b/server/coordinator/issue-lease.mjs
@@ -10 +10 @@
-const MARGIN_MS = 60_000;
+const MARGIN_MS = 0;
`;

const BASE = {
  'uni/intents/delivery.uni': CONTRACT,
  '.uni/config.toml': CONFIG,
  '.uni/identity/github.jwks.json': '{"keys":[{"kid":"a"}]}\n',
  '.mergify.yml': MERGIFY,
  '.github/workflows/ci.yml': CI,
  '.github/workflows/uni-ratchet.yml': 'name: uni-ratchet\non: pull_request_target\n',
  'scripts/uni-ratchet.mjs': '// the ratchet\n',
  'package.json': PACKAGE,
  'tests/invariants/fence.test.mjs': "test('a zombie holder writes nothing after a reclaim', () => {});\n",
  'tests/invariants/clock-skew.test.mjs': "test('two skewed clocks', () => {});\n",
  'tests/invariants/lib/fixture.mjs': 'export const fixture = 1;\n',
  'tests/mutations/run.mjs': '// harness\n',
  'tests/mutations/count-reporter.mjs': '// reporter\n',
  'tests/mutations/patches.mjs': '// patches\n',
  'tests/mutations/fence-verify.patch': FENCE_PATCH,
  'tests/mutations/clock-skew-margin.patch': SKEW_PATCH
};

// A tiny stand-in for `uni compile --json` (the CLI calls the real one): the same IR shape, for
// the subset these fixtures use. The real compiler is exercised further down when installed.
function fakeCompile(text) {
  const ir = { uni_version: '0.1', intent: { id: null, domain: null, goal: '' }, claims: [], verification: [], acceptance: {} };
  let verifying = null; let inGoal = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === 'GOAL') { inGoal = true; continue; }
    if (!line) { inGoal = false; continue; }
    if (inGoal || line.startsWith('ENSURE') || line === 'VERSION 0.1') continue;
    let m;
    if ((m = /^INTENT (\S+)$/.exec(line))) ir.intent.id = m[1];
    else if ((m = /^DOMAIN (\S+)$/.exec(line))) ir.intent.domain = m[1];
    else if ((m = /^(CLAIM|INVARIANT) (\S+)((?: (?:REQUIRED|CRITICAL))*)$/.exec(line))) {
      const mods = m[3].trim().split(' ');
      const critical = mods.includes('CRITICAL');
      ir.claims.push({ id: m[2], kind: m[1].toLowerCase(), required: critical || mods.includes('REQUIRED'), critical, ensure: '' });
    } else if ((m = /^VERIFY (\S+)$/.exec(line))) verifying = m[1];
    else if ((m = /^USING (.+)$/.exec(line))) ir.verification.push({ claim_id: verifying, verifier_ref: m[1], inline_shell: null, requirement: null });
    else if (line.startsWith('ACCEPT WHEN')) ir.acceptance = { require_verified: true };
    else if (/^(AND |required_claims|critical_failures)/.test(line)) continue;
    else throw new Error(`fake uni: cannot read "${line}"`);
  }
  return ir;
}

const map = files => new Map(Object.entries(files).filter(([, v]) => v !== null));
function run(changes = {}, { paths, labelEvents = [], base = BASE, compileContract = fakeCompile } = {}) {
  const head = { ...base, ...changes };
  const changed = paths ?? Object.keys(changes);
  return ratchet({ base: map(base), head: map(head), paths: changed, compileContract, labelEvents });
}
const rules = result => [...new Set(result.violations.map(v => v.rule))].sort();
function violates(result, rule, path) {
  assert.equal(result.ok, false, `expected ${rule}`);
  assert.ok(result.violations.some(v => v.rule === rule && (path === undefined || v.path === path)),
    `expected ${rule}${path ? ` on ${path}` : ''}, got ${JSON.stringify(result.violations)}`);
}
function passes(result) {
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
}

test('a PR touching only server/ has no violation', () => {
  passes(run({ 'server/x.mjs': 'changed\n' }, { paths: ['server/x.mjs', 'server/y.mjs'] }));
});

test('isJudgePath covers the judge and leaves the rest of the repository and uni runtime state out', () => {
  for (const p of ['uni/intents/delivery.uni', '.uni/config.toml', '.uni/identity/github.jwks.json', '.uni/policies/p.toml',
    'tests/invariants/fence.test.mjs', 'tests/invariants/lib/race.mjs', 'tests/mutations/run.mjs', 'tests/mutations/x.patch',
    '.mergify.yml', '.github/workflows/ci.yml', '.github/workflows/uni-ratchet.yml', 'scripts/uni-ratchet.mjs']) assert.ok(isJudgePath(p), p);
  for (const p of ['server/x.mjs', 'tests/coordinator.test.mjs', 'scripts/mergify-scan.mjs', 'AGENTS.md', '.github/CODEOWNERS',
    '.uni/evidence/a.json', '.uni/decisions/d.json', '.uni/artifacts/x', '.uni/events.jsonl', '.uni/events.2.jsonl', '.uni/.lock',
    '.uni/.registry.snapshot', '.uni/brief.md']) assert.ok(!isJudgePath(p), p);
});

// ---- contract_weakened (uni/intents/*.uni, compared on the IR of uni compile)

test('contract_weakened: a claim removed, REQUIRED or CRITICAL lost, a verifier changed, an ACCEPT clause dropped', () => {
  const p = 'uni/intents/delivery.uni';
  violates(run({ [p]: CONTRACT.replace('INVARIANT fence-monotonic CRITICAL\n  ENSURE a stale fence never writes\n', '').replace('VERIFY fence-monotonic\n  USING invariant.fence-monotonic\n', '') }), 'contract_weakened', p);
  violates(run({ [p]: CONTRACT.replace('CLAIM suite REQUIRED', 'CLAIM suite') }), 'contract_weakened', p);
  violates(run({ [p]: CONTRACT.replace('INVARIANT mutants-killed CRITICAL', 'INVARIANT mutants-killed REQUIRED') }), 'contract_weakened', p);
  violates(run({ [p]: CONTRACT.replace('USING invariant.fence-monotonic', 'USING suite.pnpm') }), 'contract_weakened', p);
  violates(run({ [p]: CONTRACT.replace('  AND critical_failures == 0\n', '') }), 'contract_weakened', p);
  violates(run({ [p]: CONTRACT.replace('INTENT memo-bridge.delivery', 'INTENT memo-bridge.other') }), 'contract_weakened', p);
  violates(run({ [p]: null }), 'contract_weakened', p);
  violates(run({ [p]: `${CONTRACT}garbage\n` }), 'contract_weakened', p);
});

test('contract_weakened passes: a claim or an invariant added, CRITICAL gained, layout and wording changed', () => {
  const p = 'uni/intents/delivery.uni';
  passes(run({ [p]: CONTRACT.replace('VERIFY suite\n', 'INVARIANT new-one CRITICAL\n  ENSURE something new holds\n\nVERIFY new-one\n  USING invariant.new-one\nVERIFY suite\n') }));
  passes(run({ [p]: CONTRACT.replace('CLAIM suite REQUIRED', 'CLAIM suite REQUIRED CRITICAL') }));
  passes(run({ [p]: CONTRACT.replace('  ENSURE a stale fence never writes', '  ENSURE a stale fence never writes anything') }));
  passes(run({ 'uni/intents/extra.uni': CONTRACT.replace('memo-bridge.delivery', 'memo-bridge.extra') }));
});

test('contract_weakened: a base contract that no longer compiles is a ratchet error, never a pass', () => {
  const p = 'uni/intents/delivery.uni';
  const r = run({ [p]: CONTRACT.replace('CLAIM suite REQUIRED', 'CLAIM suite REQUIRED CRITICAL') },
    { compileContract: text => { if (text === CONTRACT) throw new Error('uni missing'); return fakeCompile(text); } });
  violates(r, 'ratchet_error', p);
});

// ---- registry_weakened (.uni/config.toml [verifiers])

test('registry_weakened: an entry removed, its run changed, a files line removed or added', () => {
  const p = '.uni/config.toml';
  violates(run({ [p]: CONFIG.replace(/\[verifiers\."invariant\.fence-monotonic"\][^[]*/, '') }), 'registry_weakened', p);
  violates(run({ [p]: CONFIG.replace("run = 'node tests/mutations/run.mjs'", "run = 'true'") }), 'registry_weakened', p);
  violates(run({ [p]: CONFIG.replace('  "tests/mutations/**",\n', '') }), 'registry_weakened', p);
  violates(run({ [p]: CONFIG.replace('  "tests/mutations/**",\n', '  "tests/mutations/**",\n  "docs/**",\n') }), 'registry_weakened', p);
  violates(run({ [p]: CONFIG.replace('timeout = 2400\n', 'timeout = 2400\nexpect_not = "FAIL"\n') }), 'registry_weakened', p);
  violates(run({ [p]: `${CONFIG}\n[x]\nverifiers."suite.pnpm".run = 'true'\n` }), 'registry_weakened', p);
  violates(run({ [p]: null }), 'registry_weakened', p);
});

test('registry_weakened passes: a new entry, comments and blank lines changed', () => {
  const p = '.uni/config.toml';
  passes(run({ [p]: CONFIG.replace('# GitHub Actions OIDC.', '[verifiers."invariant.new-one"]\nrun = \'node --test tests/invariants/new.test.mjs\'\nfiles = ["server/**"]\n\n# GitHub Actions OIDC.') }));
  passes(run({ [p]: CONFIG.replace('# Trusted registry for uni/intents/delivery.uni.', '# Trusted registry, reworded.\n\n') }));
});

// ---- identity_changed, policy_changed

test('identity_changed: [identities] or .uni/identity/** different, in any direction', () => {
  violates(run({ '.uni/config.toml': CONFIG.replace('audiences = ["uni-cli"]', 'audiences = ["uni-cli", "other"]') }), 'identity_changed', '.uni/config.toml');
  violates(run({ '.uni/config.toml': CONFIG.replace('algorithms = ["RS256"]\n', '') }), 'identity_changed', '.uni/config.toml');
  violates(run({ '.uni/identity/github.jwks.json': '{"keys":[{"kid":"b"}]}\n' }), 'identity_changed', '.uni/identity/github.jwks.json');
  violates(run({ '.uni/identity/extra.json': '{}\n' }), 'identity_changed', '.uni/identity/extra.json');
  violates(run({ '.uni/identity/github.jwks.json': null }), 'identity_changed', '.uni/identity/github.jwks.json');
});

test('identity_changed passes: a comment in the identities table reworded', () => {
  passes(run({ '.uni/config.toml': CONFIG.replace('# GitHub Actions OIDC.', '# GitHub Actions OIDC, pinned keys.') }));
});

test('policy_changed: .uni/policies/** different, added or removed; untouched policies pass', () => {
  const base = { ...BASE, '.uni/policies/main.toml': 'max = 1\n' };
  violates(run({ '.uni/policies/main.toml': 'max = 2\n' }, { base }), 'policy_changed', '.uni/policies/main.toml');
  violates(run({ '.uni/policies/main.toml': null }, { base }), 'policy_changed', '.uni/policies/main.toml');
  violates(run({ '.uni/policies/new.toml': 'x = 1\n' }, { base }), 'policy_changed', '.uni/policies/new.toml');
  passes(run({ 'server/a.mjs': 'x\n' }, { base }));
});

test('uni runtime state is not the judge, but committing it is runtime_path (M1)', () => {
  for (const p of ['.uni/evidence/run.json', '.uni/decisions/d.json', '.uni/artifacts/a.bin', '.uni/events.jsonl', '.uni/events.2.jsonl', '.uni/.registry.snapshot']) {
    const r = run({ [p]: '{}\n' });
    assert.deepEqual(rules(r), ['runtime_path'], p);
    violates(r, 'runtime_path', p);
  }
});

test('runtime_path passes: names that only look like uni runtime state', () => {
  passes(run({}, { paths: ['docs/uni/evidence.md', 'tests/fixtures/.uni/evidence/x.json', '.uni-notes/events.jsonl'] }));
});

// ---- invariant_test_changed, invariant_without_mutant

test('invariant_test_changed: an existing invariant test or lib file modified or deleted', () => {
  violates(run({ 'tests/invariants/fence.test.mjs': "test('a zombie holder writes nothing after a reclaim', () => { return; });\n" }), 'invariant_test_changed', 'tests/invariants/fence.test.mjs');
  violates(run({ 'tests/invariants/clock-skew.test.mjs': null }), 'invariant_test_changed', 'tests/invariants/clock-skew.test.mjs');
  violates(run({ 'tests/invariants/lib/fixture.mjs': 'export const fixture = 2;\n' }), 'invariant_test_changed', 'tests/invariants/lib/fixture.mjs');
});

test('invariant_without_mutant: a new invariant test needs tests/mutations/<name>-*.patch; with one it passes', () => {
  const inv = 'tests/invariants/lease-expiry.test.mjs';
  violates(run({ [inv]: "test('x', () => {});\n" }), 'invariant_without_mutant', inv);
  // A patch named after a shorter invariant does not count (Ruling 4: longest prefix).
  violates(run({ 'tests/invariants/fence-extra.test.mjs': "test('x', () => {});\n", 'tests/mutations/fence-verify-2.patch': FENCE_PATCH }),
    'invariant_without_mutant', 'tests/invariants/fence-extra.test.mjs');
  passes(run({ [inv]: "test('x', () => {});\n", 'tests/mutations/lease-expiry-clock.patch': SKEW_PATCH, 'tests/invariants/lib/new-helper.mjs': 'export {};\n' }));
});

// ---- mutants_decreased, mutant_changed

test('mutants_decreased: fewer patches for an invariant than on base', () => {
  const r = run({ 'tests/mutations/fence-verify.patch': null });
  violates(r, 'mutants_decreased', 'tests/invariants/fence.test.mjs');
  violates(r, 'mutant_changed', 'tests/mutations/fence-verify.patch');
  // Renaming is a removal plus an addition: the old patch counts as changed.
  violates(run({ 'tests/mutations/fence-verify.patch': null, 'tests/mutations/fence-other.patch': FENCE_PATCH }), 'mutant_changed', 'tests/mutations/fence-verify.patch');
});

test('mutants_decreased passes: a new patch for an existing invariant', () => {
  passes(run({ 'tests/mutations/fence-second.patch': FENCE_PATCH.replace('# test: a zombie', '# test: a zombie') }));
});

test('mutant_changed: a -/+ line, the target file, or the "# test:" pattern differs from base', () => {
  const p = 'tests/mutations/fence-verify.patch';
  violates(run({ [p]: FENCE_PATCH.replace("-    if (!verified?.ok) return { error: fail('ledger_unavailable') };\n", '') .replace('@@ -661,6 +661,4 @@', '@@ -661,5 +661,4 @@') }), 'mutant_changed', p);
  violates(run({ [p]: FENCE_PATCH.replace('-    const verified', '-    const  verified') }), 'mutant_changed', p);
  violates(run({ [p]: FENCE_PATCH.replace('# test: a zombie holder writes nothing after a reclaim', '# test: .*') }), 'mutant_changed', p);
  violates(run({ [p]: FENCE_PATCH.replaceAll('server/runners/worktrees.mjs', 'server/runners/other.mjs') }), 'mutant_changed', p);
  violates(run({ [p]: 'not a patch at all\n' }), 'mutant_changed', p);
});

test('mutant_changed passes: a re-anchored patch with the same -/+ lines (context, line numbers, index, comments)', () => {
  const p = 'tests/mutations/fence-verify.patch';
  const reanchored = FENCE_PATCH
    .replace('# test: a zombie holder writes nothing after a reclaim\n', '# test: a zombie holder writes nothing after a reclaim\n# re-anchored after the lease refactor\n')
    .replace('index c3b3a8f..0b2b205 100644', 'index 1111111..2222222 100644')
    .replace('@@ -661,6 +661,4 @@ export function createWorktreeRunner(rt) {', '@@ -702,6 +702,4 @@ export function createWorktreeRunner(rt, opts) {')
    .replace('    if (held.error) return held;\n', '    if (held.error) return held; // held\n');
  passes(run({ [p]: reanchored }));
});

// ---- mergify_weakened

test('mergify_weakened: a condition removed or modified, a required check removed', () => {
  violates(run({ '.mergify.yml': MERGIFY.replace('    - label != hold-merge\n', '') }), 'mergify_weakened', '.mergify.yml');
  violates(run({ '.mergify.yml': MERGIFY.replace('    - -files ~= ^\\.env', '    - -files ~= ^\\.envx') }), 'mergify_weakened', '.mergify.yml');
  violates(run({ '.mergify.yml': MERGIFY.replace('    - check-success = @github-actions/uni\n', '') }), 'mergify_weakened', '.mergify.yml');
  violates(run({ '.mergify.yml': null }), 'mergify_weakened', '.mergify.yml');
});

test('mergify_weakened passes: a condition or a required check added, a comment changed', () => {
  passes(run({ '.mergify.yml': MERGIFY.replace('    - check-success = @github-actions/uni\n', '    - check-success = @github-actions/uni\n    - check-success = @github-actions/uni-ratchet\n    - -conflict\n') }));
  passes(run({ '.mergify.yml': MERGIFY.replace('# Memo Labs autoloop.', '# Memo Labs autoloop, reworded.') }));
});

test('mergify_weakened: lines moved, or added anywhere but as a plain land_conditions item (C1 probes)', () => {
  const m = '.mergify.yml';
  // The judge's checks moved out of land_conditions into a dummy key.
  violates(run({ [m]: MERGIFY.replace('    - check-success = @github-actions/test (22)\n    - check-success = @github-actions/uni\n', '')
    .replace('queue_rules:', 'unused:\n    - check-success = @github-actions/test (22)\n    - check-success = @github-actions/uni\n\nqueue_rules:') }), 'mergify_weakened', m);
  // A new author under or:.
  violates(run({ [m]: MERGIFY.replace('        - author = guillaume-flambard\n', '        - author = guillaume-flambard\n        - author = other[bot]\n') }), 'mergify_weakened', m);
  // The anchor redefined before queue_rules.
  violates(run({ [m]: MERGIFY.replace('queue_rules:', 'again:\n  land_conditions: &land_conditions\n    - base = main\n\nqueue_rules:') }), 'mergify_weakened', m);
  // A new, looser queue rule.
  violates(run({ [m]: `${MERGIFY}  - name: fast\n    queue_conditions:\n      - base = main\n    merge_conditions: []\n` }), 'mergify_weakened', m);
  // A duplicate merge_conditions key (the last one wins).
  violates(run({ [m]: `${MERGIFY}    merge_conditions:\n      - base = main\n` }), 'mergify_weakened', m);
  // An item at the list's indent that steals the children of or: (they become a scalar's continuation).
  violates(run({ [m]: MERGIFY.replace('    - or:\n', '    - or:\n    - -closed\n') }), 'mergify_weakened', m);
  // Structure inside an added item: an alias, a mapping, a nested or, a flow collection.
  for (const item of ['- *land_conditions', '- or:', '- not: x', '- key: value', '- [base = main]', '- {a: b}', '- &x base = main', '- !!null x', '- - nested'])
    violates(run({ [m]: MERGIFY.replace('    - label != hold-merge\n', `    - label != hold-merge\n    ${item}\n`) }), 'mergify_weakened', m);
  // Two base lines swapped: no longer an ordered subsequence.
  violates(run({ [m]: MERGIFY.replace('    - base = main\n    - -draft\n', '    - -draft\n    - base = main\n') }), 'mergify_weakened', m);
});

test('mergify_weakened passes: a plain condition inserted in the middle of land_conditions', () => {
  passes(run({ '.mergify.yml': MERGIFY.replace('    - label != hold-merge\n', '    - label != hold-merge\n    - label != wip\n    - -closed\n') }));
  passes(run({ '.mergify.yml': MERGIFY.replace('  land_conditions: &land_conditions\n', '  land_conditions: &land_conditions\n    - -conflict\n') }));
});

// ---- judge_changed

test('judge_changed: the uni job of ci.yml, uni-ratchet.yml, scripts/uni-ratchet.mjs, the mutation harness', () => {
  const ci = '.github/workflows/ci.yml';
  violates(run({ [ci]: CI.replace('      - run: uni check uni/intents/delivery.uni', '      - run: "true"') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('    permissions:\n      id-token: write\n', '    if: false\n    permissions:\n      id-token: write\n') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace(/  uni:[^]*$/, '') }), 'judge_changed', ci);
  violates(run({ [ci]: `${CI}  uni:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n` }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('jobs:\n', 'defaults:\n  run:\n    shell: "true {0}"\njobs:\n') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('  test:\n    runs-on: ubuntu-latest\n', '  test:\n    name: uni\n    runs-on: ubuntu-latest\n') }), 'judge_changed', ci);
  const noUniBase = { ...BASE, [ci]: CI.replace(/  uni:[^]*$/, '') };
  violates(run({ [ci]: `${CI}  uni:\n    runs-on: ubuntu-latest\n` }, { base: noUniBase }), 'judge_changed', ci);
  violates(run({ [ci]: null }), 'judge_changed', ci);
  violates(run({ '.github/workflows/uni-ratchet.yml': 'name: uni-ratchet\non: pull_request\n' }), 'judge_changed', '.github/workflows/uni-ratchet.yml');
  violates(run({ '.github/workflows/uni-ratchet.yml': null }), 'judge_changed', '.github/workflows/uni-ratchet.yml');
  violates(run({ 'scripts/uni-ratchet.mjs': '// the ratchet, loosened\n' }), 'judge_changed', 'scripts/uni-ratchet.mjs');
  violates(run({ 'tests/mutations/run.mjs': '// harness, loosened\n' }), 'judge_changed', 'tests/mutations/run.mjs');
  violates(run({ 'tests/mutations/count-reporter.mjs': null }), 'judge_changed', 'tests/mutations/count-reporter.mjs');
  violates(run({ 'tests/mutations/helper.mjs': 'export {};\n' }), 'judge_changed', 'tests/mutations/helper.mjs');
  violates(run({ 'tests/mutations/sub/a.patch': SKEW_PATCH }), 'judge_changed', 'tests/mutations/sub/a.patch');
  // A new workflow that publishes a check named like the judge's.
  violates(run({ '.github/workflows/fake.yml': 'name: fake\non: pull_request\njobs:\n  uni:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n' }), 'judge_changed', '.github/workflows/fake.yml');
  violates(run({ '.github/workflows/fake.yml': "jobs:\n  ok:\n    name: 'uni-ratchet'\n    runs-on: ubuntu-latest\n" }), 'judge_changed', '.github/workflows/fake.yml');
});

test('judge_changed passes: another job of ci.yml changed, the uni job added when base lacks it (Ruling 18), an unrelated workflow', () => {
  const ci = '.github/workflows/ci.yml';
  passes(run({ [ci]: CI.replace('      - run: pnpm test\n', '      - run: pnpm test\n      - run: pnpm run build\n') }));
  passes(run({ [ci]: CI.replace('  pull_request:\n', '  pull_request:\n  workflow_dispatch:\n') }));
  const noUni = { ...BASE, [ci]: CI.replace(/  uni:[^]*$/, '') };
  passes(run({ [ci]: CI }, { base: noUni }));
  passes(run({ [ci]: CI.replace('jobs:\n', 'defaults:\n  run:\n    shell: bash\njobs:\n') }, { base: noUni }));
  passes(run({ '.github/workflows/docs.yml': 'name: docs\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n' }));
  passes(run({ 'scripts/uni-ratchet.mjs': '// new\n' }, { base: { ...BASE, 'scripts/uni-ratchet.mjs': null } }));
});

const wf = jobs => `name: other\non: pull_request\njobs:\n${jobs}`;
test('judge_changed: a workflow that could publish a judge check or grant itself check writes (C2 probes)', () => {
  const ci = '.github/workflows/ci.yml'; const f = '.github/workflows/x.yml';
  violates(run({ [f]: wf("  a:\n    name: ${{ 'uni-ratchet' }}\n    runs-on: ubuntu-latest\n") }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    strategy:\n      matrix:\n        n: [uni]\n    name: ${{ matrix.n }}\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf('  "uni":\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [ci]: CI.replace('  test:\n', "  'uni-ratchet':\n    runs-on: ubuntu-latest\n  test:\n") }), 'judge_changed', ci);
  violates(run({ [f]: wf('  a:\n    name: test (22)\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf('  test:\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    name: Test\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  // The unfrozen test job given checks: write, to post a check run named uni-ratchet itself.
  violates(run({ [ci]: CI.replace('  test:\n    runs-on: ubuntu-latest\n', '  test:\n    runs-on: ubuntu-latest\n    permissions:\n      checks: write\n')
    .replace('      - run: pnpm test\n', '      - run: pnpm test\n      - run: gh api repos/o/r/check-runs -f name=uni-ratchet -f conclusion=success\n') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  statuses: write\n') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('permissions:\n  contents: read\n', 'permissions: write-all\n') }), 'judge_changed', ci);
  violates(run({ [ci]: CI.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n') }), 'judge_changed', ci);
  violates(run({ [f]: wf('  a:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: 'on: pull_request\njobs: { uni: { runs-on: ubuntu-latest } }\n' }), 'judge_changed', f);
});

test('judge_changed passes: ordinary workflow edits (step names with expressions, new steps, new plain jobs)', () => {
  const ci = '.github/workflows/ci.yml'; const f = '.github/workflows/x.yml';
  passes(run({ [ci]: CI.replace('      - run: pnpm test\n', '      - name: Test on ${{ matrix.node }}\n        run: pnpm test\n') }));
  passes(run({ [ci]: CI.replace('  test:\n', '  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n  test:\n') }));
  passes(run({ [f]: wf('  build:\n    name: Build docs\n    runs-on: ubuntu-latest\n    steps:\n      - name: uni\n        run: echo step names are not checks\n') }));
});

// Ruling 19: YAML quoting, escapes and explicit keys cannot hide a weakening (reviewer probes).
test('mergify_weakened: a quoted multi-line scalar that swallows base conditions (NEW1)', () => {
  const m = '.mergify.yml';
  violates(run({ [m]: MERGIFY.replace('    - label != hold-merge\n', "    - '-base ~= zzz\n    - label != hold-merge\n")
    .replace('    - check-success = @github-actions/test (22)\n', "    - check-success = @github-actions/test (22)\n    - zzz'\n") }), 'mergify_weakened', m);
  violates(run({ [m]: MERGIFY.replace('    - label != hold-merge\n', '    - "-base ~= zzz\n    - label != hold-merge\n') }), 'mergify_weakened', m);
  violates(run({ [m]: MERGIFY.replace('    - label != hold-merge\n', '    - label != hold-merge\n    - label != a\\b\n') }), 'mergify_weakened', m);
});

test('judge_changed: escaped or unterminated double-quoted job ids and names (NEW2)', () => {
  const ci = '.github/workflows/ci.yml'; const f = '.github/workflows/x.yml';
  violates(run({ [f]: wf('  "uni\\u002Dratchet":\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    name: "\\u0075ni"\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf("  \"t\\u0065st\":\n    strategy:\n      matrix:\n        node: ['22']\n    runs-on: ubuntu-latest\n") }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    name: "$\\u007B{ matrix.n }}"\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    name: "u\n      ni"\n    runs-on: ubuntu-latest\n') }), 'judge_changed', f);
  violates(run({ [ci]: CI.replace('  test:\n    runs-on: ubuntu-latest\n', '  test:\n    name: "uni\\u002Dratchet"\n    runs-on: ubuntu-latest\n') }), 'judge_changed', ci);
});

test('judge_changed: permissions hidden behind explicit ? / : keys or escaped quoted keys (NEW3)', () => {
  const ci = '.github/workflows/ci.yml'; const f = '.github/workflows/x.yml';
  violates(run({ [f]: 'on: pull_request\n? permissions\n:\n  ? checks\n  : write\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }), 'judge_changed', f);
  violates(run({ [ci]: CI.replace('  test:\n    runs-on: ubuntu-latest\n', '  test:\n    runs-on: ubuntu-latest\n    ? permissions\n    :\n      ? checks\n      : write\n') }), 'judge_changed', ci);
  violates(run({ [f]: 'on: pull_request\n"permi\\u0073sions":\n  "\\u0063hecks": write\njobs:\n  a:\n    runs-on: ubuntu-latest\n' }), 'judge_changed', f);
  violates(run({ [f]: wf('  a:\n    runs-on: ubuntu-latest\n    steps:\n      - "\\u0072un": gh api check-runs\n') }), 'judge_changed', f);
});

test('judge_changed passes: plain quoted job ids and names, backslashes in values, : inside values', () => {
  const f = '.github/workflows/x.yml';
  passes(run({ [f]: wf("  \"lint\":\n    name: \"Build docs\"\n    runs-on: ubuntu-latest\n    steps:\n      - name: 'Say ${{ matrix.x }}'\n        run: printf 'a\\nb: c\\n'\n      - run: echo \"x\\ty\"\n") }));
});

test('judge_changed: a local action used by the frozen uni job is judge; another local action is not', () => {
  const ci = '.github/workflows/ci.yml';
  const base = { ...BASE, [ci]: CI.replace('      - run: uni check uni/intents/delivery.uni', '      - uses: ./.github/actions/setup-uni\n      - run: uni check uni/intents/delivery.uni') };
  violates(run({}, { base, paths: ['.github/actions/setup-uni/action.yml'] }), 'judge_changed', '.github/actions/setup-uni/action.yml');
  passes(run({}, { base, paths: ['.github/actions/other/action.yml', '.github/actions/setup-uni-extra/action.yml'] }));
});

test('judge_changed: package.json test and install scripts, .npmrc, pnpm-workspace.yaml, .pnpmfile.cjs (I1)', () => {
  const pj = 'package.json';
  violates(run({ [pj]: PACKAGE.replace('"test": "node --test --test-timeout=180000 tests/*.test.mjs"', '"test": "true"') }), 'judge_changed', pj);
  violates(run({ [pj]: PACKAGE.replace('    "build":', '    "pretest": "exit 0",\n    "build":') }), 'judge_changed', pj);
  violates(run({ [pj]: PACKAGE.replace('    "build":', '    "postinstall": "node x.mjs",\n    "build":') }), 'judge_changed', pj);
  // A duplicate scripts key with an escaped name: JSON.parse reads "test": "true".
  violates(run({ [pj]: PACKAGE.replace('  "dependencies": {', '  "scripts": { "te\\u0073t": "true" },\n  "dependencies": {') }), 'judge_changed', pj);
  violates(run({ [pj]: PACKAGE.replace('  "type": "module",', '  "type": "module",\n  "pnpm": { "onlyBuiltDependencies": ["evil"] },') }), 'judge_changed', pj);
  violates(run({ [pj]: '{ not json' }), 'judge_changed', pj);
  violates(run({ [pj]: null }), 'judge_changed', pj);
  for (const p of ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs']) violates(run({ [p]: 'script-shell=/usr/bin/true\n' }), 'judge_changed', p);
  violates(run({ 'pnpm-workspace.yaml': 'packages: [b]\n' }, { base: { ...BASE, 'pnpm-workspace.yaml': 'packages: [a]\n' } }), 'judge_changed', 'pnpm-workspace.yaml');
});

test('judge_changed passes: package.json dependencies and other scripts changed', () => {
  passes(run({ 'package.json': PACKAGE.replace('"zod": "^4.0.0"', '"zod": "^4.1.0",\n    "ws": "^8.0.0"').replace('"build": "esbuild server/index.mjs"', '"build": "esbuild server/index.mjs --minify"').replace('tests/hub-auth.test.mjs"', 'tests/hub-auth.test.mjs tests/hub-state.test.mjs"') }));
});

// ---- secret_path

test('secret_path: any PR path matching (^|/)\\.env($|\\.)', () => {
  for (const p of ['.env', '.env.local', 'deploy/.env', 'deploy/.env.production']) violates(run({}, { paths: ['server/a.mjs', p] }), 'secret_path', p);
});

test('secret_path passes: names that only look like it', () => {
  passes(run({}, { paths: ['.envrc', 'docs/env.md', 'server/dotenv.mjs', 'deploy/my.env'] }));
});

// ---- hold_removed

const labeled = (label, actor) => ({ event: 'labeled', label, actor });
const unlabeled = (label, actor) => ({ event: 'unlabeled', label, actor });

test('hold_removed: hold-merge set by guillaume-flambard and removed by another account', () => {
  violates(run({}, { paths: [], labelEvents: [labeled('hold-merge', 'guillaume-flambard'), unlabeled('hold-merge', 'memo-labs-automation[bot]')] }), 'hold_removed');
  violates(run({}, { paths: [], labelEvents: [labeled('hold-merge', 'guillaume-flambard'), labeled('hold-merge', 'memo-labs-automation[bot]'), unlabeled('hold-merge', 'memo-labs-automation[bot]')] }), 'hold_removed');
});

test('hold_removed passes: the owner lifts his own hold, a hold set by another account, another label', () => {
  passes(run({}, { paths: [], labelEvents: [labeled('hold-merge', 'guillaume-flambard'), unlabeled('hold-merge', 'guillaume-flambard')] }));
  passes(run({}, { paths: [], labelEvents: [labeled('hold-merge', 'memo-labs-automation[bot]'), unlabeled('hold-merge', 'memo-labs-automation[bot]')] }));
  passes(run({}, { paths: [], labelEvents: [labeled('needs-human-review', 'guillaume-flambard'), unlabeled('needs-human-review', 'someone')] }));
  // Set again by the owner after his own removal, the hold is his again.
  violates(run({}, { paths: [], labelEvents: [labeled('hold-merge', 'guillaume-flambard'), unlabeled('hold-merge', 'guillaume-flambard'),
    labeled('hold-merge', 'guillaume-flambard'), unlabeled('hold-merge', 'x')] }), 'hold_removed');
});

test('several violations are all reported, each with its rule and path', () => {
  const r = run({ '.mergify.yml': MERGIFY.replace('    - -draft\n', ''), 'tests/mutations/run.mjs': '//\n' }, { paths: ['.env', '.mergify.yml', 'tests/mutations/run.mjs'] });
  assert.deepEqual(rules(r), ['judge_changed', 'mergify_weakened', 'secret_path']);
});

// ---- the CLI, against a fake GitHub API

const sha = text => createHash('sha1').update(text).digest('hex');
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

// A fake `gh api`: base and head trees built from file maps, paginated PR files, issue events
// and comments. Records every call; fails any call it does not know.
function fakeGitHub({ base = BASE, head = BASE, files = ['server/a.mjs'], changedFiles, events = [], comments = [], fail = {}, truncated = false, pull = {} } = {}) {
  const blobs = new Map();
  const tree = files => ({ truncated, tree: Object.entries(files).filter(([, v]) => v !== null).map(([path, content]) => {
    blobs.set(sha(content), content);
    return { path, type: 'blob', mode: '100644', sha: sha(content) };
  }).concat([{ path: 'server', type: 'tree', sha: 'c'.repeat(40) }]) });
  const trees = { [BASE_SHA]: tree(base), [HEAD_SHA]: tree(head) };
  const calls = [];
  const page = (list, path) => {
    const p = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    return list.slice((p - 1) * 100, p * 100);
  };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const [pattern, error] of Object.entries(fail)) if (path.includes(pattern)) throw new Error(error);
    if (method === 'GET') {
      if (path === 'repos/o/r/pulls/7') return { number: 7, changed_files: changedFiles ?? files.length, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA }, ...pull };
      if (path.startsWith('repos/o/r/pulls/7/files?')) return page(files.map(filename => ({ filename })), path);
      if (path.startsWith('repos/o/r/issues/7/events?')) return page(events.map(e => ({ event: e.event, label: { name: e.label }, actor: { login: e.actor } })), path);
      if (path.startsWith('repos/o/r/issues/7/comments?')) return page(comments, path);
      let m;
      if ((m = /^repos\/o\/r\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path)) && trees[m[1]]) return trees[m[1]];
      if ((m = /^repos\/o\/r\/git\/blobs\/([0-9a-f]{40})$/.exec(path)) && blobs.has(m[1])) return { encoding: 'base64', content: Buffer.from(blobs.get(m[1])).toString('base64') };
    }
    if (method === 'POST' && path === 'repos/o/r/issues/7/comments') return { id: 99 };
    if (method === 'PATCH' && /^repos\/o\/r\/issues\/comments\/\d+$/.test(path)) return { id: Number(path.split('/').pop()) };
    throw new Error(`fake gh: unexpected ${method} ${path}`);
  };
  return { api, calls, writes: () => calls.filter(c => c.method !== 'GET') };
}

async function cli(gh, { env = {}, argv = ['--repo', 'o/r', '--pr', '7', '--base', BASE_SHA, '--head', HEAD_SHA], compile = fakeCompile } = {}) {
  let stdout = ''; let stderr = '';
  const code = await main(argv, { api: gh.api, compile, env, out: { write: s => { stdout += s; } }, err: { write: s => { stderr += s; } } });
  return { code, stdout, stderr };
}

test('cli: no violation exits 0 and writes nothing', async () => {
  const gh = fakeGitHub({ head: { ...BASE, 'server/a.mjs': 'x\n' } });
  const r = await cli(gh);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.writes(), []);
  assert.ok(gh.calls.every(c => c.method === 'GET'));
});

test('cli: violations exit 1 and post one marked comment naming each rule and path', async () => {
  const gh = fakeGitHub({ head: { ...BASE, '.mergify.yml': MERGIFY.replace('    - -draft\n', '') }, files: ['.mergify.yml', '.env'] });
  const r = await cli(gh);
  assert.equal(r.code, 1);
  const writes = gh.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].path, 'repos/o/r/issues/7/comments');
  assert.ok(writes[0].body.body.startsWith(MARKER));
  assert.match(writes[0].body.body, /mergify_weakened.*\.mergify\.yml/);
  assert.match(writes[0].body.body, /secret_path.*\.env/);
});

test('cli: an existing marked comment by github-actions is updated in place, nothing is deleted', async () => {
  const comments = [{ id: 5, user: { login: 'someone' }, body: `${MARKER}\nforged` }, { id: 6, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nold` }];
  const gh = fakeGitHub({ files: ['.env'], comments });
  const r = await cli(gh);
  assert.equal(r.code, 1);
  assert.deepEqual(gh.writes().map(w => `${w.method} ${w.path}`), ['PATCH repos/o/r/issues/comments/6']);
});

test('cli: DRY_RUN=1 prints the comment instead of writing it, and still exits 1', async () => {
  const gh = fakeGitHub({ files: ['.env'] });
  const r = await cli(gh, { env: { DRY_RUN: '1' } });
  assert.equal(r.code, 1);
  assert.deepEqual(gh.writes(), []);
  assert.match(r.stdout, /would comment on o\/r#7/);
  assert.ok(r.stdout.includes(MARKER));
});

test('cli: PR files and label events are read across every page', async () => {
  const files = Array.from({ length: 150 }, (_, i) => `server/f${i}.mjs`).concat(['deploy/.env']);
  const events = Array.from({ length: 120 }, () => labeled('other', 'x')).concat([labeled('hold-merge', 'guillaume-flambard'), unlabeled('hold-merge', 'bot')]);
  const r = await cli(fakeGitHub({ files, events }), { env: { DRY_RUN: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /secret_path.*deploy\/\.env/);
  assert.match(r.stdout, /hold_removed/);
});

test('cli fails closed: an API error, a truncated tree, a file list shorter than changed_files, a bad blob', async () => {
  for (const [name, gh] of [
    ['api error', fakeGitHub({ fail: { 'git/trees': 'HTTP 502' } })],
    ['events error', fakeGitHub({ fail: { 'issues/7/events': 'HTTP 403' } })],
    ['truncated tree', fakeGitHub({ truncated: true })],
    ['incomplete files', fakeGitHub({ files: ['server/a.mjs'], changedFiles: 3001 })],
    ['blob error', fakeGitHub({ head: { ...BASE, '.mergify.yml': `${MERGIFY}# x\n` }, fail: { 'git/blobs/': 'HTTP 404' } })]
  ]) {
    const r = await cli(gh, { env: { DRY_RUN: '1' } });
    assert.equal(r.code, 1, name);
    assert.match(r.stdout + r.stderr, /ratchet_error/, name);
  }
});

test('cli fails closed when uni compile fails on a changed contract', async () => {
  const gh = fakeGitHub({ head: { ...BASE, 'uni/intents/delivery.uni': CONTRACT.replace('CLAIM suite REQUIRED', 'CLAIM suite REQUIRED CRITICAL') } });
  const r = await cli(gh, { env: { DRY_RUN: '1' }, compile: () => { throw new Error('uni: not found'); } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ratchet_error|contract_weakened/);
});

test('cli fails closed when the PR head or base moved away from the shas it was asked to judge (M4)', async () => {
  for (const moved of [{ head: { sha: 'd'.repeat(40) } }, { base: { sha: 'd'.repeat(40) } }]) {
    const gh = fakeGitHub({ pull: moved });
    const r = await cli(gh, { env: { DRY_RUN: '1' } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /ratchet_error.*moved/);
  }
});

test('cli: a failed comment write still exits 1', async () => {
  const gh = fakeGitHub({ files: ['.env'], fail: { 'issues/7/comments': 'HTTP 403' } });
  const r = await cli(gh);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 403/);
});

test('cli: bad arguments exit 1 without calling GitHub', async () => {
  for (const argv of [[], ['--repo', 'o/r', '--pr', 'x', '--base', BASE_SHA, '--head', HEAD_SHA], ['--repo', 'o/r', '--pr', '7', '--base', 'main', '--head', HEAD_SHA]]) {
    const gh = fakeGitHub();
    const r = await cli(gh, { argv });
    assert.equal(r.code, 1);
    assert.deepEqual(gh.calls, []);
  }
});

// ---- the real compiler, when installed (CI installs uni only in the uni job)

const uniInstalled = spawnSync(process.env.UNI_BIN || 'uni', ['--version'], { encoding: 'utf8' }).status === 0;
test('compileWithUni returns the canonical IR of uni compile and throws on a contract it rejects', { skip: !uniInstalled && 'uni is not installed' }, () => {
  const ir = compileWithUni(CONTRACT);
  assert.equal(ir.intent.id, 'memo-bridge.delivery');
  assert.deepEqual(ir.claims.map(c => [c.id, c.required, c.critical]), [['suite', true, false], ['fence-monotonic', true, true], ['mutants-killed', true, true]]);
  assert.throws(() => compileWithUni(`${CONTRACT}garbage\n`), /uni compile/);
  const weakened = ratchet({ base: map(BASE), head: map({ ...BASE, 'uni/intents/delivery.uni': CONTRACT.replace('INVARIANT mutants-killed CRITICAL', 'INVARIANT mutants-killed') }),
    paths: [], compileContract: compileWithUni, labelEvents: [] });
  violates(weakened, 'contract_weakened', 'uni/intents/delivery.uni');
});
