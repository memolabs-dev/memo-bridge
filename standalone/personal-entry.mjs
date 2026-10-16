// Explicitly enabled per-user loopback service, never the owner's Memo Labs hub.
// HTTPS edge, personal OIDC provider, client registration and external tunnel are NOT installed here.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadStandaloneConfig } from './config.mjs';
import { parsePersonalRemoteConfig } from './personal-auth.mjs';
import { createPersonalRemoteService } from './personal-http.mjs';

export async function loadPersonalRemoteFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('remote_config_requires_absolute_path');
  let st;
  try { st = await lstat(path); } catch { throw new Error('remote_config_missing'); }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16384) throw new Error('remote_config_unsafe');
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch { throw new Error('remote_config_unreadable'); }
  if (Buffer.byteLength(raw) > 16384) throw new Error('remote_config_unsafe');
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('remote_config_invalid_json'); }
  return parsePersonalRemoteConfig(json);
}

export async function startPersonalRemote({ configPath, remoteConfigPath } = {}) {
  if (!configPath || !remoteConfigPath) throw new Error('explicit_configs_required');
  const [config, settings] = await Promise.all([
    loadStandaloneConfig(configPath), loadPersonalRemoteFile(remoteConfigPath)
  ]);
  const service = createPersonalRemoteService({ localConfig: config, settings });
  const address = await service.start();
  return { service, address };
}
