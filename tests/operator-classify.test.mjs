// Repatriation (spec .agent/project/repatriate, RR-1, RR-2, RR-3, RR-10, D-R1 to D-R3, D-R9): the
// danger classifier splits hard reasons (ask every time) from grantable ones (a standing
// approval can cover them), and classifies gh, git, ssh, scp, rsync and docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalInScope, classifyCall, dangerReason } from '../bridge/operator-dangerous.mjs';

const run = argv => classifyCall('operator_run', { argv });

test('RR-1 gh: merge, deletions, secrets, auth and protected api writes are hard; reads are free', () => {
  const hard = [
    ['gh', 'pr', 'merge', '1'], ['gh', '-R', 'o/r', 'pr', 'merge', '2', '--squash'], ['gh', 'repo', 'delete', 'o/r', '--yes'],
    ['gh', 'repo', 'edit', '--visibility', 'public'], ['gh', 'release', 'delete', 'v1'], ['gh', 'secret', 'set', 'X'], ['gh', 'secret', 'list'],
    ['gh', 'auth', 'token'], ['gh', 'variable', 'set', 'A'], ['gh', 'workflow', 'run', 'deploy.yml'], ['gh', 'extension', 'install', 'x/y'],
    ['gh', 'alias', 'set', 'co', '--shell', 'id'], ['gh', 'issue', 'delete', '3'], ['gh', 'run', 'delete', '9'],
    ['gh', 'api', '-X', 'DELETE', '/repos/o/r'], ['gh', 'api', '--method=DELETE', 'repos/o/r/issues/comments/1'],
    ['gh', 'api', '/repos/o/r/pulls/1/merge', '-X', 'PUT'], ['gh', 'api', '-XPATCH', 'repos/o/r'],
    ['gh', 'api', 'repos/o/r/branches/main/protection', '--method', 'PUT', '--input', 'p.json'],
    ['gh', 'api', 'repos/o/r/git/refs/heads/main', '-f', 'sha=abc', '-F', 'force=true'], ['gh', 'api', 'repos/o/r/hooks', '-f', 'url=x'],
    ['gh', 'api', 'graphql', '-f', 'query=mutation { mergePullRequest(input:{}) { clientMutationId } }'], ['gh', 'api', 'graphql', '--input', 'q.json'],
    ['/opt/homebrew/bin/gh', 'pr', 'merge', '1']
  ];
  for (const argv of hard) {
    const c = run(argv);
    assert.equal(c?.hard, true, argv.join(' '));
    assert.match(c.reason, /^gh:/, argv.join(' '));
  }
  const free = [['gh', 'pr', 'view', '1'], ['gh', 'pr', 'list'], ['gh', 'pr', 'checks', '1'], ['gh', 'issue', 'list'], ['gh', 'run', 'view', '1'],
    ['gh', 'api', '/repos/o/r'], ['gh', 'api', 'repos/o/r/pulls?state=open'], ['gh', 'api', '-X', 'GET', 'repos/o/r/branches/main/protection'],
    ['gh', 'api', 'graphql', '-f', 'query={ viewer { login } }'], ['gh', 'pr', 'create', '--fill'], ['gh', 'api', 'repos/o/r/issues/1/comments', '-f', 'body=x']];
  for (const argv of free) assert.equal(run(argv), null, argv.join(' '));
});

test('RR-2 git: force or deleting pushes, pushes to main, reset --hard, clean -f, branch -D are hard, also behind env', () => {
  const hard = [['git', 'push', '-f'], ['git', 'push', '--force', 'origin', 'x'], ['git', 'push', '--force-with-lease'], ['git', 'push', '-fu', 'origin', 'x'],
    ['git', 'push', 'origin', '+x'], ['git', 'push', 'origin', ':x'], ['git', 'push', '--delete', 'origin', 'x'], ['git', 'push', 'origin', 'main'],
    ['git', 'push', 'origin', 'HEAD:refs/heads/master'], ['git', 'push', '--mirror'], ['git', '-C', '/repo', 'reset', '--hard', 'HEAD~1'],
    ['git', 'clean', '-fdx'], ['git', 'clean', '--force'], ['git', 'branch', '-D', 'x'], ['git', 'branch', '--delete', '--force', 'x'],
    ['git', 'filter-branch'], ['git', 'reflog', 'expire', '--all'], ['git', 'update-ref', '-d', 'refs/heads/x'], ['git', 'stash', 'clear'],
    ['env', 'git', 'push', '--force'], ['xargs', 'git', 'reset', '--hard'], ['bash', '-c', 'git push -f origin x'], ['ssh', 'lab', 'git -C /srv/x reset --hard']];
  for (const argv of hard) assert.equal(run(argv)?.hard, true, argv.join(' '));
  for (const argv of [['git', 'status'], ['git', 'push', 'origin', 'feat/x'], ['git', 'push', '-u', 'origin', 'feat/x'], ['git', 'commit', '-m', 'msg'],
    ['git', 'reset', '--soft', 'HEAD~1'], ['git', 'branch', '-d', 'x'], ['git', 'clean', '-n']]) {
    assert.deepEqual(run(argv), { reason: 'wrapper:git', hard: false, programs: ['git'] }, argv.join(' '));
  }
});

