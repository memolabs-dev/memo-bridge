import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, parseRepo } from '../server/integrations/github.mjs';

const data = { number: 7, state: 'closed',
  body: '<!-- memo-bridge:requires:v1 {"requires":["memolabs-dev/drop#8"]} -->' };
const make = (response = data) => {
  const calls = [];
  const gh = async argv => {
    const path = argv.find(x => x.startsWith('repos/'));
    calls.push(path);
    return { code: 0, stdout: JSON.stringify(response), stderr: '' };
  };
  const api = createGitHub({ gh, now: () => Date.parse('2026-10-23T12:00:00Z'),
    registeredRepos: async () => ['memolabs-dev/drop'] });
  return { api, calls };
};
test('scoped single GitHub Issue read returns a fresh observation and the full body', async () => {
  const {api, calls} = make();
  const r = await api.issue(parseRepo('memolabs-dev/drop'), 7);
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.deepEqual(r.issue, { ref:'memolabs-dev/drop#7', state:'closed',
    body:data.body, authorized:true, observed_at:'2026-10-23T12:00:00.000Z' });
  assert.equal(calls.length,1);
});
test('unknown repository does not hit the GitHub API', async () => {
  const {api,calls}=make();
  assert.equal((await api.issue(parseRepo('private/other'),7)).error,'repo_not_registered');
  assert.deepEqual(calls,[]);
});
test('missing body, wrong Issue number and Pull Request objects fail closed', async () => {
  for(const bad of [{ ...data, body:null }, {...data,number:8}, {...data,pull_request:{url:'x'}}]) {
    const {api} = make(bad);
    assert.equal((await api.issue(parseRepo('memolabs-dev/drop'),7)).ok,false);
  }
});