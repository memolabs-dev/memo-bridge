#!/usr/bin/env node
// The ratchet: an agent pull request may change the judge of pull requests only by making it
// stronger (spec "Check 2 : uni-ratchet", Vault 1-Projects/home-assurance/2026-10-19-livraison-
// design.md). No machine can tell a legitimate loosening from a cheat, so every loosening is
// refused here and only the owner, by hand, can make one.
//
// The judge is: uni/intents/** (the contract), .uni/** without uni's runtime state (registry,
// identities, policies), tests/invariants/**, tests/mutations/** (mutants and their harness),
// .mergify.yml, the workflows (the `uni` job of ci.yml, uni-ratchet.yml, and no other workflow
// may publish a check named like the judge's), and this file. ratchet() compares base and head
// as data and names each violation; it executes nothing of the PR, and the contract is read
// through `uni compile` (analysis only). Every rule is a line or file comparison, stricter than a
// YAML or TOML reading and with no dependency.
//
// CLI (run by .github/workflows/uni-ratchet.yml, pull_request_target, from the base checkout):
//   node scripts/uni-ratchet.mjs --repo <owner/repo> --pr <n> --base <sha> --head <sha>
// It reads everything through `gh api` with GET (git trees and blobs, PR files, issue events),
// and when there is a violation writes ONE PR comment marked <!-- memo-labs:uni-ratchet -->
// (updated in place on the next run, never deleted) and exits 1. Any read it cannot complete
// (an API error, a truncated tree, a file list shorter than the PR, a failed `uni compile`) is a
// violation too: it never exits 0 on doubt. DRY_RUN=1 prints the comment instead of writing it.
// Env: GH_TOKEN (for gh), UNI_BIN (default `uni`), DRY_RUN.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignMutants, invariantName, patchSignature } from '../tests/mutations/patches.mjs';

export const MARKER = '<!-- memo-labs:uni-ratchet -->';
export const OWNER = 'guillaume-flambard';
export const HOLD_LABEL = 'hold-merge';
export const COMMENT_AUTHOR = 'github-actions[bot]';

const CI = '.github/workflows/ci.yml';
const RATCHET_WORKFLOW = '.github/workflows/uni-ratchet.yml';
const RATCHET_SCRIPT = 'scripts/uni-ratchet.mjs';
const CONFIG = '.uni/config.toml';
const MERGIFY = '.mergify.yml';
const PACKAGE = 'package.json';
// What `pnpm install` and `pnpm test` read besides the test files: frozen whole (I1).
const PNPM_CONFIG = ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs'];
// package.json scripts that run, or decide, `pnpm test` and `pnpm install` (I1).
const FROZEN_SCRIPTS = ['test', 'pretest', 'posttest', 'prepare', 'preinstall', 'install', 'postinstall'];
const SECRET = /(^|\/)\.env($|\.)/;
// Check names Mergify requires: no job outside the frozen uni job may be named like one (C2).
const isJudgeCheckName = name => { const n = name.trim().toLowerCase(); return n === 'uni' || n === 'uni-ratchet' || n === 'test' || n.startsWith('test ('); };
// uni's runtime state, git-ignored (.gitignore of PR #214): not the judge. COMMITTED_RUNTIME is
// the part a PR must never commit, since uni would read it back as evidence or trust (M1).
const RUNTIME = [/^\.uni\/(evidence|decisions|artifacts)\//, /^\.uni\/events(\.[^/]*)?\.jsonl$/, /^\.uni\/\.registry\./, /^\.uni\/\.lock$/, /^\.uni\/brief\.md$/];
const COMMITTED_RUNTIME = RUNTIME.slice(0, 3);

export function isJudgePath(path) {
  if (path.startsWith('.uni/')) return !RUNTIME.some(re => re.test(path));
  return path.startsWith('uni/intents/') || path.startsWith('tests/invariants/') || path.startsWith('tests/mutations/') ||
    path.startsWith('.github/workflows/') || path === MERGIFY || path === RATCHET_SCRIPT || path === PACKAGE || PNPM_CONFIG.includes(path);
}

// ---- line helpers

const meaningful = text => text.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !l.trimStart().startsWith('#'));
const missing = (from, to) => { const have = new Set(to); return [...new Set(from)].filter(l => !have.has(l)); };
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s);