test('RR-3 hard reasons win over wrappers, over the whole argv and inside shell strings', () => {
  assert.deepEqual(run(['ssh', 'lab', 'rm', '-rf', '/srv/x']), { reason: 'command:rm', hard: true, programs: [] });
  assert.equal(run(['ssh', 'lab', 'rm -rf /srv/x']).reason, 'command:rm');
  assert.equal(run(['bash', '-c', 'cat /etc/shadow']).reason, 'sensitive_path');
  assert.equal(run(['sudo', 'rm', 'x']).reason, 'command:rm');
  // Words of non-shell programs are not split: a commit message naming rm stays a git call.
  assert.equal(run(['git', 'commit', '-m', 'drop the rm -rf step']).reason, 'wrapper:git');
  // Same reason strings as before for the existing list.
  assert.equal(dangerReason('operator_run', { argv: ['bash', '-c', 'echo hi'] }), 'wrapper:bash');
  assert.equal(dangerReason('operator_script', { interpreter: 'bash', content: 'id' }), 'script');
});

test('RR-10 ssh, scp, rsync: remote programs are grantable dangers; local rsync is free; rsync --delete is hard', () => {
  assert.deepEqual(run(['ssh', 'lab', 'uptime']), { reason: 'remote:ssh', hard: false, programs: ['ssh'] });
  assert.deepEqual(run(['/usr/bin/scp', 'a', 'lab:/tmp/a']), { reason: 'remote:scp', hard: false, programs: ['scp'] });
  assert.deepEqual(run(['rsync', '-az', 'dist/', 'lab:/srv/app/']), { reason: 'remote:rsync', hard: false, programs: ['rsync'] });
  assert.equal(run(['rsync', '-a', '-e', 'ssh -p 22', 'x', 'y']).reason, 'remote:rsync');
  assert.equal(run(['rsync', '-avze', 'ssh', 'x', 'lab:y']).reason, 'remote:rsync');
  assert.equal(run(['rsync', '-a', '/Users/memo/a/', '/Users/memo/b/']), null);
  assert.equal(run(['rsync', '-a', '--delete', 'a/', 'lab:/srv/b/']).reason, 'rsync:delete');
  assert.equal(run(['rsync', '-a', '--remove-source-files', 'a', 'b']).hard, true);
  // A prefix wrapper names every program behind it: a grant must name both.
  assert.deepEqual(run(['timeout', '5', 'ssh', 'lab', 'id']).programs, ['timeout', 'ssh']);
  // An argument that merely names ssh is not a program.
  assert.equal(run(['systemctl', 'status', 'ssh']), null);
});

test('docker: rm, prune and compose down -v are hard; operator_docker stop or restart of the proxy or the bridge is hard', () => {
  for (const argv of [['docker', 'rm', '-f', 'x'], ['docker', 'system', 'prune', '-a'], ['docker', 'volume', 'rm', 'v'],
    ['docker', 'compose', 'down', '-v'], ['docker', '--context', 'lab', 'rmi', 'img']]) assert.equal(run(argv)?.hard, true, argv.join(' '));
  assert.deepEqual(run(['docker', 'ps']), { reason: 'wrapper:docker', hard: false, programs: ['docker'] });
  assert.deepEqual(classifyCall('operator_docker', { action: 'restart', container: 'traefik' }), { reason: 'docker:restart', hard: true, programs: [] });
  assert.equal(classifyCall('operator_docker', { action: 'stop', container: 'memo-bridge-auth-pocket-id-1' })?.hard, true);
  assert.equal(classifyCall('operator_docker', { action: 'restart', container: 'beszel' }), null);
  assert.equal(classifyCall('operator_docker', { action: 'ps' }), null);
});

test('scripts: a user script is grantable by its interpreter, a root script is hard', () => {
  assert.deepEqual(classifyCall('operator_script', { interpreter: 'python3', content: 'x' }), { reason: 'script', hard: false, programs: ['python3'] });
  assert.equal(classifyCall('operator_script', { interpreter: 'bash', content: 'x', as_root: true }).hard, true);
});

test('D-R5 approvalInScope: a standing id never stands for a hard call, a root call or another op', () => {
  const st = 'ap_st_AAAAAAAAAAAAAAAAAAAAAA';
  assert.equal(approvalInScope(st, 'operator_run', { argv: ['git', 'status'] }, 2), true);
  assert.equal(approvalInScope(st, 'operator_run', { argv: ['git', 'push', '-f'] }, 2), false);
  assert.equal(approvalInScope(st, 'operator_run', { argv: ['git', 'status'], as_root: true }, 3), false);
  assert.equal(approvalInScope(st, 'operator_delete', { path: '/x', recursive: true }, 1), false);
  assert.equal(approvalInScope('ap_AAAAAAAAAAAAAAAAAAAAAAAA', 'operator_run', { argv: ['git', 'push', '-f'] }, 2), true, 'single-use ids unchanged');
  assert.equal(approvalInScope(null, 'operator_run', { argv: ['id'] }, 2), true);
});
