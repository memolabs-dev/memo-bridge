// GitHub integration for Memo Bridge: compact, bounded reads of Issues, pull requests, workflow
// runs and checks, plus pull request creation. Every call goes through `gh api` with a fixed
// argv (no shell) under the operator's gh login. The `gh` runner is injectable so tests never
// reach the real GitHub.
//
// On the VPS runner (GitHub App tokens) every call gets a token of the runtime credentials
// provider for that one repository: createPull, and the reads of the same flow called with
// {auth: 'pull_request'}, the pull_request token (contents:write, pull_requests:write); batch
// labels and Issues the issues token (issues:write); every other read the read token. A token
// reaches only that gh child, as GH_TOKEN with a private GH_CONFIG_DIR created for the call and
// removed after it; process.env is never modified. Without systemd credentials (the Mac), or on
// the VPS without the App, gh runs as before.
//
// Scope: only repositories that are the GitHub origin of a project registered in PROJECTS.md,
// plus memolabs-dev/.github (governance). Nothing here merges a pull request or enables
// auto-merge: the landing contract of memolabs-dev/.github lands pull requests.
import { spawn, execFile } from 'node:child_process';
import { realpath, rm, stat } from 'node:fs/promises';
import { ghChildEnv, privateConfigDir } from '../coordinator/credentials.mjs';
import { projectInfo, readProjectRegistry } from '../catalog.mjs';
import { gitHubRemote } from '../coordinator/index.mjs';
import { validBranch } from '../coordinator/checkpoints.mjs';

export const GOVERNANCE_REPO = 'memolabs-dev/.github';
export const LIMITS = Object.freeze({
  list: { min: 1, max: 100, default: 30 },
  title: 256,
  body: 20000,
  issueBody: 8000,
  labels: 10,
  label: 50,
  mergeableLookups: 10,
  response: 4 * 1024 * 1024
});

// owner: GitHub login rules; repo: GitHub name characters, never '.' or '..'.
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CACHE_MS = 60_000;

export function parseRepo(value) {
  const match = typeof value === 'string' ? REPO_RE.exec(value) : null;
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return { full: value, owner: match[1], name: match[2] };
}

// Text that came from GitHub is read by models: drop control characters and bidirectional
// overrides, keep it on one line unless asked, and bound its length.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function cleanText(value, max, { multiline = false } = {}) {
  if (value === undefined || value === null) return null;
  let text = String(value).replace(CONTROL, '');
  text = multiline ? text.replace(/\r\n?/g, '\n') : text.replace(/[\t\n\r]+/g, ' ');
  text = text.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
// Input written by a model and sent to GitHub: refuse rather than silently rewrite.
const INPUT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export function validInputText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || INPUT_CONTROL.test(value)) return false;
  return multiline || !/[\t\n\r]/.test(value);
}

const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });

// Default runner: `gh api …` in its own process group, so a timeout kills gh and anything it
// started; a request cannot complete after we reported failure. Output is capped.
export function runGh(args, { input, timeoutMs = 30_000, env = process.env, maxBytes = LIMITS.response } = {}) {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false; let settled = false;
    let child;
    try {
      child = spawn('gh', args, {
        detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat', CLICOLOR: '0' }
      });
    } catch {
      return resolve({ code: -1, stdout: '', stderr: '', spawnFailed: true });
    }
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > maxBytes) { overflow = true; kill(); } });
    child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    child.on('error', () => done({ code: -1, stdout: '', stderr: '', spawnFailed: true }));
    child.on('close', code => done({ code, stdout, stderr, timedOut, overflow }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// Read-only git with a fixed argv; never prompts, never takes optional locks.
export function runGit(cwd, args, { timeoutMs = 20_000 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], {
      timeout: timeoutMs, maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? '') }));
  });
}