// TOML by lines: each line with the header of the table it sits in ('' before any header).
// A table belongs to `verifiers` or `identities` when its header starts with that key; a dotted
// or inline key elsewhere (`verifiers."x".run = ...`, `identities = {...}`) is attributed to its
// section too, with a header naming where it was found, so it can never slip past the rules.
function tomlSections(text) {
  const out = { verifiers: [], identities: [] };
  let header = ''; let kind = null;
  for (const line of meaningful(text)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      header = trimmed;
      const m = /^\[\[?\s*["']?(verifiers|identities)["']?\s*(?:[.\]]|$)/.exec(trimmed);
      kind = m ? m[1] : null;
      if (kind) out[kind].push({ table: header, line: trimmed });
      continue;
    }
    if (kind) { out[kind].push({ table: header, line }); continue; }
    const dotted = /^["']?(verifiers|identities)["']?\s*[.=]/.exec(trimmed);
    if (dotted) out[dotted[1]].push({ table: `${header || '<root>'} (inline)`, line });
  }
  return out;
}

// The `uni` job of ci.yml: from `  uni:` to the next job or top-level key, trailing blank and
// comment lines left out. Returns every such block (a duplicate key is itself a change).
function jobRanges(text, job) {
  const lines = text.split('\n');
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^  ${job.replace(/[-.]/g, '\\$&')}:\\s*(#.*)?$`).test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^ {0,2}[^\s#]/.test(lines[j])) j++;
    let end = j;
    while (end > i + 1 && (!lines[end - 1].trim() || lines[end - 1].trimStart().startsWith('#'))) end--;
    ranges.push([i, end]);
  }
  return { lines, ranges };
}
function jobBlocks(text, job) {
  const { lines, ranges } = jobRanges(text, job);
  return ranges.map(([i, end]) => lines.slice(i, end).map(l => l.trimEnd()).join('\n'));
}
// The text without the given job's blocks (ci.yml without its frozen uni job).
function withoutJob(text, job) {
  const { lines, ranges } = jobRanges(text, job);
  return lines.filter((_, k) => !ranges.some(([i, end]) => k >= i && k < end)).join('\n');
}
// A top-level key's block (`env:`, `defaults:`), or null.
function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => new RegExp(`^${key}:`).test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^[^\s#]/.test(lines[j])) j++;
  return lines.slice(i, j).map(l => l.trimEnd()).filter(l => l.trim() && !l.trimStart().startsWith('#')).join('\n');
}
const indent = line => line.length - line.trimStart().length;
const unquote = raw => {
  let v = raw.trim();
  if (/^["']/.test(v)) { const q = v[0]; const close = v.indexOf(q, 1); return close > 0 ? v.slice(1, close) : v; }
  return v.replace(/\s+#.*$/, '').trim();
};

// A double-quoted scalar with an escape, or any quoted scalar not closed on its line, cannot be
// read as a name by lines: "uni\u002Dratchet" is uni-ratchet to YAML (Ruling 19, NEW2).
const opaqueScalar = raw => {
  const v = raw.trim();
  if (v.startsWith('"')) { const close = v.indexOf('"', 1); return close < 0 || v.slice(1, close).includes('\\') || v.slice(1).includes('\\'); }
  if (v.startsWith("'")) return v.indexOf("'", 1) < 0;
  return false;
};

// Job ids and job-level names of a workflow, read by indentation under `jobs:`. Anything it cannot
// read that way (flow style, a block-scalar name) marks the file unreadable: refused if changed.
function workflowJobs(text) {
  const lines = meaningful(text);
  const ids = []; const names = []; let unreadable = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^["']?jobs["']?\s*:/.test(lines[i])) continue;
    if (!/^["']?jobs["']?\s*:\s*$/.test(lines[i])) { unreadable = true; continue; }
    let jobIndent = null; let keyIndent = null;
    for (let j = i + 1; j < lines.length && indent(lines[j]) > 0; j++) {
      const n = indent(lines[j]);
      if (jobIndent === null) jobIndent = n;
      if (n < jobIndent) { unreadable = true; break; }
      if (n === jobIndent) {
        if (opaqueScalar(lines[j].trim().replace(/\s*:\s*(#.*)?$/, ''))) { unreadable = true; continue; }
        const m = /^\s*(["']?)([^"'\s:]+)\1\s*:\s*(.*)$/.exec(lines[j]);
        if (!m || m[3]) { unreadable = true; continue; }
        ids.push(m[2]); keyIndent = null;
        continue;
      }
      if (keyIndent === null) keyIndent = n;
      const name = n === keyIndent && /^\s*["']?name["']?\s*:\s*(.*)$/.exec(lines[j]);
      if (name) {
        if (/^[|>]/.test(name[1].trim()) || opaqueScalar(name[1])) unreadable = true;
        names.push(unquote(name[1]));
      }
    }
  }
  return { ids, names, unreadable };
}
// Every `permissions:` block (the line and what is indented under it), in order.
function permissionBlocks(text) {
  const lines = meaningful(text);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*["']?permissions["']?\s*:/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && indent(lines[j]) > indent(lines[i])) j++;
    blocks.push(lines.slice(i, j).join('\n'));
  }
  return blocks;
}
// Head lines that are not in base, as a multiset difference.
function addedLines(before, after) {
  const count = new Map();
  for (const l of before) count.set(l, (count.get(l) ?? 0) + 1);
  return after.filter(l => { const c = count.get(l) ?? 0; if (c) { count.set(l, c - 1); return false; } return true; });
}
const GRANT = /\b(checks|statuses)["']?\s*:\s*["']?write\b|\bwrite-all\b/;
// YAML spellings of a key the line rules cannot read (Ruling 19, NEW3): an explicit `? key` /
// `: value` pair, or a double-quoted key with an escape ("permi\u0073sions").
const EXPLICIT_KEY = /^\s*(?:-\s+)?[?:](\s|$)/;
const escapedKey = line => { const m = /^\s*(?:-\s+)?"([^"]*)/.exec(line); return Boolean(m && m[1].includes('\\')); };

// C1: head must hold base's meaningful lines in the same order, and every other line must be one
// plain condition at the item indent of the `land_conditions:` list, inside it, that cannot
// re-parent the lines after it. Returns the reasons it is not so.
function mergifyLoosenings(baseText, headText) {
  const bm = meaningful(baseText); const hm = meaningful(headText);
  const matched = new Array(hm.length).fill(false);
  let j = 0;
  for (const line of bm) {
    while (j < hm.length && hm[j] !== line) j++;
    if (j === hm.length) return [`removed, changed or moved: ${clip(line.trim())}`];
    matched[j++] = true;
  }
  const start = hm.findIndex(l => /^  land_conditions:(\s|$)/.test(l));
  let end = hm.length;
  if (start >= 0) for (let k = start + 1; k < hm.length; k++) if (indent(hm[k]) <= 2) { end = k; break; }
  const reasons = [];
  for (let k = 0; k < hm.length; k++) {
    if (matched[k]) continue;
    const value = /^    - (\S.*)$/.exec(hm[k])?.[1];
    // Quotes and backslashes are refused too: a quoted scalar may span lines and swallow base
    // conditions into one string (Ruling 19, NEW1).
    const plain = value !== undefined && !/:(\s|$)/.test(value) && !/[&*{}[\]'"\\]|<</.test(value) &&
      !/^(or|and|not)\b/.test(value) && !/^[!|>?%@`]/.test(value) && !/^-\s/.test(value);
    const inList = start >= 0 && k > start && k < end;
    const nextOk = k + 1 >= hm.length || indent(hm[k + 1]) <= 4;
    if (!(plain && inList && nextOk)) reasons.push(`added outside a plain land_conditions item: ${clip(hm[k].trim())}`);
  }
  return reasons;
}

// ACCEPT WHEN clauses as written (the v0.1 IR keeps only require_verified: dropping
// `critical_failures == 0` compiles to the same IR, so the text is compared as well).
function acceptClauses(text) {
  const lines = text.split('\n').map(l => l.trim());
  const i = lines.findIndex(l => l.startsWith('ACCEPT WHEN'));
  if (i < 0) return [];
  let joined = lines[i].slice('ACCEPT WHEN'.length);
  for (let j = i + 1; j < lines.length && /^(required_claims|critical_failures|AND\b)/.test(lines[j]); j++) joined += ` ${lines[j]}`;
  return joined.split(/\bAND\b/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const verificationsOf = (ir, id) => (ir.verification ?? []).filter(v => v.claim_id === id)
  .map(v => JSON.stringify([v.verifier_ref ?? null, v.inline_shell ?? null, v.requirement ?? null])).sort();

// ---- the ratchet (pure)

// base, head: Map<path, content> of the judge files at each side (other paths are ignored);
// paths: every path of the PR (renames: both names); compileContract(text) -> uni IR (throws on a
// contract uni refuses); labelEvents: [{ event: 'labeled'|'unlabeled', label, actor }] in order.
export function ratchet({ base, head, paths = [], compileContract, labelEvents = [] }) {
  const violations = [];
  const seen = new Set();
  const add = (path, rule, detail) => {
    const key = `${path}\0${rule}\0${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(detail ? { path, rule, detail } : { path, rule });
  };
  const judge = files => new Map([...files].filter(([p]) => isJudgePath(p)));
  const b = judge(base); const h = judge(head);
  const all = [...new Set([...b.keys(), ...h.keys()])].sort();
  const differs = p => b.get(p) !== h.get(p);

  // contract_weakened
  for (const [path, text] of b) {
    if (!path.startsWith('uni/intents/') || !differs(path)) continue;
    if (!h.has(path)) { add(path, 'contract_weakened', 'contract removed'); continue; }
    if (!path.endsWith('.uni')) { add(path, 'contract_weakened', 'file beside the contracts changed'); continue; }
    let before;
    try { before = compileContract(text); } catch (error) { add(path, 'ratchet_error', `uni compile fails on base: ${clip(error.message)}`); continue; }
    let after;
    try { after = compileContract(h.get(path)); } catch (error) { add(path, 'contract_weakened', `uni compile refuses head: ${clip(error.message)}`); continue; }
    if (before.intent?.id !== after.intent?.id || before.intent?.domain !== after.intent?.domain) add(path, 'contract_weakened', 'INTENT or DOMAIN changed');
    const claims = new Map((after.claims ?? []).map(c => [c.id, c]));
    for (const claim of before.claims ?? []) {
      const now = claims.get(claim.id);
      if (!now) { add(path, 'contract_weakened', `claim ${claim.id} removed`); continue; }
      if (claim.required && !now.required) add(path, 'contract_weakened', `claim ${claim.id} lost REQUIRED`);
      if (claim.critical && !now.critical) add(path, 'contract_weakened', `claim ${claim.id} lost CRITICAL`);
      if (!sameList(verificationsOf(before, claim.id), verificationsOf(after, claim.id))) add(path, 'contract_weakened', `verifier of ${claim.id} changed`);
    }
    if (JSON.stringify(before.acceptance ?? null) !== JSON.stringify(after.acceptance ?? null)) add(path, 'contract_weakened', 'ACCEPT rule changed');
    for (const clause of missing(acceptClauses(text), acceptClauses(h.get(path)))) add(path, 'contract_weakened', `ACCEPT clause removed: ${clause}`);
  }

  // registry_weakened, identity_changed (.uni/config.toml)
  if (differs(CONFIG)) {
    const before = tomlSections(b.get(CONFIG) ?? '');
    const after = tomlSections(h.get(CONFIG) ?? '');
    const q = e => `${e.table} ${e.line}`;
    for (const line of missing(before.verifiers.map(q), after.verifiers.map(q))) add(CONFIG, 'registry_weakened', `removed or changed: ${clip(line)}`);
    // An entry of base is frozen: a line added to it (a `files` path, a key) changes it too.
    const baseTables = new Set(before.verifiers.map(e => e.table));
    for (const line of missing(after.verifiers.filter(e => baseTables.has(e.table) || e.table.endsWith('(inline)')).map(q), before.verifiers.map(q))) {
      add(CONFIG, 'registry_weakened', `added to an existing entry: ${clip(line)}`);
    }
    if (!sameList(before.identities.map(q), after.identities.map(q))) add(CONFIG, 'identity_changed', '[identities] changed');
  }

  for (const path of all) {
    if (!differs(path)) continue;
    // identity_changed, policy_changed, and the rest of .uni/ is judge code
    if (path.startsWith('.uni/identity/')) add(path, 'identity_changed');
    else if (path.startsWith('.uni/policies/')) add(path, 'policy_changed');
    else if (path.startsWith('.uni/') && path !== CONFIG) add(path, 'judge_changed', 'uni configuration beside config.toml changed');
    // invariant_test_changed
    if (path.startsWith('tests/invariants/') && b.has(path)) add(path, 'invariant_test_changed', h.has(path) ? 'modified' : 'deleted');
    // tests/mutations/: only top-level .patch files are mutants; everything else is the harness
    if (path.startsWith('tests/mutations/') && !/^tests\/mutations\/[^/]+\.patch$/.test(path)) add(path, 'judge_changed', 'mutation harness changed');
  }

  // invariant_without_mutant, mutants_decreased, mutant_changed
  const invariants = files => [...files.keys()].filter(p => /^tests\/invariants\/[^/]+\.test\.mjs$/.test(p)).map(p => invariantName(p.slice('tests/invariants/'.length)));
  const patches = files => [...files.keys()].filter(p => /^tests\/mutations\/[^/]+\.patch$/.test(p)).map(p => p.slice('tests/mutations/'.length));
  const baseMutants = assignMutants(invariants(b), patches(b)).map;
  const headMutants = assignMutants(invariants(h), patches(h)).map;
  for (const [inv, files] of headMutants) {
    const path = `tests/invariants/${inv}.test.mjs`;
    if (!b.has(path) && !files.length) add(path, 'invariant_without_mutant', `add tests/mutations/${inv}-<suffix>.patch`);
  }
  for (const [inv, files] of baseMutants) {
    const now = headMutants.get(inv)?.length ?? 0;
    if (now < files.length) add(`tests/invariants/${inv}.test.mjs`, 'mutants_decreased', `${files.length} mutant(s) on base, ${now} on head`);
  }
  for (const name of patches(b)) {
    const path = `tests/mutations/${name}`;
    if (!differs(path)) continue;
    if (!h.has(path)) { add(path, 'mutant_changed', 'mutant removed'); continue; }
    let before; let after;
    try { before = patchSignature(b.get(path)); } catch { before = null; }
    try { after = patchSignature(h.get(path)); } catch (error) { add(path, 'mutant_changed', `unreadable on head: ${clip(error.message)}`); continue; }
    if (!before || !sameList(before, after)) add(path, 'mutant_changed', 'its -/+ lines, target or "# test:" pattern changed');
  }

  // mergify_weakened (C1)
  if (differs(MERGIFY) && b.has(MERGIFY)) {
    for (const reason of mergifyLoosenings(b.get(MERGIFY), h.get(MERGIFY) ?? '')) add(MERGIFY, 'mergify_weakened', reason);
  }

  // judge_changed: the uni job of ci.yml (Ruling 18: only once base has it), and what reaches it
  if (b.has(CI) && jobBlocks(b.get(CI), 'uni').length) {
    const before = jobBlocks(b.get(CI), 'uni');
    const after = h.has(CI) ? jobBlocks(h.get(CI), 'uni') : [];
    if (!sameList(before, after)) add(CI, 'judge_changed', after.length ? 'the uni job changed' : 'the uni job removed');
    for (const key of ['env', 'defaults']) {
      if (topLevelBlock(b.get(CI), key) !== (h.has(CI) ? topLevelBlock(h.get(CI), key) : null)) add(CI, 'judge_changed', `top-level ${key}: (it reaches the uni job) changed`);
    }
  }
  for (const path of [RATCHET_WORKFLOW, RATCHET_SCRIPT]) if (b.has(path) && differs(path)) add(path, 'judge_changed', h.has(path) ? 'modified' : 'deleted');
  if (h.has(CI) && jobBlocks(h.get(CI), 'uni').length > 1) add(CI, 'judge_changed', 'two uni jobs');
  // Local actions the frozen uni job uses are part of it.
  if (b.has(CI)) {
    const dirs = jobBlocks(b.get(CI), 'uni').flatMap(block => [...block.matchAll(/uses:\s*["']?\.\/([^\s"'@]+)/g)].map(m => m[1].replace(/\/+$/, '')));
    for (const path of [...new Set(paths)].sort()) if (dirs.some(d => path === d || path.startsWith(`${d}/`))) add(path, 'judge_changed', 'local action of the uni job changed');
  }
  // C2: outside the frozen uni job (and uni-ratchet.yml, frozen whole), no workflow may grant
  // itself check or status writes, change a permissions block, or name a job like a required check.
  for (const path of all) {
    if (!path.startsWith('.github/workflows/') || path === RATCHET_WORKFLOW || !h.has(path) || !differs(path)) continue;
    const own = text => (text === undefined ? '' : path === CI ? withoutJob(text, 'uni') : text);
    const before = own(b.get(path)); const after = own(h.get(path));
    const added = addedLines(meaningful(before), meaningful(after));
    if (added.some(l => GRANT.test(l))) add(path, 'judge_changed', 'grants checks or statuses write, or write-all');
    if (added.some(l => EXPLICIT_KEY.test(l))) add(path, 'judge_changed', 'an explicit ? / : YAML key');
    if (added.some(escapedKey)) add(path, 'judge_changed', 'a double-quoted key with an escape');
    if (!sameList(permissionBlocks(before), permissionBlocks(after))) add(path, 'judge_changed', 'a permissions block changed');
    const jb = workflowJobs(before); const ja = workflowJobs(after);
    if (ja.unreadable) add(path, 'judge_changed', 'jobs not readable line by line (flow style, block-scalar name, or an escaped or multi-line quoted id or name)');
    for (const id of addedLines(jb.ids, ja.ids)) if (isJudgeCheckName(id)) add(path, 'judge_changed', `job id ${id} is a required check name`);
    for (const name of addedLines(jb.names, ja.names)) {
      if (name.includes('${{')) add(path, 'judge_changed', `job name built by an expression: ${clip(name)}`);
      else if (isJudgeCheckName(name)) add(path, 'judge_changed', `job name ${name} is a required check name`);
    }
  }

  // judge_changed: what `pnpm install` and `pnpm test` run (I1)
  if (b.has(PACKAGE) && differs(PACKAGE)) {
    const scriptLines = text => text.split('\n').map(l => l.trim()).filter(l => new RegExp(`^"(${FROZEN_SCRIPTS.join('|')})"\\s*:`).test(l));
    const parsed = text => { try { return JSON.parse(text); } catch { return null; } };
    const pb = parsed(b.get(PACKAGE)); const ph = h.has(PACKAGE) ? parsed(h.get(PACKAGE)) : null;
    if (!ph || typeof ph !== 'object') add(PACKAGE, 'judge_changed', h.has(PACKAGE) ? 'package.json is not valid JSON' : 'package.json deleted');
    else {
      if (!sameList(scriptLines(b.get(PACKAGE)), scriptLines(h.get(PACKAGE)))) add(PACKAGE, 'judge_changed', `a ${FROZEN_SCRIPTS.join('/')} script line changed`);
      for (const key of FROZEN_SCRIPTS) {
        if (JSON.stringify(pb?.scripts?.[key] ?? null) !== JSON.stringify(ph.scripts?.[key] ?? null)) add(PACKAGE, 'judge_changed', `scripts.${key} changed`);
      }
      for (const key of ['pnpm', 'packageManager']) if (JSON.stringify(pb?.[key] ?? null) !== JSON.stringify(ph[key] ?? null)) add(PACKAGE, 'judge_changed', `${key} changed`);
    }
  }
  for (const path of PNPM_CONFIG) if (differs(path)) add(path, 'judge_changed', 'pnpm configuration changed');

  // runtime_path (M1): committed uni runtime state would be read back as evidence or trust
  for (const path of [...new Set(paths)].sort()) if (COMMITTED_RUNTIME.some(re => re.test(path))) add(path, 'runtime_path');

  // secret_path
  for (const path of [...new Set(paths)].sort()) if (SECRET.test(path)) add(path, 'secret_path');

  // hold_removed: who set the hold that is now lifted
  let setters = new Set();
  for (const e of labelEvents) {
    if (e.label !== HOLD_LABEL) continue;
    if (e.event === 'labeled') setters.add(e.actor);
    else if (e.event === 'unlabeled') {
      if (setters.has(OWNER) && e.actor !== OWNER) add(`label:${HOLD_LABEL}`, 'hold_removed', `set by ${OWNER}, removed by ${e.actor}`);
      setters = new Set();
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---- reading GitHub (GET only) and uni

// `uni compile --json` on a temporary copy of the contract (uni reads files, not stdin).
export function compileWithUni(text, { bin = process.env.UNI_BIN || 'uni' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uni-ratchet-'));
  try {
    const file = join(dir, 'contract.uni');
    writeFileSync(file, text);
    const r = spawnSync(bin, ['compile', '--json', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new Error(`uni compile: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`uni compile exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
    try { return JSON.parse(r.stdout); } catch (error) { throw new Error(`uni compile printed no JSON: ${error.message}`); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `gh api` as (method, path, body) -> JSON. GET for every read; the only writes are the comment.
export function ghApi(method, path, body) {
  const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) args.push('--input', '-');
  const r = spawnSync('gh', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return Promise.reject(new Error(`gh api ${method} ${path}: ${r.error.message}`));
  if (r.status !== 0) return Promise.reject(new Error(`gh api ${method} ${path} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`));
  try { return Promise.resolve(r.stdout.trim() ? JSON.parse(r.stdout) : null); } catch (error) { return Promise.reject(new Error(`gh api ${method} ${path}: not JSON: ${error.message}`)); }
}

const PER_PAGE = 100;
const MAX_PAGES = 100;
// Every page of a list endpoint, or throws: a page that is not an array, or more pages than
// MAX_PAGES, is a read that cannot be completed.
async function allPages(api, path) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const chunk = await api('GET', `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(chunk)) throw new Error(`GET ${path} page ${page}: not a list`);
    items.push(...chunk);
    if (chunk.length < PER_PAGE) return items;
  }
  throw new Error(`GET ${path}: more than ${MAX_PAGES} pages, cannot read it all`);
}

function decodeBlob(blob, path) {
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`blob of ${path}: no base64 content`);
  const bytes = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    return `binary:${bytes.toString('hex')}`; // still a string, equal only to the same bytes
  }
}

async function judgeFiles(api, repo, sha, blobs) {
  const tree = await api('GET', `repos/${repo}/git/trees/${sha}?recursive=1`);
  if (!tree || !Array.isArray(tree.tree)) throw new Error(`tree of ${sha}: unreadable`);
  if (tree.truncated) throw new Error(`tree of ${sha} is truncated by the API: cannot read the whole judge`);
  const files = new Map();
  for (const entry of tree.tree) {
    if (!isJudgePath(entry.path)) continue;
    if (entry.type === 'commit') { files.set(entry.path, `submodule:${entry.sha}`); continue; }
    if (entry.type !== 'blob') continue;
    if (!blobs.has(entry.sha)) blobs.set(entry.sha, decodeBlob(await api('GET', `repos/${repo}/git/blobs/${entry.sha}`), entry.path));
    files.set(entry.path, entry.mode === '120000' ? `symlink:${blobs.get(entry.sha)}` : blobs.get(entry.sha));
  }
  return files;
}

export async function collect(api, { repo, pr, baseSha, headSha }) {
  const pull = await api('GET', `repos/${repo}/pulls/${pr}`);
  if (!pull || typeof pull.changed_files !== 'number') throw new Error(`pull request ${repo}#${pr}: unreadable`);
  // M4: judge exactly the commits named, or nothing (a later run judges the new head).
  if (pull.head?.sha !== headSha || pull.base?.sha !== baseSha) {
    throw new Error(`the PR moved: it is now base ${String(pull.base?.sha).slice(0, 12)}, head ${String(pull.head?.sha).slice(0, 12)}, not the shas given`);
  }
  const listed = await allPages(api, `repos/${repo}/pulls/${pr}/files`);
  if (listed.length < pull.changed_files) throw new Error(`the API lists ${listed.length} of the ${pull.changed_files} files of the PR: cannot read them all`);
  const paths = listed.flatMap(f => [f.filename, f.previous_filename]).filter(p => typeof p === 'string');
  const events = await allPages(api, `repos/${repo}/issues/${pr}/events`);
  const labelEvents = events.filter(e => e.event === 'labeled' || e.event === 'unlabeled')
    .map(e => ({ event: e.event, label: e.label?.name ?? null, actor: e.actor?.login ?? null }));
  const blobs = new Map();
  const base = await judgeFiles(api, repo, baseSha, blobs);
  const head = await judgeFiles(api, repo, headSha, blobs);
  return { base, head, paths, labelEvents };
}

const code = s => `\`${String(s).replace(/`/g, "'")}\``;
export function commentBody(violations, { baseSha, headSha }) {
  const shown = violations.slice(0, 100);
  return [MARKER,
    'This pull request changes the judge of pull requests in a way that is not only stronger, so it never lands on its own. An agent cannot loosen these rules; only the owner can, by hand.',
    '',
    // Details quote PR content (a config line, a compiler message): inside a code span it can
    // neither mention anyone nor format the comment.
    ...shown.map(v => `- ${code(v.rule)} ${code(v.path)}${v.detail ? `: ${code(String(v.detail).replace(/\s+/g, ' '))}` : ''}`),
    ...(violations.length > shown.length ? [`- and ${violations.length - shown.length} more`] : []),
    '',
    `Base ${baseSha.slice(0, 12)}, head ${headSha.slice(0, 12)}. Rules: \`scripts/uni-ratchet.mjs\` on the base branch.`].join('\n');
}

async function upsertComment(api, repo, pr, body) {
  const comments = await allPages(api, `repos/${repo}/issues/${pr}/comments`);
  const mine = comments.find(c => c?.user?.login === COMMENT_AUTHOR && typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (mine) await api('PATCH', `repos/${repo}/issues/comments/${mine.id}`, { body });
  else await api('POST', `repos/${repo}/issues/${pr}/comments`, { body });
}

const USAGE = 'usage: uni-ratchet.mjs --repo <owner/repo> --pr <n> --base <sha> --head <sha>';

export async function main(argv = process.argv.slice(2), { api = ghApi, compile = compileWithUni, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--repo': 'repo', '--pr': 'pr', '--base': 'baseSha', '--head': 'headSha' }[argv[i]];
    if (!key || argv[i + 1] === undefined) { err.write(`uni-ratchet: unknown argument ${argv[i]} (${USAGE})\n`); return 1; }
    opts[key] = argv[i + 1];
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? '') || !/^[1-9]\d*$/.test(opts.pr ?? '') ||
    !/^[0-9a-f]{40}$/.test(opts.baseSha ?? '') || !/^[0-9a-f]{40}$/.test(opts.headSha ?? '')) {
    err.write(`uni-ratchet: ${USAGE} (full 40-character shas)\n`);
    return 1;
  }

  let violations;
  try {
    const data = await collect(api, opts);
    violations = ratchet({ ...data, compileContract: compile }).violations;
  } catch (error) {
    violations = [{ path: '-', rule: 'ratchet_error', detail: `cannot judge this PR, refused: ${error.message}` }];
  }
  if (!violations.length) {
    out.write(`uni-ratchet: ${opts.repo}#${opts.pr} leaves the judge at least as strong as base ${opts.baseSha.slice(0, 12)}\n`);
    return 0;
  }
  for (const v of violations) err.write(`uni-ratchet: ${v.rule} ${v.path}${v.detail ? `: ${v.detail}` : ''}\n`);
  const body = commentBody(violations, opts);
  if (env.DRY_RUN === '1') {
    out.write(`would comment on ${opts.repo}#${opts.pr}:\n${body}\n`);
    return 1;
  }
  try { await upsertComment(api, opts.repo, opts.pr, body); } catch (error) { err.write(`uni-ratchet: could not write the PR comment: ${error.message}\n`); }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
