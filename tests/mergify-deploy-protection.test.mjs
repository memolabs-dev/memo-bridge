import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mergify automatically queues passing PRs from the owner unless sensitive files
// match its exclusions. A deploy script is an executable that manipulates credentials
// and may restart the agent: it needs independent review, even when checks are green.
test('Mergify excludes deployment and credential-sensitive paths from automatic merging',()=>{
  const source=readFileSync(resolve('.mergify.yml'),'utf8');
  const line=source.split(/\r?\n/).find(x=>x.includes('-files ~='));
  assert.ok(line,'merge protection must contain a file exclusion');
  const expression=line.match(/-files ~= (.+)$/)?.[1];
  assert.ok(expression,'file exclusion regex is required');
  const deny=new RegExp(expression);
  for(const path of ['deploy/mac/install-runtime-agent.sh','deploy/mac/runtime-credentials.sh',
    'deploy/mac/guard-coordinator-state.py','deploy/vps/install-runner.sh',
    '.github/workflows/ci.yml','.mergify.yml','AGENTS.md']){
    assert.equal(deny.test(path),true,path+' should prevent auto merge');
  }
  for(const path of ['server/catalog.mjs','tests/catalog-snapshot.test.mjs']){
    assert.equal(deny.test(path),false,path+' should remain eligible for normal CI-gated merge');
  }
});
