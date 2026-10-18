// Intent-first tool metadata and the golden prompt set (owner console REQ-Z2, REQ-Z3; OpenAI Apps
// SDK "Optimize metadata"). What ChatGPT reads to choose a tool: every remote description starts
// with "Use this", every parameter is described, the listing does not grow past its measured
// budget, and every tool the golden prompts expect is one ChatGPT is served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { z } from 'zod/v4';
import { collectOperatorDefinitions, collectToolDefinitions, REMOTE_OPERATOR_TOOLS, REMOTE_TOOLS } from '../server/registry.mjs';
import { REMOTE_INSTRUCTIONS } from '../bridge/remote-surface.mjs';
import { checkPrompts, judge, loadPrompts, score } from '../scripts/golden-prompts.mjs';

const defs = async () => new Map([...await collectToolDefinitions(), ...await collectOperatorDefinitions()]);
const REMOTE = [...REMOTE_TOOLS, ...REMOTE_OPERATOR_TOOLS];

test('Z2: every tool ChatGPT lists says when to use it, in the owner\'s terms, without dashes', async () => {
  const all = await defs();
  for (const name of REMOTE) {
    const { description } = all.get(name);
    assert.match(description, /^Use this\b/, name);
    assert.equal(/[–—]/.test(description), false, `${name}: no dashes`);
    assert.ok(description.length <= 700, `${name}: ${description.length} characters`);
  }
  // The intents the owner named on 2026-10-18 land on a tool that says so.
  for (const [tool, words] of [['projects_list', 'quels sont mes projets'], ['task_claim', 'travaille sur l\'issue'],
    ['batch_create', 'corrige le bug de login'], ['operator_service', 'redémarre']]) {
    assert.ok(all.get(tool).description.includes(words), `${tool}: ${words}`);
  }
});

test('Z2: every parameter of every remote tool is described', async () => {
  const all = await defs();
  const described = v => Boolean(v.description || v.anyOf?.some(x => x.description));
  for (const name of REMOTE) {
    const schema = z.toJSONSchema(all.get(name).inputSchema);
    for (const [key, value] of Object.entries(schema.properties ?? {})) assert.ok(described(value), `${name}.${key}`);
  }
});

test('Z2: the remote tools/list stays within its measured budget, and the instructions stay short', () => {
  const budget = JSON.parse(readFileSync(new URL('../scripts/remote-toolsize-budget.json', import.meta.url), 'utf8'));
  const run = spawnSync(process.execPath, ['scripts/remote-toolsize.mjs', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout.trim().split('\n').at(-1));
  for (const stage of ['read', 'write', 'operator']) assert.ok(report[stage].bytes <= budget[stage], `${stage}: ${report[stage].bytes} > ${budget[stage]}`);
  assert.ok(Buffer.byteLength(REMOTE_INSTRUCTIONS) <= 4500, `instructions: ${Buffer.byteLength(REMOTE_INSTRUCTIONS)} bytes`);
});

test('Z3: the golden prompt set only expects tools ChatGPT is served', () => {
  const prompts = loadPrompts();
  assert.deepEqual(checkPrompts(prompts), []);
  assert.ok(prompts.length >= 30);
  for (const category of ['direct', 'indirect', 'chain', 'negative']) assert.ok(prompts.some(p => p.category === category), category);
  // End-to-end intents never need workspace_open.
  for (const p of prompts.filter(x => x.expect.chain)) assert.ok(p.expect.forbid?.includes('workspace_open'), p.id);
  const doc = readFileSync(new URL('../docs/golden-prompts/PROTOCOL.md', import.meta.url), 'utf8');
  assert.equal(/[–—]/.test(doc), false, 'no dashes in the protocol');
});

test('Z3: scoring counts precision, recall, forbidden calls and chains', () => {
  const prompts = loadPrompts();
  const byId = Object.fromEntries(prompts.map(p => [p.id, p]));
  assert.equal(judge(byId.D02, ['projects_list']).pass, true);
  assert.equal(judge(byId.D02, ['workspace_open', 'projects_list']).pass, false);
  assert.equal(judge(byId.N06, ['github_pull_requests']).pass, true);
  assert.deepEqual(judge(byId.N06, ['github_pull_requests', 'operator_run:gh pr merge 31']).forbidden, ['operator_run:gh pr merge 31']);
  const chain = ['task_claim', 'worktree_create', 'worktree_read_file', 'worktree_write_file', 'jobs_submit', 'job_results',
    'worktree_commit', 'worktree_push', 'github_create_pr', 'task_complete'];
  assert.equal(judge(byId.C01, chain).chainOk, true);
  assert.equal(judge(byId.C01, chain.filter(c => c !== 'jobs_submit')).chainOk, false);
  const perfect = Object.fromEntries(prompts.map(p => [p.id, { calls: p.expect.first[0] === 'none' ? [] : [p.expect.first[0], ...(p.expect.chain ?? [])] }]));
  const s = score(prompts, perfect);
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 1);
  assert.equal(s.failures.length, 0);
  const noisy = score(prompts, { ...perfect, N01: { calls: ['projects_list'] } });
  assert.ok(noisy.precision < 1);
  assert.equal(noisy.byCategory.negative.pass, noisy.byCategory.negative.run - 1);
});
