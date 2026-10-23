import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapStdioMacOwnerPolicy } from '../server/stdio-owner-policy.mjs';

const SUB = '11111111-2222-3333-4444-555555555555';
const SHA = 'a'.repeat(40);
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-stdio-owner-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home,'.local','share','memo-bridge','owner-policy');
  const governance = join(home,'.local','share','memo-bridge','governance',SHA);
  const scripts = join(governance,'scripts');
  const launchAgents = join(home,'Library','LaunchAgents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir,0o700);
  mkdirSync(scripts,{recursive:true,mode:0o700});
  mkdirSync(launchAgents,{recursive:true,mode:0o700});
  function file(path,content,mode=0o600) {
    writeFileSync(path,content,{mode});chmodSync(path,mode);return path;
  }
  const privateFile = file(join(dir,'private-repos.json'),JSON.stringify({
    schema:'memolabs.owner-private-repos.v1',owner_sub:SUB,repos:['memolabs-dev/memo-orbit']
  }));
  const remoteFile = file(join(dir,'remote.json'),JSON.stringify({oidc:{owner_sub:SUB}}));
  const externalFile = file(join(dir,'external-projects.json'),'{}');
  const leaseFile = file(join(dir,'lease-key.json'),'{}');
  const plist = file(join(launchAgents,'dev.memolabs.memo-bridge-agent.plist'),'<plist/>',0o644);
  file(join(scripts,'issue_lease.py'),'pass',0o644);
  file(join(scripts,'private_owner_allowlist.py'),'from pwd import getpwuid',0o644);
  const saved = {
    MEMO_BRIDGE_AGENT_MODE:'runtime',MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'enabled',
    MEMO_BRIDGE_OWNER_SUB:SUB,
    MEMO_BRIDGE_PRIVATE_UNUSED:'not-copied',
    MEMO_BRIDGE_REMOTE_CONFIG:remoteFile,
    MEMO_BRIDGE_OWNER_PRIVATE_REPOS_FILE:privateFile,
    MEMO_BRIDGE_OWNER_EXTERNAL_PROJECTS_FILE:externalFile,
    MEMO_BRIDGE_OWNER_LEASE_KEY_FILE:leaseFile,
    MEMO_BRIDGE_GOVERNANCE_ROOT:governance
  };
  const env = {};
  const run = (options={}) => bootstrapStdioMacOwnerPolicy({
    home,uid:process.getuid(),platformName:'darwin',env,readPlist:()=>saved,...options
  });
  return {home,dir,env,saved,run,privateFile,remoteFile,externalFile,leaseFile,governance,plist};
}

test('loads only the installed, uid-owned Mac owner policy and never copies unrelated plist entries', t => {
  const f=fixture(t);
  assert.equal(f.run(),true);
  assert.equal(f.env.MEMO_BRIDGE_OWNER_SUB,SUB);
  assert.equal(f.env.MEMO_BRIDGE_REMOTE_CONFIG,f.remoteFile);
  assert.equal(f.env.MEMO_BRIDGE_GOVERNANCE_ROOT,f.governance);
  assert.equal(f.env.MEMO_BRIDGE_PRIVATE_UNUSED,undefined);
  assert.equal(f.run(),false,'explicit environment is not overwritten');
});
test('never autoloads on VPS, read-only, or explicitly configured processes', t => {
  const f=fixture(t);
  assert.equal(f.run({platformName:'linux'}),false);
  assert.equal(f.run({env:{MEMO_BRIDGE_READ_ONLY:'1'}}),false);
  assert.equal(f.run({env:{MEMO_BRIDGE_REMOTE_CONFIG:'/explicit'}}),false);
  assert.equal(f.run({env:{MEMO_BRIDGE_DISABLE_OWNER_AUTOLOAD:'1'}}),false);
  assert.equal(f.run({env:{MEMOLABS_ROOT:'/tmp/test-root'}}),false);
});
test('fails closed on changed owner, inactive runtime, or mismatched policy paths', t => {
  const f=fixture(t);
  f.saved.MEMO_BRIDGE_OWNER_SUB='other';
  assert.equal(f.run(),false);
  f.saved.MEMO_BRIDGE_OWNER_SUB=SUB;
  f.saved.MEMO_BRIDGE_AGENT_MODE='probe';
  assert.equal(f.run(),false);
  f.saved.MEMO_BRIDGE_AGENT_MODE='runtime';
  f.saved.MEMO_BRIDGE_REMOTE_CONFIG='/tmp/remote.json';
  assert.equal(f.run(),false);
  assert.deepEqual(f.env,{});
});
test('fails closed on unsafe policy modes and symlinked owner files', t => {
  const f=fixture(t);
  chmodSync(f.privateFile,0o644);
  assert.equal(f.run(),false);
  chmodSync(f.privateFile,0o600);
  rmSync(f.privateFile);
  symlinkSync(f.remoteFile,f.privateFile);
  assert.equal(f.run(),false);
  assert.deepEqual(f.env,{});
});
test('fails closed on missing governance pin and home-directory ledger regression', t => {
  const f=fixture(t);
  f.saved.MEMO_BRIDGE_GOVERNANCE_ROOT='/tmp/anything';
  assert.equal(f.run(),false);
  f.saved.MEMO_BRIDGE_GOVERNANCE_ROOT=f.governance;
  writeFileSync(join(f.governance,'scripts','private_owner_allowlist.py'),'import os;os.environ["HOME"]');
  assert.equal(f.run(),false);
  assert.deepEqual(f.env,{});
});
