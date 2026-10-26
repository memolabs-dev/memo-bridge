// project_create: a new Memo Labs project from ChatGPT (owner console REQ-A2, design in
// .agent/project/owner-console/spec.md section 09). Runs on the Mac runtime, where the registry
// lives. In order, each step safe to repeat, so a second call with the same name converges on
// the same project and never makes a second repository:
//   1. validate the arguments; refuse private on the VPS and public on the Mac before anything;
//   2. the registry: a row with that name for another origin refuses (name_taken);
//   3. GitHub: memolabs-dev/<name> absent, generate it from memolabs-dev/project-template and
//      wait for its first commit; present, it must come from that template with the asked
//      visibility, else nothing is touched; then delete_branch_on_merge;
//   4. a clone on the Mac under $MEMOLABS_ROOT/<area>/<name>;
//   5. the registry row, under the registry lock (registry-writer.mjs);
//   6. on the Mac, a private repository is enrolled in the runtime's owner-policy files
//      (mac-enroll.mjs, #216), so the running runtime serves it without a reinstall;
//   7. readiness: true only when the runtime that serves the project already allows it, else the
//      owner steps that are missing.
// GitHub is reached with GitHub App installation tokens only (github-app.mjs purposes
// repo_create and repo_admin), through gh with a per-call environment. Nothing is ever deleted:
// there is no DELETE call here, and a failure leaves what was made for the next call.
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ghChildEnv, privateConfigDir } from '../coordinator/credentials.mjs';
import { ghFailure, runGh, validInputText } from '../integrations/github.mjs';
import { networkGit, originRepo, runGit } from '../runners/worktrees.mjs';
import { addRegistryRow, registryRows } from './registry-writer.mjs';

export const PROJECT_ORG = 'memolabs-dev';
export const PERSONAL_GITHUB_OWNER = 'guillaume-flambard';
export const TEMPLATES = Object.freeze({ default: Object.freeze({ repo: `${PROJECT_ORG}/project-template`, stack: 'Node.js' }) });
export const AREAS = Object.freeze(['os', 'lab', 'products', 'research', 'clients', 'studio']);
export const VISIBILITIES = Object.freeze(['private', 'public']);
export const PROJECT_HOSTS = Object.freeze(['mac', 'vps']);
// kebab-case, 2 to 50 characters: a valid GitHub name, registry name and folder name.
export const PROJECT_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const RESERVED_NAMES = Object.freeze(['project-template', 'github', 'memo-labs', 'memolabs-dev', 'workspace']);
const DESCRIPTION_MAX = 200;
// Where the owner keeps the App key on the Mac (lab-infra memo_runner_github_app_key_path). The
// enrollment step reinstalls the runtime with it, so project_create keeps working afterwards.
const APP_KEY_HOME_PATH = '.config/memolabs/secrets/github-app/memo-labs-automation.private-key.pem';
const GIT_CLONE_TIMEOUT_MS = 120_000;

const fail = (error, detail, extra = {}) => ({ ok: false, error, ...(detail ? { detail } : {}), ...extra });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// {ok:true, spec} or a refusal. host defaults by visibility; visibility defaults to private.
export function validateProjectArgs(args = {}) {
  const name = args.name;
  if (typeof name !== 'string' || name.length < 2 || name.length > 50 || !PROJECT_NAME_RE.test(name)) {
    return fail('invalid_name', 'kebab-case: lower-case letters and digits in words joined by single dashes, 2 to 50 characters, starting with a letter');
  }
  if (RESERVED_NAMES.includes(name)) return fail('invalid_name', 'reserved name');
  const visibility = args.visibility ?? 'private';
  if (!VISIBILITIES.includes(visibility)) return fail('invalid_input', 'visibility');
  const host = args.host ?? (visibility === 'private' ? 'mac' : 'vps');
  if (!PROJECT_HOSTS.includes(host)) return fail('invalid_input', 'host');
  const area = args.area ?? 'products';
  if (!AREAS.includes(area)) return fail('invalid_input', 'area');
  const template = args.template ?? 'default';
  if (!Object.hasOwn(TEMPLATES, template)) return fail('invalid_input', 'template');
  const description = args.description ?? '';
  if (!validInputText(description, DESCRIPTION_MAX)) return fail('invalid_input', 'description');
  if (visibility === 'private' && host === 'vps') {
    return fail('private_on_vps_refused', 'a private repository is never placed on the VPS', { next_step: 'call again with host "mac"' });
  }
  if (visibility === 'public' && host === 'mac') {
    return fail('public_on_mac_unsupported', 'the Mac runtime serves only enrolled private repositories',
      { next_step: 'call again with host "vps" for a public project, or visibility "private" for a Mac one' });
  }
  return { ok: true, spec: Object.freeze({ name, visibility, host, area, template, description, repo: `${PROJECT_ORG}/${name}` }) };
}