// Map a failed gh call to a short code. gh prints "gh: <message> (HTTP <status>)" on stderr
// and the GitHub error document on stdout.
export function ghFailure(out) {
  if (out.spawnFailed) return fail('github_unavailable', 'cannot start gh');
  if (out.timedOut) return fail('github_unavailable', 'timeout');
  if (out.overflow) return fail('response_too_large');
  const stderr = String(out.stderr ?? '');
  const status = Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1] ?? 0);
  let message = '';
  try { message = JSON.parse(out.stdout)?.message ?? ''; } catch { /* not JSON */ }
  const detail = cleanText(message || stderr.split('\n')[0], 160) || undefined;
  if (status === 404) return fail('github_not_found', detail);
  if (status === 401 || /gh auth login/.test(stderr)) return fail('github_auth_required');
  if (status === 403 || status === 429) return fail(/rate limit/i.test(stderr + message) ? 'github_rate_limited' : 'github_forbidden', detail);
  if (status === 422) return fail('github_validation_failed', detail);
  return fail('github_unavailable', detail ?? `exit ${out.code}`);
}

// The `type` of a GraphQL error object mapped to the same short codes as REST failures; an
// unknown type is github_graphql_error.
const GRAPHQL_ERRORS = [
  [/^NOT_FOUND$/, 'github_not_found'],
  [/^INSUFFICIENT_SCOPES$/, 'github_scope_missing'],
  [/^FORBIDDEN$/, 'github_forbidden'],
  [/^RATE_LIMITED$/, 'github_rate_limited'],
  [/^(UNPROCESSABLE|ARGUMENT_ERROR)$/, 'github_validation_failed']
];

// One GraphQL request through `gh api graphql --input -` (body {query, variables}), under the
// operator's gh login like every other call here. Returns {ok, data} or {ok: false, error}
// with a short code; GitHub's messages are not returned, so nothing they echo can be logged.
// gh prints the response on stdout and exits non-zero when it carries `errors`.
export async function ghGraphql(query, variables = {}, { gh = runGh, timeoutMs = 15_000 } = {}) {
  const out = await gh(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables }), timeoutMs,
    maxBytes: 1024 * 1024 });
  if (out.spawnFailed || out.timedOut || out.overflow) return { ok: false, error: ghFailure(out).error };
  let doc = null;
  try { doc = JSON.parse(out.stdout); } catch { /* not JSON */ }
  const errors = Array.isArray(doc?.errors) ? doc.errors : [];
  if (errors.length) {
    const type = String(errors[0]?.type ?? '');
    return { ok: false, error: GRAPHQL_ERRORS.find(([rx]) => rx.test(type))?.[1] ?? 'github_graphql_error' };
  }
  if (out.code !== 0) return { ok: false, error: ghFailure(out).error };
  if (!doc || typeof doc.data !== 'object' || doc.data === null) return { ok: false, error: 'github_unavailable' };
  return { ok: true, data: doc.data };
}

// Registered repositories: the GitHub origin of every available repo project of PROJECTS.md.
async function catalogRepos(catalogOptions) {
  const catalog = await readProjectRegistry(catalogOptions);
  const repos = catalog.projects.filter(p => p.kind === 'repo' && p.available && p.path);
  const found = [];
  // Small batches: hundreds of projects must not spawn hundreds of git processes at once.
  for (let i = 0; i < repos.length; i += 8) {
    const batch = await Promise.all(repos.slice(i, i + 8).map(p => gitHubRemote({ repoPath: p.path })));
    found.push(...batch.filter(Boolean));
  }
  return found;
}

async function catalogProjectRepo(name, catalogOptions) {
  const info = await projectInfo(name, catalogOptions);
  if (!info.ok || info.project.kind !== 'repo' || !info.project.local_path) return null;
  return gitHubRemote({ repoPath: info.project.local_path });
}

const label = l => cleanText(typeof l === 'string' ? l : l?.name, LIMITS.label);
const author = u => cleanText(u?.login, 60);

