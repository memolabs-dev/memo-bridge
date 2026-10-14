// Bundle the operator agent for the Mac (Phase 6, TODO-P6-13), the way scripts/install-local.mjs
// installs the stdio server: launchd runs a pinned copy, never a Git working tree, so a branch
// switch or an edit under ~/memolabs (a write root of the Mac policy) never changes the code that
// enforces that policy.
//
//   node scripts/build-operator.mjs [--out <dir>]          default: dist/operator
//   node scripts/build-operator.mjs --root [--out <dir>]   the Mac root helper (default dist/operator-root):
//        bridge/operator-root-mac-cli.mjs instead of the agent, same supervisor and package.json;
//        deploy/mac/install-operator-root.sh copies it root-owned (spec §13 Mac root follow-up)
//
// Output, three files and nothing else:
//   <out>/bridge/operator-agent-cli.mjs        the agent, its dependencies (ws, zod) inlined
//   <out>/bridge/operator-job-supervisor.mjs   the detached background-run supervisor; the job
//                                              store starts it from the agent's own directory
//   <out>/package.json                         name and version, read by bridge/protocol.mjs
// The banner gives the ESM bundle a `require` for the CommonJS parts of ws (esbuild otherwise
// answers "Dynamic require of events is not supported" at start).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootHelper = process.argv.includes('--root');
const entry = rootHelper ? 'operator-root-mac-cli.mjs' : 'operator-agent-cli.mjs';
const at = process.argv.indexOf('--out');
const out = at > 0 ? resolve(process.argv[at + 1] ?? '') : join(root, 'dist', rootHelper ? 'operator-root' : 'operator');
if (!isAbsolute(out)) throw new Error('--out must name a directory');
mkdirSync(join(out, 'bridge'), { recursive: true });

await build({
  entryPoints: [join(root, 'bridge', entry)],
  outfile: join(out, 'bridge', entry),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  banner: { js: "import { createRequire as memoCreateRequire } from 'node:module'; const require = memoCreateRequire(import.meta.url);" }
});
copyFileSync(join(root, 'bridge', 'operator-job-supervisor.mjs'), join(out, 'bridge', 'operator-job-supervisor.mjs'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: rootHelper ? 'memo-operator-root' : 'memo-operator-agent', version, private: true,
  type: 'module' }, null, 2)}\n`);
console.log(JSON.stringify({ out, version, entry }));
