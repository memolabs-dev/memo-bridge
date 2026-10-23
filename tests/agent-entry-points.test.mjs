// The agent entry points (owner, 2026-10-23: "que n'importe quel agent sache de suite comment
// utiliser memo bridge"): llms.txt in the llmstxt.org shape, the portable skill and the server
// instructions all teach the same default, the project's own checkout on a branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

test('llms.txt: an H1, a blockquote summary, H2 link lists whose every link resolves', () => {
  const text = read('llms.txt');
  const lines = text.split('\n');
  assert.equal(lines[0], '# Memo Bridge');
  assert.ok(lines.find(l => l.trim() !== '' && !l.startsWith('# ')).startsWith('> '), 'blockquote right after the title');
  assert.ok(text.includes('## Start here') && text.includes('## Optional'));
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 8);
  for (const link of links) assert.ok(existsSync(join(ROOT, link)), `link resolves: ${link}`);
});

test('entry points teach the checkout first and the path_relative lookup', () => {
  for (const rel of ['llms.txt', 'skills/memo-bridge/SKILL.md', 'plugin/skills/memo-bridge-operations/SKILL.md', 'server/index.mjs']) {
    const text = read(rel);
    assert.ok(text.includes('path_relative'), `${rel}: path_relative`);
    assert.match(text, /branch/, `${rel}: branch`);
    assert.equal(/[–—]/.test(rel === 'server/index.mjs' ? '' : text), false, `${rel}: no dashes`);
  }
  const skill = read('plugin/skills/memo-bridge-operations/SKILL.md');
  assert.ok(skill.indexOf('## Default way of working') < skill.indexOf('## Task flow, on request'), 'default before the task flow');
  assert.match(read('README.md'), /start with \[`llms\.txt`\]/);
});
