import { readFileSync } from 'node:fs';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { memolabsRoot } from './memolabs-root.mjs';
import { loadCatalogSnapshot, projectDiscoveryProjection } from './catalog-snapshot.mjs';
import { readExternalProjects } from './projects/external-projects.mjs';

const execFileAsync = promisify(execFile);
// The registry root: PROJECTS.md lives there and its Path column is relative to it. On the Mac
// it is MEMOLABS_ROOT (default ~/memolabs); a host with its own layout sets MEMO_BRIDGE_PROJECTS_ROOT.
const DEFAULT_PROJECTS_ROOT = process.env.MEMO_BRIDGE_PROJECTS_ROOT || memolabsRoot();
// A registry whose rows are symlinks may point into this second root (real paths are accepted
// under either root, never elsewhere).
const DEFAULT_LAYOUT_ROOT = process.env.MEMO_BRIDGE_LAYOUT_ROOT || memolabsRoot();
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_PROJECTS = 500;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
}
function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('.') || isAbsolute(value) || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}
function tableColumns(line) {
  if (!line.startsWith('|') || !line.endsWith('|')) return null;
  return line.slice(1, -1).split('|').map(x => x.trim());
}
function parseMainTable(document) {
  const lines = document.split(/\r?\n/);
  let inside = false;
  const records = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.startsWith('## Projets appartenant')) { inside = true; continue; }
    if (inside && line.startsWith('## ')) break;
    if (!inside) continue;
    const cells = tableColumns(line);
    if (!cells || cells.length < 7 || cells[0] === 'Name' || /^-+$/.test(cells[0])) continue;
    const [name, pathRelative, kind, status, nature, stack, vaultNote] = cells;
    if (!NAME_RE.test(name) || !safeRelativePath(pathRelative) || seen.has(name)) continue;
    seen.add(name);
    records.push({ name, pathRelative, kind, status, nature, stack, vaultNote: vaultNote === '-' ? null : vaultNote });
    if (records.length > MAX_PROJECTS) throw new Error('registry_too_large');
  }
  if (!inside) throw new Error('projects_section_missing');
  return records;
}

// Synchronous lookup of one registered project, for defaults computed at startup (the
// governance checkout of the Coordinator). Returns the absolute path, or null when the registry
// or the row is missing: callers report the absence, they never guess a folder.
export function resolveRegisteredPathSync(name, { env = process.env, projectsRoot } = {}) {
  const root = projectsRoot ?? (env.MEMO_BRIDGE_PROJECTS_ROOT || memolabsRoot(env));
  let text;
  try { text = readFileSync(join(root, 'PROJECTS.md'), 'utf8'); } catch { return null; }
  if (text.length > MAX_REGISTRY_BYTES) return null;
  let records;
  try { records = parseMainTable(text); } catch { return null; }
  const record = records.find(r => r.name === name);
  return record ? resolve(root, record.pathRelative) : null;
}

export async function readProjectRegistry(options = {}) {
  const projectsRoot = options.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
  const registryFile = options.registryFile ?? join(projectsRoot, 'PROJECTS.md');
  const info = await stat(registryFile);
  if (info.size > MAX_REGISTRY_BYTES) throw new Error('registry_too_large');
  const root = await realpath(projectsRoot);
  // Real paths are accepted under the projects root or the layout root, never elsewhere.
  const layoutRoot = await realpath(options.layoutRoot ?? DEFAULT_LAYOUT_ROOT).catch(() => null);
  const allowed = resolved => contained(root, resolved) || (layoutRoot !== null && contained(layoutRoot, resolved));
  const records = parseMainTable(await readFile(registryFile, 'utf8'));
  const projects = await Promise.all(records.map(async record => {
    const candidate = resolve(root, record.pathRelative);
    let safePath = null;
    let available = false;
    if (contained(root, candidate)) {
      try {
        const resolved = await realpath(candidate);
        if (allowed(resolved)) {
          const dir = await stat(resolved);
          if (dir.isDirectory()) {
            safePath = resolved;
            available = true;
          }
        }
      } catch { /* missing project is reported, never guessed */ }
    }
    return { ...record, available, path: safePath };
  }));
  // The owner's enrolled checkouts outside the root (#257, server/projects/external-projects.mjs):
  // Mac only, from his 0600 owner-policy file; a registry row of the same name wins.
  // options.externalProjects: false leaves them out (the catalog snapshot export), an object
  // replaces the environment defaults (tests).
  if (options.externalProjects !== false) {
    const names = new Set(projects.map(p => p.name));
    for (const row of await readExternalProjects(options.externalProjects ?? {})) {
      if (!names.has(row.name)) { projects.push(row); names.add(row.name); }
    }
  }
  return { source: 'PROJECTS.md', projects, count: projects.length };
}

function publicProject(p, includePath = false) {
  const { name, kind, status, nature, stack, vaultNote, available, pathRelative, path } = p;
  return { name, kind, status, nature, stack, vault_note: vaultNote, path_relative: pathRelative,
    available, ...(includePath && available ? { local_path: path } : {}) };
}