function compactIssue(i) {
  return { number: i.number, title: cleanText(i.title, LIMITS.title), state: i.state,
    labels: (Array.isArray(i.labels) ? i.labels : []).slice(0, 20).map(label).filter(Boolean),
    author: author(i.user), comments: Number.isInteger(i.comments) ? i.comments : null,
    updated_at: i.updated_at ?? null, url: cleanText(i.html_url, 300) };
}
function compactPull(p) {
  return { number: p.number, title: cleanText(p.title, LIMITS.title), state: p.merged_at ? 'merged' : p.state,
    draft: Boolean(p.draft), author: author(p.user),
    head: cleanText(p.head?.ref, 200), head_sha: SHA_RE.test(p.head?.sha ?? '') ? p.head.sha : null,
    head_repo_full_name: parseRepo(p.head?.repo?.full_name)?.full ?? null,
    base_sha: SHA_RE.test(p.base?.sha ?? '') ? p.base.sha : null,
    base: cleanText(p.base?.ref, 200),
    labels: (Array.isArray(p.labels) ? p.labels : []).slice(0, 20).map(label).filter(Boolean),
    mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
    mergeable_state: cleanText(p.mergeable_state, 30) ?? null,
    updated_at: p.updated_at ?? null, url: cleanText(p.html_url, 300) };
}
function compactRun(r) {
  return { id: r.id, name: cleanText(r.name, 120), workflow: cleanText(r.path, 200), event: cleanText(r.event, 40),
    status: cleanText(r.status, 30), conclusion: cleanText(r.conclusion, 30), branch: cleanText(r.head_branch, 200),
    head_sha: SHA_RE.test(r.head_sha ?? '') ? r.head_sha : null, run_attempt: r.run_attempt ?? null,
    created_at: r.created_at ?? null, updated_at: r.updated_at ?? null, url: cleanText(r.html_url, 300) };
}

