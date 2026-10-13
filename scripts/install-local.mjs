// Install the bundled stdio server at a stable per-user location, so AI clients never run a
// Git working tree directly. Register it once in the shared MCP registry (Vault
// 4-Tools/mcp/mcp.json) as `node ~/.local/share/memo-bridge/stdio/index.mjs`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'plugin', 'server', 'dist', 'index.mjs');
if (!existsSync(bundle)) {
  console.error('No bundle: run `npm run build` first.');
  process.exit(1);
}
const target = join(process.env.MEMO_BRIDGE_INSTALL_DIR || join(homedir(), '.local', 'share', 'memo-bridge', 'stdio'));
mkdirSync(target, { recursive: true, mode: 0o700 });
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Copy then rename: a client starting during the install sees the old or the new file, never half of one.
const temporary = join(target, `.index.mjs.${process.pid}`);
copyFileSync(bundle, temporary);
renameSync(temporary, join(target, 'index.mjs'));
writeFileSync(join(target, 'VERSION'), `${version}\n`);
console.log(JSON.stringify({ installed: join(target, 'index.mjs'), version }));
