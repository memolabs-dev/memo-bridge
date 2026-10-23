import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteStack } from './helpers/remote-stack.mjs';

test('OIDC ChatGPT to authenticated Mac runtime retains workspace host across tools', async t => {
  const stack = await remoteStack(t, { runtimeHost:'mac', remote:{
    mac_runtime_routing:'enabled', remote_writes:'enabled', surface:'full'
  } });
  const client = await stack.client(await stack.mint());
  const opened = (await client.call('workspace_open', {
    project:'demo', host:'mac',client_label:'CDKF Mac route acceptance'
  })).data;
  assert.equal(opened?.ok, true, JSON.stringify(opened));
  assert.equal(opened?.workspace?.host, 'mac');
  const workspace_id=opened.workspace.workspace_id;
  const status = (await client.call('workspace_status',{workspace_id})).data;
  assert.equal(status?.ok, true, JSON.stringify(status));
  assert.equal(status?.workspace?.workspace_id,workspace_id);
  assert.equal(status?.workspace?.host,'mac');
  const wrong = (await client.call('workspace_open', {
    project:'demo',host:'vps',client_label:'foreign runtime is refused'
  })).data;
  assert.equal(wrong?.ok, false, JSON.stringify(wrong));
  assert.ok(['host_not_remote_enabled','host_offline'].includes(wrong?.error),JSON.stringify(wrong));
});
