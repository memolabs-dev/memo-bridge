#!/usr/bin/env node
// Golden prompt set (owner console REQ-Z3, docs/golden-prompts/): what ChatGPT must call for each
// prompt the owner types, without naming Memo Bridge or any step.
//
//   node scripts/golden-prompts.mjs --check               every expected tool is one ChatGPT is served
//   node scripts/golden-prompts.mjs --score results.json  precision, recall and chains of one owner run
//
// results.json: {"run": {"date": "...", "deployed": "<sha>"}, "results": {"D01": {"calls": ["projects_list"]}, ...}}
// Each call is a tool name, or "tool:what it did" when an argument matters (e.g. "operator_run:gh pr merge 31").
// Nothing here talks to ChatGPT: the owner runs the prompts (docs/golden-prompts/PROTOCOL.md).
import { readFileSync } from 'node:fs';
import { REMOTE_OPERATOR_TOOLS, REMOTE_TOOLS } from '../server/registry.mjs';

export const CATEGORIES = Object.freeze(['direct', 'indirect', 'chain', 'negative']);
const PROMPTS = new URL('../docs/golden-prompts/prompts.json', import.meta.url);
const SERVED = new Set([...REMOTE_TOOLS, ...REMOTE_OPERATOR_TOOLS]);

export function loadPrompts(file = PROMPTS) {
  return JSON.parse(readFileSync(file, 'utf8')).prompts;
}

// Problems of the set itself: unknown tools, duplicate ids, bad categories.
export function checkPrompts(prompts) {
  const problems = [];
  const ids = new Set();
  for (const p of prompts) {
    if (ids.has(p.id)) problems.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!CATEGORIES.includes(p.category)) problems.push(`${p.id}: category ${p.category}`);
    if (typeof p.prompt !== 'string' || !p.prompt) problems.push(`${p.id}: no prompt`);
    const first = p.expect?.first;
    if (!Array.isArray(first) || first.length === 0) problems.push(`${p.id}: no expect.first`);
    for (const name of [...(first ?? []), ...(p.expect?.chain ?? []), ...(p.expect?.forbid ?? [])]) {
      const tool = name.split(':')[0];
      if (tool !== 'none' && !SERVED.has(tool)) problems.push(`${p.id}: ${tool} is not served to ChatGPT`);
    }
    if (p.category === 'negative' && !first?.includes('none')) problems.push(`${p.id}: a negative prompt must accept none`);
    if (p.category === 'chain' && !(p.expect?.chain?.length)) problems.push(`${p.id}: a chain prompt needs expect.chain`);
  }
  return problems;
}

const toolOf = call => String(call).split(':')[0];
const matches = (call, rule) => {
  const [tool, ...rest] = rule.split(':');
  return toolOf(call) === tool && (rest.length === 0 || String(call).includes(rest.join(':')));
};
function inOrder(calls, chain) {
  let i = 0;
  for (const call of calls) if (i < chain.length && toolOf(call) === chain[i]) i += 1;
  return i === chain.length;
}

// One prompt's verdict from the calls the owner recorded.
export function judge(prompt, calls) {
  const first = calls.length ? toolOf(calls[0]) : 'none';
  const expectsCall = prompt.expect.first.some(t => t !== 'none');
  const firstOk = prompt.expect.first.includes(first);
  const forbidden = calls.filter(call => (prompt.expect.forbid ?? []).some(rule => matches(call, rule)));
  const chainOk = prompt.expect.chain ? inOrder(calls, prompt.expect.chain) : null;
  const pass = firstOk && forbidden.length === 0 && chainOk !== false;
  return { id: prompt.id, category: prompt.category, first, firstOk, expectsCall, called: first !== 'none', forbidden, chainOk, pass };
}

// Precision: of the prompts where ChatGPT called a Memo Bridge tool first, the share where that
// tool was acceptable. Recall: of the prompts that expect a call (not a negative), the share where
// an acceptable tool came first. Negatives are counted on their own: called nothing it must not.
export function score(prompts, results) {
  const verdicts = prompts.filter(p => results[p.id]).map(p => judge(p, results[p.id].calls ?? []));
  const called = verdicts.filter(v => v.called);
  const precision = called.length ? called.filter(v => v.firstOk && v.forbidden.length === 0).length / called.length : null;
  const expected = verdicts.filter(v => v.category !== 'negative' && v.expectsCall);
  const recall = expected.length ? expected.filter(v => v.called && v.firstOk).length / expected.length : null;
  const byCategory = {};
  for (const c of CATEGORIES) {
    const vs = verdicts.filter(v => v.category === c);
    byCategory[c] = { run: vs.length, pass: vs.filter(v => v.pass).length };
  }
  const chains = verdicts.filter(v => v.chainOk !== null);
  return { run: verdicts.length, of: prompts.length, precision, recall, byCategory,
    chains: { run: chains.length, complete: chains.filter(v => v.chainOk).length },
    failures: verdicts.filter(v => !v.pass) };
}

const pct = x => (x === null ? 'n/a' : `${Math.round(x * 100)} %`);
if (import.meta.url === `file://${process.argv[1]}`) {
  const prompts = loadPrompts();
  if (process.argv.includes('--check')) {
    const problems = checkPrompts(prompts);
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    const counts = CATEGORIES.map(c => `${c} ${prompts.filter(p => p.category === c).length}`).join(', ');
    console.log(`ok: ${prompts.length} prompts (${counts}), every expected tool is served`);
  } else if (process.argv.includes('--score')) {
    const file = process.argv[process.argv.indexOf('--score') + 1];
    const { run = {}, results = {} } = JSON.parse(readFileSync(file, 'utf8'));
    const s = score(prompts, results);
    console.log(`Run ${run.date ?? '?'} (deployed ${run.deployed ?? '?'}): ${s.run} of ${s.of} prompts`);
    console.log(`precision ${pct(s.precision)}  recall ${pct(s.recall)}  chains ${s.chains.complete}/${s.chains.run}`);
    for (const [c, r] of Object.entries(s.byCategory)) console.log(`  ${c.padEnd(9)} ${r.pass}/${r.run}`);
    for (const f of s.failures) {
      console.log(`  FAIL ${f.id}: first ${f.first}${f.firstOk ? '' : ' (not expected)'}` +
        `${f.forbidden.length ? `, forbidden ${f.forbidden.join(', ')}` : ''}${f.chainOk === false ? ', chain incomplete' : ''}`);
    }
  } else {
    console.error('usage: golden-prompts.mjs --check | --score results.json');
    process.exit(2);
  }
}
