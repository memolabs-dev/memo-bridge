// Metadata-only, offline-safe projection of the canonical Mac PROJECTS.md.
// This module NEVER resolves remote paths and is never a source of execution authority.
import { readFile, stat } from 'node:fs/promises';

export const CATALOG_SCHEMA = 'memolabs.project-catalog.v1';
const MAX_BYTES = 256 * 1024;
const MAX_PROJECTS = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)) &&
    keys.every(key => Object.hasOwn(value, key));
}
function validText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !TEXT_RE.test(value);
}
function validateProject(project) {
  if (!exactKeys(project, ['name', 'kind', 'status', 'nature', 'stack'])) throw new Error('invalid_catalog_snapshot');
  if (!PROJECT_RE.test(project.name) || !validText(project.kind, 40) ||
      !validText(project.status, 40) || !validText(project.nature, 80) ||
      !validText(project.stack, 200)) throw new Error('invalid_catalog_snapshot');
  return { name: project.name, kind: project.kind, status: project.status,
    nature: project.nature, stack: project.stack };
}
export function makeCatalogSnapshot(projects, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) throw new Error('invalid_catalog_snapshot');
  // Whitelist metadata: never export paths, local availability, git origins or Vault references.
  return { schema: CATALOG_SCHEMA, generated_at: generatedAt, source: 'PROJECTS.md',
    source_host: 'mac', projects: projects.map(p => validateProject({
      name: p.name, kind: p.kind, status: p.status, nature: p.nature, stack: p.stack
    })) };
}
export function parseCatalogSnapshot(value, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (!exactKeys(value, ['schema', 'generated_at', 'source', 'source_host', 'projects']) ||
      value.schema !== CATALOG_SCHEMA || value.source !== 'PROJECTS.md' || value.source_host !== 'mac' ||
      !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS ||
      !validText(value.generated_at, 32)) throw new Error('invalid_catalog_snapshot');
  const at = Date.parse(value.generated_at);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value.generated_at ||
      at > now + 5 * 60_000 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
    throw new Error('invalid_catalog_snapshot');
  const projects = value.projects.map(validateProject);
  if (new Set(projects.map(p => p.name)).size !== projects.length) throw new Error('duplicate_catalog_project');
  return { projects, generated_at: value.generated_at, stale: now - at > maxAgeMs };
}
export async function loadCatalogSnapshot(path, opts = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('invalid_catalog_snapshot_path');
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('invalid_catalog_snapshot');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('invalid_catalog_snapshot');
  return parseCatalogSnapshot(JSON.parse(content), opts);
}
// A snapshot only adds metadata to listProjects; it NEVER enters readProjectRegistry(),
// catalogResolver(), catalogRepos(), workspace_open(), task_claim(), or a job runner.
export function projectDiscoveryProjection(local, snapshot) {
  const names = new Set(local.projects.map(p => p.name));
  const discovered = snapshot.projects.filter(p => !names.has(p.name)).map(p => ({
    ...p, vault_note: null, path_relative: null, available: false,
    metadata_only: true, source_host: 'mac', catalog_stale: snapshot.stale
  }));
  return { ...local, source: 'PROJECTS.md + mac_snapshot',
    total: local.total + discovered.length, count: local.count + discovered.length,
    projects: [...local.projects, ...discovered],
    snapshot: { generated_at: snapshot.generated_at, stale: snapshot.stale, metadata_only: true } };
}
