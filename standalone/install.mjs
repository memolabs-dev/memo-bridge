// Copies a locally built standalone server into the OS user's profile.
// Does not install services, expose ports, add startup jobs or connect owner infrastructure.
import { copyFile, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultStandaloneConfig, standalonePaths } from './config.mjs';

export async function installStandalone({ builtFile, paths = standalonePaths(),
  fs = { copyFile, lstat, mkdir, open, rename, rm, stat } } = {}) {
  if (!builtFile || !paths?.config || !paths?.executable) throw new Error('invalid_install_arguments');
  const compiled = await fs.stat(builtFile).catch(() => null);
  if (!compiled?.isFile() || compiled.size < 1) throw new Error('build_required');
  await fs.mkdir(dirname(paths.executable), { recursive: true, mode: 0o700 });
  await fs.mkdir(dirname(paths.config), { recursive: true, mode: 0o700 });
  // Refuse replacing an installed executable symlink.
  const prev = await fs.lstat(paths.executable).catch(() => null);
  if (prev && (!prev.isFile() || prev.isSymbolicLink())) throw new Error('unsafe_install_target');
  const stage = paths.executable + '.new-' + process.pid;
  try {
    await fs.copyFile(builtFile, stage);
    await fs.rename(stage, paths.executable);
  } finally {
    await fs.rm(stage, { force: true }).catch(() => {});
  }
  let createdConfig = false;
  try {
    const file = await fs.open(paths.config, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(defaultStandaloneConfig(), null, 2) + '\n'); }
    finally { await file.close(); }
    createdConfig = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.lstat(paths.config).catch(() => null);
    if (!existing?.isFile() || existing.isSymbolicLink()) throw new Error('unsafe_config_target');
  }
  return { ok: true, config_created: createdConfig, configured_projects: 0,
    message: 'Set explicit project paths in the per-user config and restart the local MCP client.' };
}
