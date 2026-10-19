// The two checks of the delivery gate (docs/UNI_DELIVERY.md): the `uni` job of ci.yml and the
// uni-ratchet workflow. Structural regressions read line by line, like the ratchet that freezes
// both once they are on main; GitHub's own run of the workflows remains the real proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ci = read('.github/workflows/ci.yml');
const ratchetWorkflow = read('.github/workflows/uni-ratchet.yml');
const UNI_SHA256 = 'cdfdaa1a8c91973343089a22c7868c27679a705aa247e58b9e7e76f277e52c9f';

// From `  <job>:` to the next line indented two spaces or less.
function job(text, id) {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (l === `  ${id}:` ? [i] : []));
  assert.equal(starts.length, 1, `exactly one ${id} job`);
  let end = starts[0] + 1;
  while (end < lines.length && !/^ {0,2}[^\s#]/.test(lines[end])) end++;
  return lines.slice(starts[0], end).join('\n');
}
// The body of every `run: |` block.
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: \|\s*$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || lines[j].length - lines[j].trimStart().length > m[1].length); j++) body.push(lines[j]);
    blocks.push(body.join('\n'));
  }
  return blocks;
}
const noAnchors = (text, label) => {
  for (const line of text.split('\n').filter(l => !l.trimStart().startsWith('#'))) {
    assert.doesNotMatch(line, /(^|[\s:[,-])[&*][A-Za-z0-9_-]+|<<\s*:/, `${label}: YAML anchor, alias or merge key: ${line.trim()}`);
  }
};

test('uni job: Node 24, 25 minutes, OIDC only, the exact head commit, a pinned uni', () => {
  const uni = job(ci, 'uni');
  // Shell inside run scripts may use & and *; every YAML line around them may not.
  const scripts = new Set(runBlocks(uni).flatMap(b => b.split('\n')));
  noAnchors(uni.split('\n').filter(l => !scripts.has(l)).join('\n'), 'uni job');
  assert.match(uni, /\n {4}name: uni\n/);
  assert.match(uni, /\n {4}timeout-minutes: 25\n/);
  assert.match(uni, /\n {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}concurrency:/);
  assert.match(uni, /group: uni-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/);
  assert.match(uni, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(uni, /node-version: '24'/);
  assert.match(uni, /pnpm\/action-setup@/);
  assert.match(uni, /MEMO_BRIDGE_REQUIRE_GOVERNANCE: '1'/);
  assert.match(uni, /repository: memolabs-dev\/\.github/);
  assert.ok(uni.includes(`UNI_SHA256: ${UNI_SHA256}`));
  assert.match(uni, /sha256sum -c --strict/);
  assert.doesNotMatch(uni, /continue-on-error|actions\/cache|if: always\(\)/);
});

test('uni job: the token is minted apart, kept from the PR code, and the verdict is this run\'s stdout', () => {
  const uni = job(ci, 'uni');
  const runs = runBlocks(uni);
  for (const body of runs) assert.doesNotMatch(body, /\$\{\{/, 'no expression inside a run script');
  const mint = runs.find(b => b.includes('audience=uni-cli'));
  const verify = runs.find(b => b.includes('"$uni" verify --json uni/intents/delivery.uni'));
  assert.ok(mint && verify && mint !== verify, 'minting and verifying are two steps');
  assert.match(mint, /::add-mask::\$jwt/);
  // The verdict is captured from stdout into a variable, never a file another process could write.
  assert.match(verify, /out=\$\(env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \\\n\s+"\$uni" verify --json uni\/intents\/delivery\.uni\) \|\| status=\$\?/);
  assert.match(verify, /\[ "\$count" = 1 \] \|\| fail "uni verify printed/);
  assert.match(verify, /jq -s 'length'/);
  assert.match(uni, /UNI_IDENTITY_TOKEN: \$\{\{ steps\.token\.outputs\.jwt \}\}/);
  for (const needle of ['.decision == "Accepted"', '.commit_sha == $sha', '.workspace_dirty == false', '.actor.assurance == "verified"',
    '.actor.id != .executor.id', '.assurance == "A3"', '.independent_actor == true', 'git status --porcelain', 'git rev-parse HEAD',
    '"$uni" explain --annotations']) {
    assert.ok(verify.includes(needle), `verify step checks ${needle}`);
  }
  assert.doesNotMatch(verify, /decisions\/last\.json/);
});

test('uni-ratchet: pull_request_target from the base, least privilege, data through env', () => {
  noAnchors(ratchetWorkflow, 'uni-ratchet.yml');
  assert.match(ratchetWorkflow, /\n {2}pull_request_target:\n(?: {4}#.*\n)* {4}types: \[opened, reopened, synchronize, ready_for_review, labeled, unlabeled, edited\]\n/);
  assert.match(ratchetWorkflow, /\npermissions: \{\}\n/);
  const body = job(ratchetWorkflow, 'uni-ratchet');
  assert.match(body, /\n {4}name: uni-ratchet\n/);
  assert.match(body, /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  const perms = body.split('\n').filter(l => /^ {6}[a-z-]+: (read|write)$/.test(l)).map(l => l.trim());
  assert.deepEqual(perms, ['contents: read', 'pull-requests: write', 'issues: read']);
  assert.match(body, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+persist-credentials: false/);
  assert.doesNotMatch(body, /ref: \$\{\{ github\.event\.pull_request\.head/);
  assert.ok(body.includes(`UNI_SHA256: ${UNI_SHA256}`));
  for (const run of runBlocks(body)) assert.doesNotMatch(run, /\$\{\{/, 'no expression inside a run script');
  assert.match(body, /node scripts\/uni-ratchet\.mjs --repo "\$REPO" --pr "\$PR" --base "\$BASE_SHA" --head "\$HEAD_SHA"/);
});

// Each run script with its `\`-continued lines joined, so one command is one line.
const commands = text => runBlocks(text).flatMap(b => b.replace(/\\\n\s*/g, ' ').split('\n'));

test('uni job and uni-ratchet fail closed: every command substitution is guarded, uni is called by path', () => {
  for (const [label, text] of [['uni job', job(ci, 'uni')], ['uni-ratchet.yml', ratchetWorkflow]]) {
    const lines = commands(text);
    assert.ok(lines.length > 10, `${label}: run scripts found`);
    for (const line of lines.filter(l => l.includes('$('))) {
      // name=$(...) || fail ... / || { ...; exit 1; } / || status=$?: a failing command is never an empty answer.
      assert.match(line, /^\s*[a-z_]+=\$\(.*\)\s*\|\|\s*(fail\b|\{ .*exit 1; \}|status=\$\?)/, `${label}: unguarded command substitution: ${line.trim()}`);
    }
    for (const line of lines) {
      assert.doesNotMatch(line, /(^|[\s;(|&])uni\s+(verify|report|explain|compile|--version)\b/, `${label}: uni looked up on PATH: ${line.trim()}`);
    }
    assert.doesNotMatch(text, /GITHUB_PATH/, `${label}: nothing is added to PATH`);
    for (const body of runBlocks(text)) assert.match(body, /^\s*set -euo pipefail$/m, `${label}: every script runs with set -euo pipefail`);
  }
  assert.match(ratchetWorkflow, /UNI_BIN: \$\{\{ runner\.temp \}\}\/uni-bin\/uni/);
});
