import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionHost } from '../server/project-host-route.mjs';

const macDiscovered = { name: 'clinical-data-knowledge-foundation', metadata_only: true, source_host: 'mac', available: false };
test('CDKF discovery cannot silently authorize execution on VPS or Mac', () => {
  assert.equal(resolveExecutionHost({ project:macDiscovered, authorizedHosts:['mac','vps'] }).error,'project_discovery_only');
  assert.equal(resolveExecutionHost({ project:macDiscovered, requestedHost:'vps', authorizedHosts:['mac','vps'] }).error,'project_discovery_only');
});
test('a verified checkout needs an explicit matching host authorization', () => {
  const p={name:'clinical-data-knowledge-foundation',source_host:'mac',available:true};
  assert.equal(resolveExecutionHost({project:p,requestedHost:'mac',authorizedHosts:[]}).error,'host_not_authorized');
  assert.equal(resolveExecutionHost({project:p,requestedHost:'vps',authorizedHosts:['vps']}).error,'project_host_mismatch');
  assert.deepEqual(resolveExecutionHost({project:p,requestedHost:'mac',authorizedHosts:['mac']}),{ok:true,project:p.name,host:'mac'});
});
test('absent and unavailable projects fail closed', () => {
  assert.equal(resolveExecutionHost({}).error,'project_not_found');
  assert.equal(resolveExecutionHost({project:{name:'cdkf'},requestedHost:'mac',authorizedHosts:['mac']}).error,'project_unavailable');
});
