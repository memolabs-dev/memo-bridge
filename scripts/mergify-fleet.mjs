#!/usr/bin/env node
// Read-only fleet readiness & Mergify config candidate for any Memo Labs repo.
// NEVER installs Apps, enables a workflow, changes settings or merges PRs.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,99}$/;
const CHECK = /^[^\r\n"'\\@\x00-\x1f]{1,120}$/;
const AUTHOR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,90}\[bot\]$/;
// Baseline sensitive paths. Not proof that remaining files are safe.
export const BASE_DENY = String.raw`^(\.github/|\.mergify\.yml$|\.gitlab/|\.circleci/|\.env|\.npmrc$|\.pypirc$|\.cargo/|AGENTS\.md$|CODEOWNERS$|Dockerfile|Containerfile|Makefile$|Justfile$|server/|bridge/|plugin/|src/|app/|apps/|lib/|pkg/|cmd/|internal/|packages/|ios/|android/|native/|backend/|frontend/|web/|mobile/|deploy/|deployment/|docker/|infra/|infrastructure/|ansible/|terraform/|stacks/|scripts/|tests/|test/|__tests__/|config/|configs/|secrets/|migrations/|database/|db/|\.changeset/|package\.json$|pnpm-lock\.yaml$|yarn\.lock$|package-lock\.json$|Cargo\.(toml|lock)$|Package\.swift$|go\.(mod|sum)$|pyproject\.toml$|requirements.*\.txt$|.*\.(ts|tsx|js|jsx|mjs|cjs|rs|swift|py|go|sh|bash|zsh|tf|tfvars|yml|yaml|json|toml|xml|plist)$)`;

export function auditRecord(item) {
  if (!item || typeof item !== 'object') return { eligible: false, blockers: ['missing_snapshot'], activation_authorized: false };
  const blockers = [];
  if (!REPO.test(item.repo ?? '') || item.accessible !== true) blockers.push('repo_not_verified');
  if (item.archived === true) blockers.push('archived_repo');
  if (!BRANCH.test(item.defaultBranch ?? '')) blockers.push('default_branch_unknown');
  if (!Array.isArray(item.checks) || item.checks.length === 0) blockers.push('ci_checks_unverified');
  if (item.checks?.some(c => !CHECK.test(c))) blockers.push('ci_check_name_invalid');
  if (item.legacyMerger !== 'disabled' && item.legacyMerger !== 'absent') blockers.push('legacy_merger_not_isolated');
  if (item.mergifyVerified !== true) blockers.push('mergify_access_not_verified');
  if (item.branchRulesReviewed !== true) blockers.push('branch_rules_not_reviewed');
  if (item.canaryPassed !== true) blockers.push('positive_negative_canaries_missing');
  return {
    repo: item.repo, eligible: blockers.length === 0, blockers,
    // Never infer authority to mutate a GitHub repo from a JSON snapshot.
    activation_authorized: false, observed_at: item.observedAt ?? null
  };
}

const q = value => JSON.stringify(value);
export function renderCandidate({
  repo, branch, checks, cutoff, author = 'memo-labs-automation[bot]',
  denyPattern = BASE_DENY, maxFiles = 8, maxAdded = 400, maxDeleted = 150,
  now = new Date()
} = {}) {
  if (!REPO.test(repo ?? '')) throw new Error('invalid_repo');
  if (!BRANCH.test(branch ?? '')) throw new Error('invalid_branch');
  if (!AUTHOR.test(author)) throw new Error('invalid_bot_author');
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 30 ||
      checks.some(c => !CHECK.test(c)) || new Set(checks).size !== checks.length) {
    throw new Error('invalid_checks');
  }
  if (typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cutoff) ||
      Number.isNaN(Date.parse(cutoff)) || Date.parse(cutoff) <= +now) {
    throw new Error('cutoff_must_be_future_utc');
  }
  for (const n of [maxFiles, maxAdded, maxDeleted]) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000) throw new Error('invalid_size_limit');
  }
  if (typeof denyPattern !== 'string' || !denyPattern.startsWith(BASE_DENY) ||
      denyPattern.length > 5000) throw new Error('unsafe_deny_pattern');
  try { new RegExp(denyPattern); } catch { throw new Error('invalid_deny_pattern'); }
  const requirements = [
    'base = ' + branch, '-draft', '-from-fork', 'author = ' + author,
    'created-at >= ' + cutoff, 'label != hold-merge',
    'label != needs-human-review', '#files <= ' + maxFiles,
    '#added-lines <= ' + maxAdded, '#deleted-lines <= ' + maxDeleted,
    '-files ~= ' + denyPattern,
    ...checks.map(c => 'check-success = @github-actions/' + c)
  ];
  return [
    '# CANDIDATE ONLY: never install before exclusive-controller verification.',
    '# Target: ' + repo + '. Refresh cutoff immediately before activation.',
    'merge_queue:', '  max_parallel_checks: 1', '',
    'merge_protections_settings:', '  auto_merge_conditions:',
    ...requirements.map(c => '    - ' + q(c)), '',
    'queue_rules:', '  - name: memo-labs-safe-auto',
    '    batch_size: 1', '    merge_method: squash',
    '    queue_conditions: &safe_auto_conditions',
    ...requirements.map(c => '      - ' + q(c)),
    '    merge_conditions: *safe_auto_conditions', ''
  ].join('\n');
}

export async function cli(argv, { out = console.log, err = console.error } = {}) {
  const [verb, filename, ...rest] = argv;
  if (!['audit', 'candidate'].includes(verb) || !filename || rest.length > 2) {
    err('Usage: node scripts/mergify-fleet.mjs audit <snapshot.json> | candidate <snapshot.json> <org/repo> <future-UTC-cutoff>');
    return 2;
  }
  const snapshot = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(snapshot.repositories)) throw new Error('invalid_snapshot');
  if (verb === 'audit') {
    if (rest.length) throw new Error('audit_takes_no_extra_args');
    out(JSON.stringify({ observedAt: snapshot.observedAt, results: snapshot.repositories.map(auditRecord) }, null, 2));
    return 0;
  }
  const [repo, cutoff] = rest;
  const row = snapshot.repositories.find(x => x.repo === repo);
  if (!row) throw new Error('repo_not_in_snapshot');
  if (row.accessible !== true || !row.checks?.length) throw new Error('unverified_repo_checks');
  // Candidate generation is permitted for not-yet-ready repos; no mutations.
  out(renderCandidate({ repo, branch: row.defaultBranch, checks: row.checks, cutoff }));
  err('CANDIDATE ONLY. Verify Mergify access, protection, old merger shutdown, canaries; no activation performed.');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
