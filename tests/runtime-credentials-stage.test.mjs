import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, chmod, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HELPER=resolve('deploy/mac/runtime-credentials.sh');
const isRoot=process.getuid?.()===0;
const BASH=process.platform==='darwin'?'/bin/bash':'bash';
// Fault injection: bash looks functions up before the absolute path, so a function named
// /bin/mv or /bin/rm replaces the real one inside the helper; `command` reaches the real one.
const failMvAfter=n=>'/bin/mv(){ MV_N=$((${MV_N:-0}+1)); [ "$MV_N" -le '+n+' ] || return 1; command /bin/mv "$@"; }; ';
const failMvNth=n=>'/bin/mv(){ MV_N=$((${MV_N:-0}+1)); [ "$MV_N" != '+n+' ] || return 1; command /bin/mv "$@"; }; ';
const failRmOf=suffix=>'/bin/rm(){ case "$*" in *"'+suffix+'") return 1;; esac; command /bin/rm "$@"; }; ';
const gone=path=>access(path).then(()=>false,()=>true);
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
  // /bin/bash: the installer runs under macOS bash 3.2, whatever bash comes first on PATH.
  const call=cmd=>spawnSync(BASH,['-c','set -euo pipefail; source "$1"; shift; '+cmd,
    'test',HELPER,stage,identity,gh,app,live],{encoding:'utf8',timeout:4000});
  // The installer's own shape: `helper || die`. Bash ignores set -e there, so only the
  // helper's explicit returns can report a failure: exit 11 for 1, 12 for 2.
  const guarded=cmd=>call(cmd+' || exit $((10 + $?))');
  const contents=async path=>({
    agent:await readFile(join(path,'agent-key'),'utf8'),
    ledger:await readFile(join(path,'ledger-gh'),'utf8'),
    push:await readFile(join(path,'push-gh'),'utf8'),
    app:await readFile(join(path,'app-key'),'utf8').catch(()=>null)
  });
  return {home,stage,live,identity,gh,app,call,guarded,contents};
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
  const result=fx.call('promote_runtime_credentials "$1" "$5" install');
  assert.equal(result.status,0,result.stderr);
  assert.equal((await fx.contents(fx.live)).app,'STAGED_NEW_APP_KEY');
  assert.equal((await fx.contents(fx.live)).agent,'AGENT_VALID_INITIAL');
  assert.equal((await fx.contents(fx.live)).ledger,'ghp_TEST_ONLY_12345678901234567890\n');
});

test('only an explicit removal deletes the live App key at install',async t=>{
  const fx=await fixture(t);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  assert.equal((await fx.contents(fx.live)).app,'LIVE_OLD_APP_KEY');
  assert.equal(fx.call('promote_runtime_credentials "$1" "$5" remove').status,0);
  assert.equal((await fx.contents(fx.live)).app,null);
});

test('an install that forgets --app-key is refused and keeps the live App key',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" keep').status,11);
  assert.deepEqual(await fx.contents(fx.live),before);
  assert.equal(await gone(fx.live+'.prev'),true);
  assert.equal(await gone(fx.live+'.next'),true);
  for(const mode of ['0','1','','yes'])
    assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" "'+mode+'"').status,11,'mode '+JSON.stringify(mode));
  assert.deepEqual(await fx.contents(fx.live),before);
});

test('keep mode installs the other credentials when there is no live App key',async t=>{
  const fx=await fixture(t);
  await rm(join(fx.live,'app-key'));
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" keep').status,0);
  assert.equal((await fx.contents(fx.live)).agent,'AGENT_VALID_INITIAL');
  assert.equal((await fx.contents(fx.live)).app,null);
});

test('a failing copy during staging is reported, not swallowed',{skip:isRoot},async t=>{
  const fx=await fixture(t);
  await chmod(fx.identity,0o000);
  const r=fx.guarded('stage_runtime_credentials "$1" "$2" "$3" ""');
  assert.equal(r.status,11,'stage must fail when the agent key cannot be copied');
});