// The owner steps a project still needs before batch_create can use it (spec section 09, G-1 and G-2).
function ownerSteps(spec, { ownerSub, governanceRef }) {
  if (spec.host === 'mac') {
    return [{ step: 'enroll_on_mac',
      why: 'project_create could not enroll it on this Mac runtime (see enrollment_error); the installer enrolls every private project of the registry',
      run_on: 'the Mac, from a trusted memo-bridge checkout',
      command: `deploy/mac/install-runtime-agent.sh --owner-sub ${ownerSub ?? '<owner sub>'} --governance-ref ${governanceRef ?? '<governance commit>'} --from-registry --app-key "$HOME/${APP_KEY_HOME_PATH}" --install`,
      from_chatgpt: 'operator_run on host mac with that command, which asks for your approval' }];
  }
  return [
    { step: 'register_on_vps', repo: spec.repo,
      why: 'the VPS runner clones and serves only the projects lab-infra lists',
      change: `lab-infra ansible/group_vars/lab.yml: add ${spec.repo} to memo_runner_pilot_repos and to memo_bridge_remote_projects (kept identical, at most 50)` },
    { step: 'allow_in_ledger_prefilter', repo: spec.repo,
      why: 'the deployed coordinator pre-filters with the PUBLIC_ALLOWLIST literal (until T-A3a)',
      change: `memolabs-dev/.github scripts/issue_preflight.py: add "${spec.repo}" to PUBLIC_ALLOWLIST, then re-pin it in lab-infra after risk R-6 (coordinator.test.mjs on the candidate)` },
    { step: 'deploy', why: 'both changes reach the VPS with a deploy, on your go', command: 'make deploy-memo-bridge from a clean lab-infra checkout' }
  ];
}

