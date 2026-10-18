#!/usr/bin/env node
// The template every project_create repository starts from (owner console D-A2-3, spec section 09):
// its source is templates/project/ in this repository, published once as the GitHub template
// repository memolabs-dev/project-template.
//
//   node scripts/project-template.mjs check              the template agrees with memo-bridge
//   node scripts/project-template.mjs publish            what publish would do (dry run)
//   node scripts/project-template.mjs publish --execute  create and push it (the owner, once)
//
// check: every file is there; .github/workflows/sensitive-paths.yml is byte-identical to
// memo-bridge's; the `-files` pattern of .mergify.yml is memo-bridge's own; the one
// `check-success` names the CI job; the test script runs without dependencies.
//
// publish runs under the owner's own gh login (it needs the `workflow` scope, since the
// template carries workflow files; the memo-labs-automation App has no workflows permission).
// Every file in the template is a gate file, which is why the owner publishes it. It never
// overwrites: an existing template is left as is, and changes to it go through a pull request
// on memolabs-dev/project-template.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEMPLATE_DIR = join(ROOT, 'templates', 'project');
export const TEMPLATE_REPO = 'memolabs-dev/project-template';
export const TEMPLATE_FILES = Object.freeze(['.github/workflows/ci.yml', '.github/workflows/sensitive-paths.yml', '.gitignore',
  '.mergify.yml', 'AGENTS.md', 'README.md', 'package.json', 'test/smoke.test.mjs']);

const read = path => readFileSync(join(TEMPLATE_DIR, path), 'utf8');

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path)];
  }).sort();
}

// The `-files ~=` pattern of a Mergify file, unquoted the way the sensitive-paths workflow does.
export function filesPattern(text) {
  const line = text.split('\n').find(l => l.includes('-files ~='));
  if (!line) return null;
  let re = line.slice(line.indexOf('-files ~=') + '-files ~= '.length).trim();
  if (line.includes('"')) re = re.replace(/"$/, '').replace(/\\\\/g, '\\');
  return re;
}

export function checkTemplate() {
  const problems = [];
  const files = listFiles(TEMPLATE_DIR);
  if (JSON.stringify(files) !== JSON.stringify([...TEMPLATE_FILES].sort())) problems.push(`files: ${files.join(', ')}`);
  const own = readFileSync(join(ROOT, '.github', 'workflows', 'sensitive-paths.yml'), 'utf8');
  if (read('.github/workflows/sensitive-paths.yml') !== own) problems.push('sensitive-paths.yml differs from memo-bridge\'s');
  const mergify = read('.mergify.yml');
  if (filesPattern(mergify) !== filesPattern(readFileSync(join(ROOT, '.mergify.yml'), 'utf8'))) problems.push('.mergify.yml -files pattern differs');
  if (!/^\s+- "-files ~= /m.test(mergify)) problems.push('.mergify.yml: the -files line is not in the quoted style');
  const checks = [...mergify.matchAll(/check-success = @github-actions\/([^"\n]+)"/g)].map(m => m[1]);
  const ci = read('.github/workflows/ci.yml');
  const jobs = [...ci.slice(ci.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map(m => m[1]);
  if (JSON.stringify(checks) !== JSON.stringify(['check']) || JSON.stringify(jobs) !== JSON.stringify(['check'])) {
    problems.push(`checks ${checks.join(',')} vs jobs ${jobs.join(',')}: one required check named check`);
  }
  const manifest = JSON.parse(read('package.json'));
  if (manifest.scripts?.test !== 'node --test' || manifest.dependencies || manifest.devDependencies) problems.push('package.json: node --test, no dependency');
  if (/[–—]/.test(read('README.md') + read('AGENTS.md'))) problems.push('no dashes in README.md and AGENTS.md');
  return problems;
}

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function publish(execute) {
  let existing = null;
  try { existing = JSON.parse(gh(['api', `repos/${TEMPLATE_REPO}`])); } catch { existing = null; }
  if (existing) {
    console.log(JSON.stringify({ ok: true, published: true, is_template: existing.is_template === true,
      detail: `${TEMPLATE_REPO} exists: left as is; change it through a pull request there` }));
    return existing.is_template === true ? 0 : 1;
  }
  const plan = [`gh api -X POST orgs/memolabs-dev/repos name=project-template private=false is_template=true`,
    `git push ${TEMPLATE_FILES.length} files of templates/project/ to ${TEMPLATE_REPO} main (one commit)`,
    `gh api -X PATCH repos/${TEMPLATE_REPO} is_template=true delete_branch_on_merge=true`];
  if (!execute) { console.log(JSON.stringify({ ok: true, dry_run: true, plan })); return 0; }
  gh(['api', '-X', 'POST', 'orgs/memolabs-dev/repos', '-f', 'name=project-template', '-F', 'private=false', '-F', 'is_template=true',
    '-F', 'has_wiki=false', '-f', 'description=Template of new Memo Labs projects (memo-bridge project_create): CI, Mergify, gate paths']);
  const work = mkdtempSync(join(tmpdir(), 'project-template-'));
  try {
    cpSync(TEMPLATE_DIR, work, { recursive: true });
    const git = args => execFileSync('git', ['-C', work, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Memo Labs project template (memo-bridge templates/project)']);
    git(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-q',
      `https://github.com/${TEMPLATE_REPO}.git`, 'main']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  gh(['api', '-X', 'PATCH', `repos/${TEMPLATE_REPO}`, '-F', 'is_template=true', '-F', 'delete_branch_on_merge=true']);
  console.log(JSON.stringify({ ok: true, published: true, repo: TEMPLATE_REPO }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, flag] = process.argv.slice(2);
  if (command === 'check') {
    const problems = checkTemplate();
    console.log(JSON.stringify(problems.length ? { ok: false, problems } : { ok: true, files: TEMPLATE_FILES.length }));
    process.exitCode = problems.length ? 1 : 0;
  } else if (command === 'publish') {
    const problems = checkTemplate();
    if (problems.length) { console.log(JSON.stringify({ ok: false, problems })); process.exitCode = 1; }
    else process.exitCode = publish(flag === '--execute');
  } else {
    console.error('usage: project-template.mjs check | publish [--execute]');
    process.exitCode = 2;
  }
}