test('a failing copy during promotion is reported and leaves the live credentials as they were',{skip:isRoot},async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  await chmod(join(fx.stage,'push-gh'),0o000);
  const r=fx.guarded('promote_runtime_credentials "$1" "$5" remove');
  assert.equal(r.status,11,'promotion must fail when a staged credential cannot be copied');
  assert.deepEqual(await fx.contents(fx.live),before,'no live file may change, the App key included');
  assert.equal(await gone(fx.live+'.prev'),true);
  assert.equal(await gone(fx.live+'.next'),true);
});

test('restore puts back the credentials a promotion replaced, App key included',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" remove').status,0);
  assert.equal((await fx.contents(fx.live)).app,null);
  assert.equal(fx.guarded('restore_runtime_credentials "$5"').status,0);
  assert.deepEqual(await fx.contents(fx.live),before);
  assert.equal(await gone(fx.live+'.prev'),true);
});

test('restore removes an App key the live directory did not have',async t=>{
  const fx=await fixture(t);
  await rm(join(fx.live,'app-key'));
  const before=await fx.contents(fx.live);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" "$4"').status,0);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" install').status,0);
  assert.equal(fx.guarded('restore_runtime_credentials "$5"').status,0);
  assert.deepEqual(await fx.contents(fx.live),before);
});

test('finish drops the previous copy, and a leftover copy blocks the next promotion',async t=>{
  const fx=await fixture(t);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" "$4"').status,0);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" install').status,0);
  assert.equal(await gone(fx.live+'.prev'),false);
  const promoted=await fx.contents(fx.live);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" install').status,11,
    'an earlier copy may be the only good one: never overwrite it');
  assert.deepEqual(await fx.contents(fx.live),promoted);
  assert.equal(fx.guarded('finish_runtime_credentials "$5"').status,0);
  assert.equal(await gone(fx.live+'.prev'),true);
  assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" install').status,0);
});

