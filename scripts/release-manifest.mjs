#!/usr/bin/env node
// Release manifest for the VPS deployment (Phase 4, TODO-P4-15).
//
// lab-infra pins memo-bridge by full commit sha (group_vars/lab.yml memo_bridge_version) and
// copies a fixed set of files from that commit to the VPS (role memo-bridge, tasks/app.yml and
// runner.yml). This script describes exactly that set for one commit:
//
//   dist/release/SHA256SUMS                        "<sha256>  <path>" per deployed file (sha256sum -c format)
//   dist/release/memo-bridge-release.json          { name, version, commit, files, sums_sha256, ... }
//
// `sums_sha256` (the sha256 of SHA256SUMS) is the one checksum lab-infra records next to the
// sha: with the pinned commit fetched, `sha256sum -c SHA256SUMS` over the cache, or the same
// hash recomputed by Ansible, proves the files it is about to copy are the reviewed ones.
//
// Usage: node scripts/release-manifest.mjs [--out <dir>] [--allow-dirty]
// The working tree must be clean (the files hashed are the files of HEAD) unless --allow-dirty,
// which is for tests and marks the manifest "dirty": true. Git is run with fixed argv, no shell.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What lab-infra copies (memo_bridge_app_dirs, memo_bridge_app_files, memo_runner_app_dirs,
// and the two root scripts of runner.yml). Keep in step with lab-infra group_vars/lab.yml.
export const DEPLOYED = Object.freeze(['bridge', 'server', 'package.json', 'package-lock.json',
  'deploy/memo-runner-dispatch', 'deploy/record-result']);

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });

export function buildManifest(repo, { allowDirty = false } = {}) {
  const commit = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('no_commit');
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=normal', '--', ...DEPLOYED]).trim() !== '';
  if (dirty && !allowDirty) throw new Error('dirty_tree: commit or stash the deployed files first');
  // Tracked files of HEAD under the deployed paths, with their Git modes (100755 = executable).
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...DEPLOYED]).split('\0').filter(Boolean)
    .map(line => { const [meta, path] = line.split('\t'); const [mode] = meta.split(' '); return { path, mode }; })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!entries.length) throw new Error('nothing_to_release');
  const files = entries.map(({ path, mode }) => ({
    path, executable: mode === '100755',
    sha256: createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')
  }));
  const sums = files.map(f => `${f.sha256}  ${f.path}\n`).join('');
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return {
    sums,
    manifest: {
      name: pkg.name, version: pkg.version, commit, dirty, deployed_paths: [...DEPLOYED], file_count: files.length,
      sums_sha256: createHash('sha256').update(sums).digest('hex'),
      // The root scripts must be executable on the server (lab-infra installs them 0755).
      executables: files.filter(f => f.executable).map(f => f.path), files
    }
  };
}

function isMain() {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const out = outIndex >= 0 ? resolve(args[outIndex + 1] ?? '') : join(repo, 'dist', 'release');
  const { sums, manifest } = buildManifest(repo, { allowDirty: args.includes('--allow-dirty') });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'SHA256SUMS'), sums);
  writeFileSync(join(out, 'memo-bridge-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ version: manifest.version, commit: manifest.commit, dirty: manifest.dirty,
    files: manifest.file_count, sums_sha256: manifest.sums_sha256, out })}\n`);
}
