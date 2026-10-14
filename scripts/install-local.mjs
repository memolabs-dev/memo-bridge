// Install the bundled stdio server at a stable per-user location, so AI clients never run a
// Git working tree directly. Register it once in the shared MCP registry (Vault
// 4-Tools/mcp/mcp.json) as `node ~/.local/share/memo-bridge/stdio/index.mjs`.
//
// The bundle is two files: index.mjs (the MCP server) and job-runner.mjs (the detached process
// that runs one job; the server starts it from its own directory). Both are installed side by side.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'plugin', 'server', 'dist');
// Order matters: the runner goes first, so a server started mid-install always finds a runner.
const FILES = ['job-runner.mjs', 'index.mjs'];
const missing = FILES.filter(name => !existsSync(join(dist, name)));
if (missing.length) {
  console.error(`Missing bundle file(s) ${missing.join(', ')}: run \`pnpm run build\` first.`);
  process.exit(1);
}
const target = join(process.env.MEMO_BRIDGE_INSTALL_DIR || join(homedir(), '.local', 'share', 'memo-bridge', 'stdio'));
mkdirSync(target, { recursive: true, mode: 0o700 });
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const installed = [];
for (const name of FILES) {
  // Copy then rename: a client starting during the install sees the old or the new file, never half of one.
  const temporary = join(target, `.${name}.${process.pid}`);
  copyFileSync(join(dist, name), temporary);
  renameSync(temporary, join(target, name));
  installed.push(join(target, name));
}
writeFileSync(join(target, 'VERSION'), `${version}\n`);
console.log(JSON.stringify({ installed, version }));