test('incomplete staged credentials refuse promotion without altering live keys',async t=>{
  const fx=await fixture(t);
  const before=await fx.contents(fx.live);
  const result=fx.guarded('promote_runtime_credentials "$1" "$5" install');
  assert.equal(result.status,11);
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

test('installer promotes credentials before policies and puts them back if the policies are refused',async()=>{
  const source=await readFile(INSTALLER,'utf8');
  const creds=source.indexOf('promote_runtime_credentials "$STAGED_CREDS" "$CREDS" "$APP_MODE"');
  const policies=source.indexOf('runtime-mac.mjs" promote');
  const restore=source.indexOf('restore_runtime_credentials "$CREDS"',policies);
  const finish=source.indexOf('finish_runtime_credentials "$CREDS"',policies);
  const plist=source.indexOf('/bin/mv -f "$TARGET.tmp" "$TARGET"');
  assert.ok(creds>=0&&creds<policies&&policies<restore&&restore<finish&&finish<plist,
    'credentials, then policies with a credential rollback, then the plist');
  assert.doesNotMatch(source,/HAS_APP/,'the App key mode must never be guessed from a missing flag');
});

test('installer refuses an --install that would silently drop the live App key',{skip:process.platform!=='darwin'},async t=>{
  const home=await mkdtemp(join(tmpdir(),'mac-installer-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const live=join(home,'.local','share','memo-bridge','runtime-config','credentials');
  await mkdir(live,{recursive:true});
  await writeFile(join(live,'app-key'),'LIVE_OLD_APP_KEY');
  const args=['--owner-sub','00000000-0000-4000-8000-000000000000','--governance-ref','a'.repeat(40),
    '--repo','memolabs-dev/example','--install'];
  const r=spawnSync('/bin/bash',[INSTALLER,...args],{encoding:'utf8',timeout:4000,env:{PATH:'/usr/bin:/bin',HOME:home}});
  assert.equal(r.status,1);
  assert.match(r.stderr,/a live app-key exists: pass --app-key <pem> to keep the App, or --remove-app-key to drop it/);
  assert.equal(await readFile(join(live,'app-key'),'utf8'),'LIVE_OLD_APP_KEY');
  const pem=join(home,'app.pem');
  // Not a key: only the marker the installer greps for, split so no scanner sees a header.
  await writeFile(pem,'TEST ONLY '+'PRIVATE '+'KEY-----\n');
  const both=spawnSync('/bin/bash',[INSTALLER,...args,'--app-key',pem,'--remove-app-key'],
    {encoding:'utf8',timeout:4000,env:{PATH:'/usr/bin:/bin',HOME:home}});
  assert.equal(both.status,1);
  assert.match(both.stderr,/--app-key and --remove-app-key exclude each other/);
});

test('a failure while replacing live files rolls every one of them back',async t=>{
  for(const n of [1,2,3,4]){
    const fx=await fixture(t);
    const before=await fx.contents(fx.live);
    assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" "$4"').status,0);
    const r=fx.guarded(failMvNth(n)+'promote_runtime_credentials "$1" "$5" install');
    assert.equal(r.status,11,'mv number '+n+' fails: '+r.stderr);
    assert.deepEqual(await fx.contents(fx.live),before,'mv number '+n);
    assert.equal(await gone(fx.live+'.prev'),true);
    assert.equal(await gone(fx.live+'.next'),true);
  }
});

test('a rollback that fails too is reported apart and keeps the previous credentials in .prev',async t=>{
  const fx=await fixture(t);
  assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
  // The three replacements succeed, removing app-key fails, then restore cannot move back.
  const r=fx.guarded(failMvAfter(3)+failRmOf('/live/app-key')+'promote_runtime_credentials "$1" "$5" remove');
  assert.equal(r.status,12,r.stderr);
  assert.equal(await readFile(join(fx.live+'.prev','agent-key'),'utf8'),'AGENT_OLD');
  assert.equal(await readFile(join(fx.live+'.prev','app-key'),'utf8'),'LIVE_OLD_APP_KEY');
  const source=await readFile(INSTALLER,'utf8');
  assert.match(source,/\[ "\$CRED_RC" != 2 \] \|\| die "credential promotion failed AND the previous credentials could not be put back/);
});

test('a stage without a gh login says so, without printing anything on stdout',async t=>{
  const fx=await fixture(t);
  await writeFile(fx.gh,'#!/bin/sh\nexit 1\n',{mode:0o755});
  const r=fx.guarded('stage_runtime_credentials "$1" "$2" "$3" ""');
  assert.equal(r.status,11);
  assert.match(r.stderr,/no usable github.com token \(gh auth login\)/);
  assert.equal(r.stdout,'');
});

test('an interrupted --install decides by what promote did, never by the signal alone',async t=>{
  const source=await readFile(INSTALLER,'utf8');
  const fn=source.match(/^interrupted_install\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  assert.ok(fn,'interrupted_install must exist');
  for(const sig of ['INT','TERM','HUP']) assert.match(source,new RegExp("trap 'interrupted_install \\d+' "+sig));
  for(const policiesLive of [false,true]){
    const fx=await fixture(t);
    const before=await fx.contents(fx.live);
    const staging=join(fx.home,'launchd');
    await mkdir(join(staging,'owner-policy'),{recursive:true});
    if(!policiesLive) await writeFile(join(staging,'owner-policy','stage.json'),'{}');
    assert.equal(fx.call('stage_runtime_credentials "$1" "$2" "$3" ""').status,0);
    assert.equal(fx.guarded('promote_runtime_credentials "$1" "$5" remove').status,0);
    const r=fx.call('STAGING='+JSON.stringify(staging)+'; CREDS="$5"; TARGET="$STAGING/agent.plist"; '+fn+' interrupted_install 143');
    assert.equal(r.status,143,r.stderr);
    assert.equal(await gone(fx.live+'.prev'),true);
    if(policiesLive){
      assert.equal((await fx.contents(fx.live)).agent,'AGENT_VALID_INITIAL','policies went live: keep the new credentials');
      assert.equal((await fx.contents(fx.live)).app,null);
    }else{
      assert.deepEqual(await fx.contents(fx.live),before,'policies still old: the old credentials come back');
    }
  }
});
