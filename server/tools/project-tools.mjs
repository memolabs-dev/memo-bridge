// project_create: the owner creates a Memo Labs project from ChatGPT (owner console REQ-A2,
// design in .agent/project/owner-console/spec.md section 09, logic in server/projects/create.mjs).
// Authorization first (github:write), then owner only: the owner's OIDC principal of this
// runtime's remote.json, hub:owner, or the local stdio owner. Served by the Mac runtime only,
// where the registry lives; the hub's router sends the call there. Journaled: project_create
// (ok created|existing, denied, error) and project_repo_created, with memolabs-dev/<name> in the
// journal's issue_ref column.
import { join } from 'node:path';
import { z } from 'zod/v4';
import { isRemotePrincipal } from '../coordinator/policy.mjs';
import { loadOwnerPrivatePolicy } from '../coordinator/owner-private-repos.mjs';
import { enrollOnMac } from '../projects/mac-enroll.mjs';
import { memolabsRoot } from '../memolabs-root.mjs';
import { AREAS, VISIBILITIES, createProjectCreator } from '../projects/create.mjs';

export const PROJECT_TOOLS = Object.freeze(['project_create']);

const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (error, detail, extra = {}) => ({ ok: false, error, ...(detail ? { detail } : {}), ...extra });
const DENIED = new Set(['forbidden', 'owner_only', 'project_create_mac_only', 'invalid_name', 'invalid_input', 'private_on_vps_refused',
  'public_on_mac_unsupported', 'name_taken', 'repo_exists', 'visibility_mismatch', 'repo_archived', 'path_occupied']);
const GOVERNANCE_REF_RE = /\/([0-9a-f]{40})\/?$/;

// The owner: local stdio (the OS user that launched the plugin), hub:owner, or oidc:<owner_sub>
// of the remote.json this runtime reads. Any other principal, even with github:write, is refused.
export function isProjectOwner(principal, remotePolicy) {
  const id = principal?.id ?? '';
  if (id.startsWith('local:') && principal.via !== 'hub') return true;
  if (id === 'hub:owner') return true;
  return isRemotePrincipal(principal) && remotePolicy?.configured === true && typeof remotePolicy.owner_sub === 'string' &&
    id === `oidc:${remotePolicy.owner_sub}`;
}

// options (tests): root, gh, clone, addRow, privatePolicyFile, env, waitRepoMs, pollMs, wait.
export function registerProjectTools(server, getRuntime, options = {}) {
  const env = options.env ?? process.env;

  // Ready for batch_create when the Mac runtime already serves the project: enrolled in the
  // owner's private policy file and listed in this runtime's remote.json (both reread when they
  // change, #216). A VPS project is never ready from here (lab-infra, spec G-2).
  const readinessFor = rt => async spec => {
    if (spec.host !== 'mac') return { ready: false };
    const policy = rt.remotePolicy?.() ?? null;
    if (!policy?.configured || !policy.projects.includes(spec.name)) return { ready: false };
    const enrolled = await loadOwnerPrivatePolicy({ file: options.privatePolicyFile ?? env.MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE,
      principal: { id: `oidc:${policy.owner_sub}` }, remotePolicy: policy, host: 'mac', home: env.HOME });
    return { ready: enrolled.ok === true && enrolled.repos.some(r => r.toLowerCase() === spec.repo.toLowerCase()) };
  };

  // #216: a private Mac project is added to this runtime's owner-policy files by project_create
  // itself; enrollOnMac refuses (enroll_unsupported) unless this runtime reads exactly those files.
  const enrollFor = rt => async spec => {
    const policy = rt.remotePolicy?.() ?? null;
    if (rt.host !== 'mac' || !policy?.configured || typeof policy.owner_sub !== 'string') return { ok: false, error: 'enroll_unsupported' };
    const out = await enrollOnMac({ home: env.HOME, ownerSub: policy.owner_sub, name: spec.name, repo: spec.repo,
      remoteConfigPath: env.MEMO_BRIDGE_REMOTE_CONFIG, privatePolicyPath: options.privatePolicyFile ?? env.MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE });
    // Journaled when something was written or refused; not when this runtime has nothing to enroll in.
    if (out.error !== 'enroll_unsupported' && (out.ok !== true || out.enrolled)) {
      await rt.audit('project_enrolled', out.ok === true ? 'ok' : 'denied', out.ok === true ? 'enrolled' : out.error, { issue: spec.repo });
    }
    return out;
  };

  server.registerTool('project_create', {
    description: 'Use this when the owner asks to create a new project («crée un projet relay-v2», «nouveau projet privé»): a memolabs-dev repository from the Memo Labs template (CI and Mergify), its clone and its registry row on the Mac. Safe to repeat with the same name: returns the same project, never a second repository. Says what is still missing before batch_create. Never deletes.',
    inputSchema: z.object({
      name: z.string().max(50).describe('kebab-case name, also the repository name, e.g. "relay-v2".'),
      visibility: z.enum(VISIBILITIES).optional().describe('"private" (default) or "public".'),
      host: z.enum(['mac', 'vps']).optional().describe('Where it runs: private projects on "mac", public ones on "vps" (the default for each).'),
      area: z.enum(AREAS).optional().describe('Registry folder under ~/memolabs, default "products".'),
      template: z.enum(['default']).optional().describe('Only "default" today.'),
      description: z.string().max(200).optional().describe('One line for GitHub, e.g. "Relay, second version".')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (args = {}) => {
    const op = 'project_create';
    const rt = getRuntime();
    const policy = rt.remotePolicy?.() ?? null;
    const repoId = typeof args?.name === 'string' && /^[a-z0-9-]{1,50}$/.test(args.name) ? { issue: `memolabs-dev/${args.name}` } : {};
    const done = async (outcome, data) => {
      const failed = data?.ok === false;
      await rt.audit(op, failed ? (DENIED.has(data.error) ? 'denied' : 'error') : 'ok',
        failed ? data.error : (data.existing ? 'existing' : 'created'), repoId);
      return result(data);
    };
    if (!rt.authorize(op)) return done('denied', fail('forbidden'));
    if (!isProjectOwner(rt.principal, policy)) return done('denied', fail('owner_only', 'only the owner creates projects'));
    if (rt.host !== 'mac') {
      return done('denied', fail('project_create_mac_only', 'projects are created by the Mac runtime, where the registry lives',
        { next_step: 'the Mac runtime must be connected: install it (deploy/mac/install-runtime-agent.sh) and turn on Mac routing' }));
    }
    try {
      const root = options.root ?? (env.MEMO_BRIDGE_PROJECTS_ROOT || memolabsRoot(env));
      const creator = createProjectCreator({ root, credentials: rt.githubCredentials, env,
        scratchDir: typeof rt.stateDir === 'string' ? join(rt.stateDir, 'gh-project') : null,
        audit: (o, outcome, code, ids) => rt.audit(o, outcome, code, ids), readiness: readinessFor(rt), enroll: enrollFor(rt),
        ownerSub: policy?.owner_sub ?? null, governanceRef: GOVERNANCE_REF_RE.exec(env.MEMO_BRIDGE_GOVERNANCE_ROOT ?? '')?.[1] ?? null,
        ...Object.fromEntries(['gh', 'clone', 'addRow', 'waitRepoMs', 'pollMs', 'wait'].filter(k => options[k] !== undefined).map(k => [k, options[k]])) });
      return done(null, await creator.create(args ?? {}));
    } catch {
      return done('error', fail('internal_error'));
    }
  });
}
