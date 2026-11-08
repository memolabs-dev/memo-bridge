import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HELPER=resolve('deploy/mac/runtime-credentials.sh');
const INSTALLER=resolve('deploy/mac/install-runtime-agent.sh');
async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'mac-credentials-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const stage=join(home,'stage'),live=join(home,'live'),identity=join(home,'source-agent');
  const gh=join(home,'gh');
  await mkdir(live);
  await writeFile(identity,'AGENT_VALID_INITIAL');
  await writeFile(join(live,'agent-key'),'AGENT_OLD');
  await writeFile(join(live,'ledger-gh'),'LIVE_OLD_TOKEN');
  await writeFile(join(live,'push-gh'),'LIVE_OLD_TOKEN');
  await writeFile(join(live,'app-key'),'LIVE_OLD_APP_KEY');
  await writeFile(gh,'#!/bin/sh\nprintf "ghp_TEST_ONLY_12345678901234567890\\n"\n',{mode:0o755});
  const app=join(home,'appkey');
  await writeFile(app,'STAGED_NEW_APP_KEY');
  const call=cmd=>spawnSync('bash',['-c','set -euo pipefail; source "$1"; shift; '+cmd,
    'test',HELPER,stage,identity,gh,app,live],{encoding:'utf8',timeout:4000});
  const contents=async path=>({
    agent:await readFile(join(path,'agent-key'),'utf8'),
    ledger:await readFile(join(path,'ledger-gh'),'utf8'),
    push:await readFile(join(path,'push-gh'),'utf8'),
    app:await readFile(join(path,'app-key'),'utf8').catch(()=>null)
  });
  return {home,stage,live,identity,gh,app,call,contents};
}

test('a stage without App credentials NEVER changes a running agent’s credentials',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  const r=fx.call('stage_runtime_credentials "$1" "$2" "$3" ""');
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(await fx.contents(fx.live),before);
  assert.equal((await fx.contents(fx.stage)).app,null);
  assert.equal((await fx.contents(fx.stage)).agent,'AGENT_VALID_INITIAL');
  assert.equal((await fx.contents(fx.stage)).ledger,'ghp_TEST_ONLY_12345678901234567890\n');
  assert.equal((await stat(join(fx.stage,'ledger-gh'))).mode & 0o077,0);
  assert.equal((await stat(fx.stage)).mode & 0o077,0);
  assert.equal(r.stdout,'','must never print access tokens');
});

test('even stage with a new App key cannot overwrite the current live key',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  const r=fx.call('stage_runtime_credentials "$1" "$2" "$3" "$4"');
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(await fx.contents(fx.live),before);
  assert.equal((await fx.contents(fx.stage)).app,'STAGED_NEW_APP_KEY');
});

test('explicit install promotion with App preserves all staged contents',async t=>{
  const fx=await fixture(t);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" "$4"').status,0);
  const result=fx.call('promote_runtime_credentials "$1" "$5" 1');
  assert.equal(result.status,0,result.stderr);
  assert.equal((await fx.contents(fx.live)).app,'STAGED_NEW_APP_KEY');
  assert.equal((await fx.contents(fx.live)).agent,'AGENT_VALID_INITIAL');
  assert.equal((await fx.contents(fx.live)).ledger,'ghp_TEST_ONLY_12345678901234567890\n');
});

test('explicit install of runtime without App removes the old key ONLY after promotion',async t=>{
  const fx=await fixture(t);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  assert.equal((await fx.contents(fx.live)).app,'LIVE_OLD_APP_KEY');
  assert.equal(fx.call('promote_runtime_credentials "$1" "$5" 0').status,0);
  assert.equal((await fx.contents(fx.live)).app,null);
});

test('incomplete staged credentials refuse promotion without altering live keys',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  const result=fx.call('promote_runtime_credentials "$1" "$5" 1');
  assert.notEqual(result.status,0);
  assert.deepEqual(await fx.contents(fx.live),before);
});

test('stage destination symlink is rejected rather than followed into live credentials',async t=>{
  const fx=await fixture(t);
  await symlink(fx.live,fx.stage);
  const before=await fx.contents(fx.live);
  const result=fx.call('stage_runtime_credentials "$1" "$2" "$3" ""');
  assert.notEqual(result.status,0);
  assert.deepEqual(await fx.contents(fx.live),before);
});

test('installer stage exit precedes credential promotion and launchctl reload',async()=>{
  const source=await readFile(INSTALLER,'utf8');
  assert.ok(source.includes('source "$REPO/deploy/mac/runtime-credentials.sh"'));
  const stage=source.indexOf('stage_runtime_credentials "$STAGED_CREDS"');
  const stageExit=source.indexOf('if [ "$INSTALL" != 1 ]');
  const promote=source.indexOf('promote_runtime_credentials "$STAGED_CREDS"');
  const reload=source.lastIndexOf('reload_agent');
  assert.ok(stage>=0&&stage<stageExit&&stageExit<promote&&promote<reload,
    'a stage-only run must exit before changing live credentials or restarting launchd');
});