// `credentials`: the runtime's GitHub credentials provider (server/integrations/github-app.mjs),
// or null (gh's own login, as before). `scratchDir`: parent of the per-call gh configuration
// directories (the runtime's <stateDir>/gh-pr; /tmp may be read-only on the VPS).
export function createGitHub({ gh = runGh, git = runGit, catalogOptions = {}, registeredRepos, projectRepo,
  now = Date.now, timeoutMs = 30_000, writeTimeoutMs = 60_000, credentials = null, scratchDir = null, baseEnv = process.env } = {}) {
  const listRepos = registeredRepos ?? (() => catalogRepos(catalogOptions));
  const repoOfProject = projectRepo ?? (name => catalogProjectRepo(name, catalogOptions));
  let cache = null;

  // fn(env) with the `purpose` token of `repo` in env, or fn(undefined) when there is none to
  // use (gh's own environment, as before). A provider error fails closed.
  async function withAuth(purpose, repo, fn) {
    if (!credentials) return fn(undefined);
    const got = await credentials.token(purpose, repo.full);
    if (got.error) return fail('credential_unavailable', `${got.credential} ${got.error}`);
    if (!got.token) return fn(undefined);
    let dir;
    try { dir = await privateConfigDir(scratchDir); } catch { return fail('credential_unavailable', 'gh config dir unavailable'); }
    try {
      return await fn(ghChildEnv(baseEnv, got.token, dir));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const authed = (repo, auth, fn) => withAuth(auth === 'pull_request' ? 'pull_request' : 'read', repo, fn);
  const read = (repo, path, params) => authed(repo, undefined, env => getJson(path, params, env));
  const ghOpts = (opts, env) => (env ? { ...opts, env } : opts);

  // Reads always use GET explicitly, so a stray parameter can never turn into a write.
  async function getJson(path, params = {}, env = undefined) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    const endpoint = query.size ? `${path}?${query}` : path;
    const out = await gh(['api', '-X', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint], ghOpts({ timeoutMs }, env));
    if (out.code !== 0 || out.overflow) return ghFailure(out);
    try { return { ok: true, data: JSON.parse(out.stdout) }; } catch { return fail('github_unavailable', 'invalid JSON'); }
  }

  const api = {
    // Returns the canonical owner/repo when it is in scope, otherwise a refusal.
    async resolveRepo(value) {
      const repo = parseRepo(value);
      if (!repo) return fail('invalid_input', 'repo');
      if (repo.full.toLowerCase() === GOVERNANCE_REPO) return { ok: true, repo: parseRepo(GOVERNANCE_REPO) };
      if (!cache || now() - cache.at > CACHE_MS) {
        let list;
        try { list = await listRepos(); } catch { return fail('catalog_unavailable'); }
        cache = { at: now(), byKey: new Map(list.filter(r => parseRepo(r)).map(r => [r.toLowerCase(), r])) };
      }
      const canonical = cache.byKey.get(repo.full.toLowerCase());
      return canonical ? { ok: true, repo: parseRepo(canonical) } : fail('repo_not_registered');
    },

    async projectRepo(name) {
      try {
        const repo = await repoOfProject(name);
        return parseRepo(repo) ? repo : null;
      } catch { return null; }
    },

    // Fresh registered-repo observation. A closed issue is not proof of acceptance.
    async issue(repo, number) {
      if (!parseRepo(repo?.full) || !Number.isSafeInteger(number) || number < 1) return fail('invalid_input');
      const scoped = await this.resolveRepo(repo.full);
      if (!scoped.ok) return scoped;
      const res = await read(scoped.repo, 'repos/' + scoped.repo.full + '/issues/' + number);
      if (!res.ok) return res;
      const data = res.data;
      // GitHub uses null for an explicitly empty Issue body. Missing body is unknown.
      const body = data?.body === null ? '' : data?.body;
      if (data?.pull_request || !['open', 'closed'].includes(data?.state) || typeof body !== 'string'
        || Buffer.byteLength(body, 'utf8') > 20_000 || Number(data.number) !== number) {
        return fail('github_unavailable', 'issue body or state unavailable');
      }
      return { ok: true, issue: { ref: scoped.repo.full + '#' + number, state: data.state,
        body, updated_at: data.updated_at ?? null, closed_at: data.closed_at ?? null,
        authorized: true, observed_at: new Date(now()).toISOString() } };
    },

    async issues(repo, { state = 'open', labels, limit = LIMITS.list.default } = {}) {
      const res = await read(repo, `repos/${repo.full}/issues`, { state, labels: labels?.length ? labels.join(',') : undefined,
        sort: 'updated', direction: 'desc', per_page: limit, page: 1 });
      if (!res.ok) return res;
      if (!Array.isArray(res.data)) return fail('github_unavailable', 'unexpected response');
      // The Issues endpoint also returns pull requests; github_pull_requests covers those.
      const issues = res.data.filter(i => !i.pull_request).slice(0, limit).map(compactIssue);
      return { ok: true, repo: repo.full, state, count: issues.length, issues };
    },

    async pullRequests(repo, { state = 'open', limit = LIMITS.list.default } = {}) {
      const res = await read(repo, `repos/${repo.full}/pulls`, { state, sort: 'updated', direction: 'desc', per_page: limit, page: 1 });
      if (!res.ok) return res;
      if (!Array.isArray(res.data)) return fail('github_unavailable', 'unexpected response');
      const pulls = res.data.slice(0, limit);
      // The list endpoint never reports mergeability; look it up for the first few open PRs.
      const detailed = await Promise.all(pulls.map((p, index) => (p.state === 'open' && index < LIMITS.mergeableLookups
        ? read(repo, `repos/${repo.full}/pulls/${Number(p.number)}`).then(r => (r.ok ? { ...p, ...r.data } : p))
        : p)));
      const out = detailed.map(compactPull);
      return { ok: true, repo: repo.full, state, count: out.length, pull_requests: out,
        mergeable_checked: Math.min(LIMITS.mergeableLookups, pulls.filter(p => p.state === 'open').length) };
    },

    // Exhaustive bounded listing for portfolio only. Fail closed on page caps and read errors.
    async portfolioPages(repo, { kind, state = 'open', maxPages = 20 } = {}) {
      if (!['issues', 'pulls'].includes(kind) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
        return fail('invalid_input');
      }
      const entries = [];
      for (let page = 1; page <= maxPages; page++) {
        const res = await read(repo, `repos/${repo.full}/${kind}`, {
          state, sort: 'updated', direction: 'desc', per_page: 100, page
        });
        if (!res.ok) return { ...res, page };
        if (!Array.isArray(res.data)) return fail('github_unavailable', 'unexpected response');
        entries.push(...res.data);
        if (res.data.length < 100) {
          return { ok: true, items: kind === 'issues'
            ? entries.filter(i => !i.pull_request).map(compactIssue)
            : entries.map(compactPull), pages: page, complete: true };
        }
      }
      return { ok: false, error: 'page_limit_reached', pages: maxPages, complete: false };
    },

    async workflowRuns(repo, { branch, limit = LIMITS.list.default } = {}) {
      const res = await read(repo, `repos/${repo.full}/actions/runs`, { branch, per_page: limit, page: 1 });
      if (!res.ok) return res;
      const runs = Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs.slice(0, limit).map(compactRun) : [];
      return { ok: true, repo: repo.full, ...(branch ? { branch } : {}), count: runs.length,
        total: Number.isInteger(res.data?.total_count) ? res.data.total_count : null, runs };
    },

    async checks(repo, ref) {
      const path = `repos/${repo.full}/commits/${encodeURIComponent(ref)}`;
      const [runs, status] = await Promise.all([read(repo, `${path}/check-runs`, { per_page: 100, page: 1 }), read(repo, `${path}/status`, { per_page: 100 })]);
      if (!runs.ok) return runs;
      if (!status.ok) return status;
      const checkRuns = (Array.isArray(runs.data?.check_runs) ? runs.data.check_runs : []).slice(0, 100).map(c => ({
        name: cleanText(c.name, 120), status: cleanText(c.status, 30), conclusion: cleanText(c.conclusion, 30),
        app: cleanText(c.app?.slug, 60), completed_at: c.completed_at ?? null, url: cleanText(c.html_url, 300) }));
      const statuses = (Array.isArray(status.data?.statuses) ? status.data.statuses : []).slice(0, 100).map(s => ({
        context: cleanText(s.context, 120), state: cleanText(s.state, 30), description: cleanText(s.description, 200) }));
      const sha = SHA_RE.test(status.data?.sha ?? '') ? status.data.sha : null;
      const conclusions = checkRuns.map(c => c.conclusion);
      return { ok: true, repo: repo.full, ref, sha,
        summary: {
          check_runs: checkRuns.length,
          pending: checkRuns.filter(c => c.status !== 'completed').length,
          failing: conclusions.filter(c => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(c)).length,
          combined_status: cleanText(status.data?.state, 30)
        },
        check_runs: checkRuns, statuses };
    },

    async defaultBranch(repo, { auth } = {}) {
      const res = await authed(repo, auth, env => getJson(`repos/${repo.full}`, {}, env));
      if (!res.ok) return res;
      const branch = res.data?.default_branch;
      return validBranch(branch) ? { ok: true, branch } : fail('github_unavailable', 'default branch unknown');
    },

    // The open pull request whose head is owner:branch, or null.
    async openPullFor(repo, branch, { auth } = {}) {
      const res = await authed(repo, auth, env => getJson(`repos/${repo.full}/pulls`,
        { state: 'open', head: `${repo.owner}:${branch}`, per_page: 5, page: 1 }, env));
      if (!res.ok) return res;
      const match = Array.isArray(res.data) ? res.data.find(p => p.head?.ref === branch) : null;
      return { ok: true, pull: match ? compactPull(match) : null };
    },

    // Head of refs/heads/<branch> on the worktree's origin, read with ls-remote (no fetch).
    async remoteBranchHead(path, branch) {
      if (!validBranch(branch)) return fail('invalid_input', 'branch');
      let real;
      try {
        real = await realpath(path);
        if (!(await stat(real)).isDirectory()) return fail('worktree_missing');
      } catch { return fail('worktree_missing'); }
      const out = await git(real, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      if (out.code !== 0) return fail('git_remote_unavailable');
      const line = out.stdout.split('\n').map(l => l.split('\t')).find(([sha, ref]) => ref === `refs/heads/${branch}` && SHA_RE.test(sha));
      return line ? { ok: true, sha: line[0] } : fail('branch_not_pushed');
    },

    // Issues carrying one label, any state, oldest first, with their body (batch tasks, TODO-P5-51).
    // The Issues list endpoint reads the database directly, unlike search, so an Issue created a
    // second ago is already there.
    async labelledIssues(repo, labelName, { limit = 30 } = {}) {
      const res = await read(repo, `repos/${repo.full}/issues`, { state: 'all', labels: labelName, sort: 'created',
        direction: 'asc', per_page: Math.min(Math.max(limit, 1), 100), page: 1 });
      if (!res.ok) return res;
      if (!Array.isArray(res.data)) return fail('github_unavailable', 'unexpected response');
      const issues = res.data.filter(i => !i.pull_request && Number.isInteger(i.number) && i.number > 0).slice(0, limit)
        .map(i => ({ ...compactIssue(i), state_reason: cleanText(i.state_reason, 30) || null,
          body: cleanText(i.body ?? '', LIMITS.issueBody, { multiline: true }) }));
      return { ok: true, repo: repo.full, issues };
    },

    // Pull requests (any state, newest first) that close one of `numbers` with a GitHub closing
    // keyword, or whose head is one of `branches`. Map number -> [{number, state, url, head}].
    async linkedPulls(repo, { numbers = [], branches = new Map() } = {}) {
      const res = await read(repo, `repos/${repo.full}/pulls`, { state: 'all', sort: 'created', direction: 'desc', per_page: 100, page: 1 });
      if (!res.ok) return res;
      if (!Array.isArray(res.data)) return fail('github_unavailable', 'unexpected response');
      const linked = new Map();
      for (const p of res.data) {
        const body = String(p.body ?? '').slice(0, LIMITS.body);
        const head = typeof p.head?.ref === 'string' ? p.head.ref : null;
        for (const n of numbers) {
          const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:${repo.full.replace(/[.]/g, '\\.')})?#${n}(?![0-9])`, 'i');
          if (!closes.test(body) && !(head && branches.get(n)?.includes(head))) continue;
          const list = linked.get(n) ?? [];
          if (list.length < 3) list.push({ number: p.number, state: p.merged_at ? 'merged' : cleanText(p.state, 20), url: cleanText(p.html_url, 300) });
          linked.set(n, list);
        }
      }
      return { ok: true, pulls: linked };
    },

    // POST a label; one that already exists (422 already_exists) is fine. Batch labels only.
    async ensureLabel(repo, { name, color, description }) {
      const out = await withAuth('issues', repo, env => gh(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json',
        `repos/${repo.full}/labels`, '--input', '-'], ghOpts({ input: JSON.stringify({ name, color, description }), timeoutMs: writeTimeoutMs }, env)));
      if (out.ok === false) return out;
      if (out.code === 0 && !out.overflow) return { ok: true, created: true };
      const failure = ghFailure(out);
      if (failure.error === 'github_validation_failed' && /already_exists|already exists/i.test(`${out.stdout}${out.stderr}`)) {
        return { ok: true, created: false };
      }
      return failure;
    },

    // POST one Issue: title, body, labels. Never assignees, milestones or anything else.
    async createIssue(repo, { title, body, labels }) {
      const out = await withAuth('issues', repo, env => gh(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json',
        `repos/${repo.full}/issues`, '--input', '-'], ghOpts({ input: JSON.stringify({ title, body, labels }), timeoutMs: writeTimeoutMs }, env)));
      if (out.ok === false) return out;
      if (out.code === 0 && !out.overflow) {
        try { return { ok: true, issue: compactIssue(JSON.parse(out.stdout)) }; } catch { /* fall through */ }
        return fail('github_outcome_unknown');
      }
      const failure = ghFailure(out);
      const answered = /\(HTTP \d{3}\)/.test(String(out.stderr ?? ''));
      return answered ? failure : { ...failure, uncertain: true };
    },

    // POST only: title/head/base/body/draft. Never merge, never auto-merge.
    async createPull(repo, { title, head, base, body, draft }) {
      const payload = JSON.stringify({ title, head, base, body, draft: Boolean(draft), maintainer_can_modify: false });
      const out = await withAuth('pull_request', repo, env => gh(['api', '-X', 'POST', '-H', 'Accept: application/vnd.github+json',
        `repos/${repo.full}/pulls`, '--input', '-'], ghOpts({ input: payload, timeoutMs: writeTimeoutMs }, env)));
      if (out.ok === false) return out;
      if (out.code === 0 && !out.overflow) {
        try { return { ok: true, pull: compactPull(JSON.parse(out.stdout)) }; } catch { /* fall through */ }
        return fail('github_outcome_unknown');
      }
      const failure = ghFailure(out);
      // Without an HTTP status the request may or may not have reached GitHub.
      const answered = /\(HTTP \d{3}\)/.test(String(out.stderr ?? ''));
      return answered ? failure : { ...failure, uncertain: true };
    }
  };
  return api;
}