// deps: root (MEMOLABS_ROOT), credentials (github-app.mjs provider), gh (runGh), scratchDir
// (private parent for gh config dirs), env (runtime env, for git), audit(op, outcome, code, ids),
// readiness(spec) -> {ready, missing?}, enroll(spec) -> {ok, enrolled} | refusal (Mac private projects), ownerSub, governanceRef, registry {add} overrides for tests,
// clone(spec, path) override for tests, waitRepoMs and pollMs for the template commit.
export function createProjectCreator({ root, credentials, gh = runGh, scratchDir = null, env = process.env, audit = async () => {},
  readiness = async () => ({ ready: false }), enroll = null, ownerSub = null, governanceRef = null, addRow = addRegistryRow, clone = null,
  waitRepoMs = 30_000, pollMs = 1_500, wait = sleep } = {}) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('project_create_requires_root');

  // One gh call with an App token of `purpose` for `repo` (null for the organization).
  async function ghApi(purpose, repo, method, path, body) {
    const got = await credentials.token(purpose, repo);
    if (got.error) return fail('github_app_unavailable', `${got.credential ?? 'app-key'} ${got.error}`);
    if (!got.token) return fail('github_app_unavailable', 'no installation token');
    let dir;
    try { dir = await privateConfigDir(scratchDir); } catch { return fail('credential_unavailable', 'gh config dir unavailable'); }
    try {
      const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path, ...(body ? ['--input', '-'] : [])];
      const out = await gh(args, { env: ghChildEnv(env, got.token, dir), timeoutMs: 30_000,
        ...(body ? { input: JSON.stringify(body) } : {}) });
      if (out.code !== 0 || out.overflow) return ghFailure(out);
      try { return { ok: true, data: out.stdout.trim() ? JSON.parse(out.stdout) : null }; } catch { return fail('github_unavailable', 'invalid JSON'); }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const readRepo = repo => ghApi('repo_create', null, 'GET', `repos/${repo}`);

  // Check an existing repository: ours (generated from the template, same visibility, live).
  function ownedExisting(data, spec, template) {
    if (data?.archived === true) return fail('repo_archived', `${spec.repo} is archived: nothing touched`);
    if (String(data?.template_repository?.full_name ?? '').toLowerCase() !== template.repo.toLowerCase()) {
      return fail('repo_exists', `${spec.repo} exists and was not generated from ${template.repo}: nothing touched`);
    }
    const visibility = data?.private === true ? 'private' : data?.private === false ? 'public' : null;
    if (visibility !== spec.visibility) return fail('visibility_mismatch', `${spec.repo} is ${visibility ?? 'of unknown visibility'}: nothing touched`);
    return null;
  }

  // Wait (bounded) for the generated repository's default branch to carry a commit. Read with the
  // organization token: a token narrowed to a repository made seconds ago is not needed for it.
  async function waitForCommit(spec) {
    const deadline = Date.now() + waitRepoMs;
    for (;;) {
      const got = await ghApi('repo_create', null, 'GET', `repos/${spec.repo}/commits?per_page=1`);
      if (got.ok && Array.isArray(got.data) && got.data.length > 0) return { ok: true };
      // Not visible yet (404) or still empty (409, mapped to github_unavailable): generation runs.
      if (!got.ok && !['github_not_found', 'github_unavailable'].includes(got.error)) return got;
      if (Date.now() >= deadline) return fail('repo_not_ready', `${spec.repo} has no commit yet: call project_create again in a minute`);
      await wait(pollMs);
    }
  }

  async function defaultClone(spec, path) {
    const net = await networkGit(env, { repo: spec.repo, credentials, scratchDir: scratchDir ? join(scratchDir, 'askpass') : null });
    if (net.error) return net.error;
    try {
      const r = await runGit(join(root, spec.area), [...net.config, 'clone', '--quiet', `https://github.com/${spec.repo}.git`, spec.name],
        { env: net.env, timeoutMs: GIT_CLONE_TIMEOUT_MS });
      return r.code === 0 ? { ok: true } : fail('clone_failed', r.timedOut ? 'timeout' : `git exit ${r.code}`);
    } finally {
      await net.release?.();
    }
  }

  // The checkout at `path`: absent, ours (origin is the repository), or something else.
  async function checkout(path, spec) {
    let info;
    try { info = await lstat(path); } catch (error) { return error?.code === 'ENOENT' ? 'absent' : 'other'; }
    if (!info.isDirectory()) return 'other';
    const origin = await originRepo(path, env).catch(() => null);
    return origin && origin.toLowerCase() === spec.repo.toLowerCase() ? 'ours' : 'other';
  }

  async function registryRow(name) {
    try {
      const parsed = registryRows(await readFile(join(root, 'PROJECTS.md'), 'utf8'));
      return parsed ? { ok: true, row: parsed.rows.find(r => r.name === name) ?? null } : fail('registry_unavailable');
    } catch { return fail('registry_unavailable'); }
  }

  async function create(args, ids = {}) {
    const checked = validateProjectArgs(args);
    if (!checked.ok) return checked;
    let spec = checked.spec;
    const template = TEMPLATES[spec.template];
    const steps = [];
    const journal = (op, outcome, code) => audit(op, outcome, code, { ...ids, issue: spec.repo });

    // 2. The registry: the name is free, or already this project.
    const known = await registryRow(spec.name);
    if (!known.ok) return known;
    let relPath = `${spec.area}/${spec.name}`;
    if (known.row) {
      const state = await checkout(join(root, known.row.path), spec);
      if (state !== 'ours') return fail('name_taken', `"${spec.name}" is already registered for another checkout (${known.row.path})`);
      relPath = known.row.path;
    }

    // 3. GitHub.
    const found = await readRepo(spec.repo);
    let existing = false;
    if (found.ok) {
      // Same name without a visibility: the project is the one that exists, whatever its visibility.
      const actual = found.data?.private === true ? 'private' : found.data?.private === false ? 'public' : null;
      if (args.visibility === undefined && actual && actual !== spec.visibility) {
        const again = validateProjectArgs({ ...args, visibility: actual });
        if (!again.ok) return again;
        spec = again.spec;
      }
      const refusal = ownedExisting(found.data, spec, template);
      if (refusal) return refusal;
      existing = true;
      steps.push('repo_found');
    } else if (found.error === 'github_not_found') {
      if (known.row) return fail('name_taken', `"${spec.name}" is registered but ${spec.repo} does not exist`);
      const tpl = await readRepo(template.repo);
      if (!tpl.ok || tpl.data?.is_template !== true) {
        return fail('template_unavailable', `${template.repo} is missing or not a template repository`,
          { next_step: 'the owner publishes it once: node scripts/project-template.mjs publish --execute (memo-bridge)' });
      }
      const made = await ghApi('repo_create', null, 'POST', `repos/${template.repo}/generate`, { owner: PROJECT_ORG, name: spec.name,
        description: spec.description || undefined, private: spec.visibility === 'private', include_all_branches: false });
      if (!made.ok) {
        // Created by a concurrent call between the read and the generate: converge on it.
        const again = await readRepo(spec.repo);
        if (!again.ok || ownedExisting(again.data, spec, template)) return made;
        existing = true;
        steps.push('repo_found');
      } else {
        await journal('project_repo_created', 'ok', 'created');
        steps.push('repo_created');
      }
      const ready = await waitForCommit(spec);
      if (!ready.ok) return { ...ready, repo: spec.repo, steps };
    } else {
      return found;
    }
    const patched = await ghApi('repo_admin', spec.repo, 'PATCH', `repos/${spec.repo}`, { delete_branch_on_merge: true });
    if (!patched.ok) return { ...patched, repo: spec.repo, steps };
    steps.push('settings_applied');

    // 4. The Mac clone.
    const localPath = join(root, relPath);
    const state = await checkout(localPath, spec);
    if (state === 'other') return fail('path_occupied', `${relPath} exists and is not a checkout of ${spec.repo}`, { repo: spec.repo, steps });
    if (state === 'absent') {
      try { await mkdir(join(root, spec.area), { recursive: true }); } catch { return fail('clone_failed', 'area folder', { repo: spec.repo, steps }); }
      const cloned = await (clone ?? defaultClone)(spec, localPath);
      if (!cloned.ok) return { ...cloned, repo: spec.repo, steps };
      steps.push('cloned');
    } else {
      steps.push('clone_found');
    }

    // 5. The registry row, under the lock.
    const row = await addRow(root, { name: spec.name, path: relPath, kind: 'repo', status: 'lab', nature: 'à qualifier',
      stack: template.stack, note: '-' });
    if (!row.ok) return { ...row, repo: spec.repo, steps };
    if (!row.added && row.row.path !== relPath) return fail('name_taken', `"${spec.name}" was registered meanwhile for ${row.row.path}`, { repo: spec.repo, steps });
    steps.push(row.added ? 'registry_row_added' : 'registry_row_found');

    // 6. Enrollment on the Mac runtime: only a private repository this call created or verified above.
    let enrollment = null;
    if (spec.host === 'mac' && spec.visibility === 'private' && typeof enroll === 'function') {
      try { enrollment = await enroll(spec); } catch { enrollment = fail('enroll_write_failed'); }
      if (enrollment?.ok === true) steps.push(enrollment.enrolled ? 'enrolled_on_mac' : 'enrollment_found');
    }

    // 7. Readiness.
    let ready;
    try { ready = await readiness(spec); } catch { ready = { ready: false }; }
    const result = { ok: true, project: spec.name, repo: spec.repo, url: `https://github.com/${spec.repo}`, visibility: spec.visibility,
      host: spec.host, local_path: localPath, registry_path: relPath, existing, steps,
      ready_for_batch_create: ready.ready === true };
    if (ready.ready === true) result.next = `batch_create with project "${spec.name}" and the first tasks; Mergify lands green pull requests`;
    else {
      if (enrollment && enrollment.ok !== true) result.enrollment_error = enrollment.error;
      result.owner_steps = ownerSteps(spec, { ownerSub, governanceRef });
      result.next = 'the owner steps below, then batch_create with project "' + spec.name + '"';
    }
    return result;
  }

  return Object.freeze({ create });
}