export async function listProjects(filters = {}, options = {}) {
  const catalog = await readProjectRegistry(options);
  const query = (filters.search ?? '').trim().toLowerCase();
  const status = filters.status ?? '';
  // The host-local registry remains authoritative for executable checkouts. Mac metadata is
  // merged into this READ-ONLY list only when an operator configured an absolute snapshot file.
  let projected = { source: catalog.source, total: catalog.count,
    projects: catalog.projects.map(p => publicProject(p)) };
  if (options.snapshotFile) {
    try {
      const snapshot = await loadCatalogSnapshot(options.snapshotFile, { now: options.now?.() ?? Date.now() });
      projected = projectDiscoveryProjection(projected, snapshot);
    } catch {
      // Fail closed: never promote malformed or missing snapshot rows. Local projects remain usable.
      projected.snapshot = { available: false, error: 'snapshot_unavailable' };
    }
  }
  const projects = projected.projects.filter(p =>
    (!query || p.name.toLowerCase().includes(query) || p.nature.toLowerCase().includes(query)) &&
    (!status || p.status === status)
  );
  return { ...projected, count: projects.length, projects };
}

export async function projectInfo(name, options = {}) {
  if (!NAME_RE.test(name)) return { ok: false, error: 'invalid_project_name' };
  const catalog = await readProjectRegistry(options);
  const project = catalog.projects.find(p => p.name === name);
  if (!project) return { ok: false, error: 'unknown_project' };
  return { ok: true, project: publicProject(project, true), source: catalog.source };
}

async function runGit(path, args) {
  const { stdout } = await execFileAsync('git', ['-C', path, ...args], {
    timeout: 6000, maxBuffer: 50000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  return stdout;
}

export async function projectGitStatus(name, options = {}) {
  if (!NAME_RE.test(name)) return { ok: false, error: 'invalid_project_name' };
  const catalog = await readProjectRegistry(options);
  const project = catalog.projects.find(p => p.name === name);
  if (!project) return { ok: false, error: 'unknown_project' };
  if (!project.available || project.kind !== 'repo') return { ok: false, error: 'project_unavailable' };
  try {
    const [branch, status, worktrees] = await Promise.all([
      runGit(project.path, ['branch', '--show-current']),
      runGit(project.path, ['status', '--porcelain=v1']),
      runGit(project.path, ['worktree', 'list', '--porcelain'])
    ]);
    return { ok: true, project: name, branch: branch.trim(),
      changes: status.trim() ? status.trimEnd().split('\n').length : 0,
      worktrees: worktrees.split('\n').filter(line => line.startsWith('worktree ')).length,
      checked_live: true };
  } catch {
    return { ok: false, error: 'git_status_unavailable', project: name };
  }
}

// Compare observed repositories with the canonical registry without silently promoting them.
// Inventory and navigational aliases are advisory; only PROJECTS.md grants registration.
export async function auditProjectRegistry(options = {}) {
  const catalog = await readProjectRegistry(options);
  const registered = new Set(catalog.projects.map(p => p.name));
  const observed = new Map();
  function record(name, source) {
    if (!NAME_RE.test(name) || registered.has(name)) return;
    if (!observed.has(name)) observed.set(name, new Set());
    observed.get(name).add(source);
  }

  const inventoryFile = options.inventoryFile ??
    join(memolabsRoot(), 'workspace', 'inventory', 'repos.json');
  try {
    const info = await stat(inventoryFile);
    if (info.size > MAX_REGISTRY_BYTES) throw new Error('inventory_too_large');
    const data = JSON.parse(await readFile(inventoryFile, 'utf8'));
    if (Array.isArray(data.repos)) {
      for (const item of data.repos.slice(0, MAX_PROJECTS)) record(item.name, 'inventory');
    }
  } catch { /* an optional inventory must never block the canonical registry */ }

  const aliasesRoot = options.aliasesRoot ?? memolabsRoot();
  const projectsRoot = await realpath(options.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
  async function walk(directory, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'workspace') continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        // A real repository moved into the layout is reported like an alias, and not descended.
        try {
          await stat(join(candidate, '.git'));
          record(entry.name, 'memolabs_layout');
          continue;
        } catch { /* not a repository: keep walking */ }
        await walk(candidate, depth + 1);
      } else if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(candidate);
          if (!contained(projectsRoot, target)) continue;
          const git = await stat(join(target, '.git'));
          if (git.isDirectory() || git.isFile()) record(basename(target), 'memolabs_alias');
        } catch { /* broken links are ignored */ }
      }
    }
  }
  await walk(aliasesRoot, 0);
  return {
    source: 'PROJECTS.md',
    registered_count: catalog.count,
    missing_registered: catalog.projects.filter(p => !p.available).map(p => p.name),
    unregistered: [...observed].map(([name, sources]) => ({ name, detected_via: [...sources].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}
