import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

// Only trusted host-local configuration may enable organization-wide enrollment.
// Neither GitHub webhook bodies nor README/PR manifests are an authority source.
const ORG = 'memolabs-dev';
const APP_INSTALLATION_ID = 170927025;
const REPO_RE = /^memolabs-dev\/[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_BYTES = 16 * 1024;

function contains(root, target) {
  const rel = relative(root, target);
  return !rel.startsWith('..') && !isAbsolute(rel);
}
function uniqueRepositoryList(value, name) {
  if (!Array.isArray(value) || value.length > 200 ||
      value.some(x => typeof x !== 'string' || !REPO_RE.test(x)) ||
      new Set(value).size !== value.length) throw new Error('invalid_' + name);
  return [...value].sort();
}

export function parseTrustedEnrollmentPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema !== 'memo-bridge.owner-enrollment.v1' ||
      value.org !== ORG || value.installationId !== APP_INSTALLATION_ID ||
      typeof value.enabled !== 'boolean' ||
      !['selected', 'organization'].includes(value.mode) ||
      (value.mode === 'organization' && value.orgWideAutoEnrollment !== true) ||
      (value.mode === 'selected' && value.orgWideAutoEnrollment === true) ||
      (value.approvedFor !== undefined && value.approvedFor !== ORG))
    throw new Error('invalid_trusted_policy');
  const allow = uniqueRepositoryList(value.enrolledRepositories, 'enrollment');
  const exclude = uniqueRepositoryList(value.excludedRepositories, 'exclusions');
  if (allow.some(x => exclude.includes(x))) throw new Error('conflicting_repository_scope');
  if (value.enabled !== true && value.orgWideAutoEnrollment === true)
    throw new Error('disabled_policy_cannot_enable_org');
  const policy = Object.freeze({
    schema: value.schema, org: ORG, installationId: APP_INSTALLATION_ID,
    enabled: value.enabled, mode: value.mode,
    orgWideAutoEnrollment: value.mode === 'organization' && value.enabled,
    enrolledRepositories: Object.freeze(allow),
    excludedRepositories: Object.freeze(exclude)
  });
  const revision = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0,24);
  return { policy, revision };
}

export async function loadTrustedEnrollmentPolicy({ configPath, trustedRoot } = {}) {
  // Paths must be provided by the service deployment, never external request fields.
  if (typeof configPath !== 'string' || !isAbsolute(configPath) ||
      typeof trustedRoot !== 'string' || !isAbsolute(trustedRoot))
    throw new Error('policy_path_untrusted');
  const root = await realpath(trustedRoot);
  const parent = await realpath(resolve(configPath, '..'));
  if (!contains(root, parent) || parent === root && resolve(configPath) === root)
    throw new Error('policy_path_untrusted');
  const fd = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0)
      throw new Error('policy_file_not_private');
    const buf = await fd.readFile();
    if (buf.length > MAX_BYTES) throw new Error('policy_too_large');
    let value;
    try { value = JSON.parse(buf.toString('utf8')); }
    catch { throw new Error('invalid_trusted_policy'); }
    return parseTrustedEnrollmentPolicy(value);
  } finally { await fd.close(); }
}

export const ENROLLMENT_POLICY_LIMITS = Object.freeze({ maxBytes: MAX_BYTES,
  installationId: APP_INSTALLATION_ID, organization: ORG });
