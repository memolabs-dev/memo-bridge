// Job recipes: the fixed set of commands a job may run, detected from the worktree content.
//
// A recipe is NOT an arbitrary command. The model picks a recipe name ('test', 'build',
// 'lint'); the argv is chosen here from the repository's own manifests and never from tool
// arguments. Be clear about what that means, though: a recipe runs the repository's OWN
// scripts (package.json scripts, Makefile targets, test suites…) on the owner's machine.
// Whoever can write files in the worktree (worktree_write_file) and submit a job can therefore
// run code there. That code is bounded by the job sandbox (sandbox.mjs: worktree writes only,
// loopback network only, no private data or credentials), and jobs_submit requires the
// runner:execute capability, an owned active workspace and a live claim on the worktree's
// Issue. With MEMO_BRIDGE_JOB_SANDBOX=off a job is owner-equivalent.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const RECIPE_NAMES = Object.freeze(['test', 'build', 'lint']);

// Manifests are small; anything larger is not read (and the recipe it would enable is skipped).
const MAX_MANIFEST_BYTES = 1024 * 1024;

// Read a manifest only when it is a regular file directly in the worktree: a symlink could
// point anywhere (a FIFO, /dev/zero, another repository) and is ignored.
function readManifest(root, name) {
  const path = join(root, name);
  let fd;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size > MAX_MANIFEST_BYTES) return null;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const present = (root, name) => readManifest(root, name) !== null;

function npmScripts(root) {
  const text = readManifest(root, 'package.json');
  if (text === null) return null;
  try {
    const scripts = JSON.parse(text)?.scripts;
    if (!scripts || typeof scripts !== 'object') return {};
    const has = key => typeof scripts[key] === 'string' && scripts[key].trim() !== '';
    return { test: has('test'), build: has('build'), lint: has('lint') };
  } catch {
    return null;
  }
}

// A Makefile rule "target:" (or "target::", or "target other:") at the start of a line;
// "target := value" and "target ::= value" are variables, not rules.
function makeTargets(root) {
  const text = readManifest(root, 'GNUmakefile') ?? readManifest(root, 'makefile') ?? readManifest(root, 'Makefile');
  if (text === null) return null;
  const has = target => new RegExp(`^${target}(?:[ \\t]+[^:=\\s][^:=\\n]*)?[ \\t]*:(?!=|:=)`, 'm').test(text);
  return { test: has('test'), build: has('build') };
}

// Return { recipeName: argv } for every recipe the worktree supports. When several
// ecosystems coexist, the first match in this order wins: npm, SwiftPM, Python, Cargo, Go, make.
export function detectRecipes(worktreePath) {
  const recipes = {};
  const npm = npmScripts(worktreePath);
  const swift = present(worktreePath, 'Package.swift');
  const python = present(worktreePath, 'pyproject.toml') || present(worktreePath, 'pytest.ini');
  const cargo = present(worktreePath, 'Cargo.toml');
  const go = present(worktreePath, 'go.mod');
  const make = makeTargets(worktreePath);

  const candidates = {
    test: [
      npm?.test && ['npm', 'test'],
      swift && ['swift', 'test'],
      python && ['python3', '-m', 'pytest', '-q'],
      cargo && ['cargo', 'test'],
      go && ['go', 'test', './...'],
      make?.test && ['make', 'test']
    ],
    build: [
      npm?.build && ['npm', 'run', 'build'],
      swift && ['swift', 'build'],
      cargo && ['cargo', 'build'],
      go && ['go', 'build', './...'],
      make?.build && ['make', 'build']
    ],
    lint: [
      npm?.lint && ['npm', 'run', 'lint']
    ]
  };
  for (const name of RECIPE_NAMES) {
    const argv = candidates[name].find(Boolean);
    if (argv) recipes[name] = Object.freeze(argv);
  }
  return recipes;
}

// Dependency install (VPS executor, phase 1 of a job): the fixed argv shapes, never a shell.
// The dispatcher pins the same list into the install unit (deploy/memo-runner-dispatch
// INSTALL_ARGV); job-unit.mjs runs a shape only when it is in that pinned list.
export const INSTALL_ARGV = Object.freeze({
  pnpm: Object.freeze(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']),
  npm: Object.freeze(['npm', 'ci', '--ignore-scripts'])
});
const LOCKFILES = Object.freeze(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json']);

// A regular file directly in the worktree (never a symlink), without reading it: lockfiles
// may be far larger than MAX_MANIFEST_BYTES.
function regularFile(root, name) {
  try { return lstatSync(join(root, name)).isFile(); } catch { return false; }
}
function entryExists(root, name) {
  try { lstatSync(join(root, name)); return true; } catch { return false; }
}

// What the install phase does in this worktree: { argv, manager } to run, or { skip: reason }.
// It installs only when the repository has a package.json, a lockfile and no node_modules
// entry at its root (a directory or a link: either way something is installed, and an
// install must not follow a link out of the worktree). pnpm when packageManager names pnpm
// or pnpm-lock.yaml exists; npm (`npm ci`, which needs package-lock.json or
// npm-shrinkwrap.json) otherwise.
export function detectInstall(worktreePath) {
  const text = readManifest(worktreePath, 'package.json');
  if (text === null) return { skip: 'no_package_json' };
  if (entryExists(worktreePath, 'node_modules')) return { skip: 'node_modules_present' };
  const lockfiles = LOCKFILES.filter(name => regularFile(worktreePath, name));
  if (!lockfiles.length) return { skip: 'no_lockfile' };
  let manager = null;
  try {
    const field = JSON.parse(text)?.packageManager;
    if (typeof field === 'string') manager = field.split('@')[0].trim();
  } catch { manager = null; }
  const pnpm = manager === 'pnpm' || lockfiles.includes('pnpm-lock.yaml');
  return pnpm ? { manager: 'pnpm', argv: INSTALL_ARGV.pnpm } : { manager: 'npm', argv: INSTALL_ARGV.npm };
}
