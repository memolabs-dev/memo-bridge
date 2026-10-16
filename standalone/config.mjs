// Independent, per-user configuration for the standalone, local-only MCP server.
// No connection to Memo Labs services or to the owner's PROJECTS.md or credentials.
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_PROJECTS = 64;
const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;

function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function absolute(path, os) { return (os === 'win32' ? win32 : { isAbsolute }).isAbsolute(path); }
function joinFor(os) { return os === 'win32' ? win32.join : join; }

export function standalonePaths({ os = process.platform, env = process.env, home = homedir() } = {}) {
  const combine = joinFor(os);
  if (os === 'win32') {
    const roaming = env.APPDATA || combine(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || combine(home, 'AppData', 'Local');
    if (!absolute(roaming, os) || !absolute(local, os)) throw new Error('invalid_windows_profile');
    return {
      config: combine(roaming, 'MemoBridge', 'config.json'),
      executable: combine(local, 'MemoBridge', 'standalone', 'index.mjs')
    };
  }
  const base = env.XDG_CONFIG_HOME || combine(home, '.config');
  const local = env.XDG_DATA_HOME || combine(home, '.local', 'share');
  if (!absolute(base, os) || !absolute(local, os)) throw new Error('invalid_profile');
  return {
    config: combine(base, 'memo-bridge', 'config.json'),
    executable: combine(local, 'memo-bridge', 'standalone', 'index.mjs')
  };
}

export function defaultStandaloneConfig() {
  return { schema_version: CONFIG_VERSION, projects: [] };
}

export function parseStandaloneConfig(raw, { os = process.platform } = {}) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('config_invalid_json'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config_invalid_schema');
  if (Object.keys(config).some(k => !['schema_version', 'projects'].includes(k)) ||
      config.schema_version !== CONFIG_VERSION || !Array.isArray(config.projects) ||
      config.projects.length > MAX_PROJECTS) throw new Error('config_invalid_schema');
  const names = new Set();
  const projects = config.projects.map(project => {
    if (!project || typeof project !== 'object' || Array.isArray(project) ||
        Object.keys(project).some(k => !['name', 'path'].includes(k)) ||
        typeof project.name !== 'string' || !PROJECT_NAME.test(project.name) ||
        names.has(project.name.toLowerCase()) ||
        typeof project.path !== 'string' || project.path.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(project.path) || !absolute(project.path, os)) {
      throw new Error('config_invalid_project');
    }
    // A path must be given explicitly by the local owner, never supplied by the MCP client.
    // No aliases, inherited owner registry, URLs, home-relative paths or default discovery.
    names.add(project.name.toLowerCase());
    return Object.freeze({ name: project.name, path: project.path });
  });
  return Object.freeze({ schema_version: CONFIG_VERSION, projects: Object.freeze(projects) });
}

export async function loadStandaloneConfig(configPath, { os = process.platform } = {}) {
  if (typeof configPath !== 'string' || !absolute(configPath, os)) throw new Error('config_path_invalid');
  let info;
  try { info = await lstat(configPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('config_not_initialized');
    throw new Error('config_unreadable');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error('config_unsafe_file');
  let raw;
  try { raw = await readFile(configPath, 'utf8'); } catch { throw new Error('config_unreadable'); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) throw new Error('config_unsafe_file');
  return parseStandaloneConfig(raw, { os });
}

export function createLocalProjectService(config, { filesystem = { lstat, stat, realpath } } = {}) {
  const registry = new Map(config.projects.map(p => [p.name, p]));
  async function inspect(project) {
    const spec = registry.get(project);
    if (!spec) return { ok: false, error: 'project_not_registered' };
    try {
      const root = await filesystem.lstat(spec.path);
      // Do not follow an owner's later replaced symlink.
      if (!root.isDirectory() || root.isSymbolicLink()) return { ok: true, project, available: false, git: null };
      const marker = await filesystem.lstat(joinFor(process.platform)(spec.path, '.git')).catch(() => null);
      return { ok: true, project, available: true,
        git: marker ? (marker.isDirectory() || marker.isFile()) : false };
    } catch {
      return { ok: true, project, available: false, git: null };
    }
  }
  return {
    list() { return { ok: true, projects: config.projects.map(({ name }) => ({ name })) }; },
    inspect
  };
}
