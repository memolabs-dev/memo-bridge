// Phase 4, TODO-P4-10 and TODO-P4-11: the runner's two GitHub credentials (spec D6).
// - ledger-gh: issue-lease.mjs passes GH_TOKEN and a private GH_CONFIG_DIR to the python child
//   only, read from $CREDENTIALS_DIRECTORY (systemd LoadCredential=), and fails closed without it.
// - push-gh: worktrees.mjs authenticates Git's network calls only through the GIT_ASKPASS helper
//   git-askpass.mjs, keeps GIT_SAFETY on every call and never runs repository hooks.
// Tokens here are random test values in temporary directories; nothing reads the user's real
// credentials, the network or GitHub. Real git runs against a local bare origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../server/runtime.mjs';
import { CAPABILITIES, makePrincipal } from '../server/coordinator/policy.mjs';
import {
  LEDGER_CREDENTIAL, PUSH_CREDENTIAL, createIssueLeaseClient, credentialPath, ledgerChildEnv, parseIssueRef, readTokenFile
} from '../server/coordinator/issue-lease.mjs';
import { ASKPASS_CREDENTIAL_VAR, ASKPASS_PATH, createWorktreeRunner, gitBaseEnv, networkGit } from '../server/runners/worktrees.mjs';
import { FAKE_GH_DIR, GOVERNANCE_ROOT, fakeGitHub, skipWithoutLedger } from './helpers/coordinator-fixture.mjs';

const OWNER = makePrincipal('local:owner', Object.values(CAPABILITIES));
const ISSUE = 'memolabs-dev/drop#7';
const token = () => `test_token_${randomBytes(20).toString('hex')}`;
const sha = value => createHash('sha256').update(value).digest('hex');

async function temp(t, prefix) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A systemd-like credentials directory: one file per credential, read-only.
async function credentials(t, values) {
  const dir = await temp(t, 'memo-creds-');
  for (const [name, value] of Object.entries(values)) {
    await writeFile(join(dir, name), `${value}\n`, { mode: 0o400 });
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Token files

test('readTokenFile: one bounded token from a regular file, never a symlink or a FIFO', async t => {
  const dir = await temp(t, 'memo-token-');
  const value = token();
  await writeFile(join(dir, 'ok'), `${value}\n`);
  assert.deepEqual(await readTokenFile(join(dir, 'ok')), { token: value });
  assert.deepEqual(await readTokenFile(join(dir, 'missing')), { error: 'credential_missing' });
  await symlink(join(dir, 'ok'), join(dir, 'link'));
  assert.deepEqual(await readTokenFile(join(dir, 'link')), { error: 'credential_unreadable' });
  execFileSync('mkfifo', [join(dir, 'fifo')]);
  assert.deepEqual(await readTokenFile(join(dir, 'fifo')), { error: 'credential_invalid' }, 'a FIFO never blocks');
  await writeFile(join(dir, 'big'), 'a'.repeat(5000));
  assert.deepEqual(await readTokenFile(join(dir, 'big')), { error: 'credential_invalid' });
  for (const [name, content] of [['spaces', 'two tokens'], ['short', 'abc'], ['empty', ''], ['multi', `${value}\n${value}`]]) {
    await writeFile(join(dir, name), content);
    assert.deepEqual(await readTokenFile(join(dir, name)), { error: 'credential_invalid' }, name);
  }
  // The error never carries the content.
  await writeFile(join(dir, 'secretish'), `${value} trailing`);
  assert.ok(!JSON.stringify(await readTokenFile(join(dir, 'secretish'))).includes(value));
});

test('credentialPath: only under an absolute $CREDENTIALS_DIRECTORY, only for our names', () => {
  assert.equal(credentialPath({}, LEDGER_CREDENTIAL), null);
  assert.equal(credentialPath({ CREDENTIALS_DIRECTORY: '' }, LEDGER_CREDENTIAL), null);
  assert.equal(credentialPath({ CREDENTIALS_DIRECTORY: 'relative' }, LEDGER_CREDENTIAL), null);
  assert.equal(credentialPath({ CREDENTIALS_DIRECTORY: '/run/credentials/x.service' }, LEDGER_CREDENTIAL),
    '/run/credentials/x.service/ledger-gh');
  assert.equal(credentialPath({ CREDENTIALS_DIRECTORY: '/run/c' }, '../push-gh'), null);
  assert.equal(credentialPath({ CREDENTIALS_DIRECTORY: '/run/c' }, 'Push/GH'), null);
});

// ---------------------------------------------------------------------------------------------
// Ledger (TODO-P4-10, AC-P4-03 offline part)

function recordingRun(calls, inspect = () => ({})) {
  return async (command, args, opts) => {
    calls.push({ command, args, env: opts.env, seen: await inspect(opts.env) });
    return { code: 0, stdout: JSON.stringify({ state: 'free' }), stderr: '' };
  };
}

async function governance(t) {
  const root = await temp(t, 'memo-gov-');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'issue_lease.py'), '# stub, never executed by these tests\n');
  return root;
}

test('ledger with ledger-gh: GH_TOKEN and a private GH_CONFIG_DIR reach the python child only', async t => {
  const root = await governance(t);
  const value = token();
  const credsDir = await credentials(t, { [LEDGER_CREDENTIAL]: value, [PUSH_CREDENTIAL]: token() });
  const scratch = join(await temp(t, 'memo-state-'), 'state', 'ledger-gh');
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CREDENTIALS_DIRECTORY: credsDir, GITHUB_TOKEN: 'ambient_should_not_pass',
    GH_HOST: 'evil.example', XDG_CONFIG_HOME: '/somewhere/else', KEEP_ME: '1' };
  const calls = [];
  const inspect = async childEnv => {
    const info = await stat(childEnv.GH_CONFIG_DIR);
    return { dir: info.isDirectory(), mode: info.mode & 0o777 };
  };
  const ledger = createIssueLeaseClient({ root, env, scratchDir: scratch, run: recordingRun(calls, inspect) });
  const before = { ...process.env };

  const result = await ledger.status(parseIssueRef(ISSUE));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  const [{ command, args, env: child, seen }] = calls;
  assert.equal(command, 'python3');
  assert.deepEqual(args.slice(0, 2), ['-E', '-s']);
  assert.deepEqual(args.slice(3), ['status', '--repo', 'memolabs-dev/drop', '--issue', '7'], 'arguments unchanged, no token in argv');
  assert.ok(!args.join(' ').includes(value));
  assert.equal(child.GH_TOKEN, value);
  assert.equal(dirname(child.GH_CONFIG_DIR), scratch, 'private config dir under the runner state');
  assert.deepEqual(seen, { dir: true, mode: 0o700 });
  assert.equal(child.HOME, child.GH_CONFIG_DIR);
  assert.ok(child.XDG_CONFIG_HOME.startsWith(child.GH_CONFIG_DIR));
  assert.equal(child.GH_PROMPT_DISABLED, '1');
  assert.equal(child.KEEP_ME, '1');
  for (const name of ['CREDENTIALS_DIRECTORY', 'GITHUB_TOKEN', 'GH_HOST']) assert.equal(child[name], undefined, name);
  assert.equal((await stat(scratch)).mode & 0o777, 0o700);
  assert.equal(existsSync(child.GH_CONFIG_DIR), false, 'removed after the call');
  // Nothing leaked into this process or the caller's env object.
  assert.deepEqual({ ...process.env }, before);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(process.env.GH_TOKEN === value, false);

  // Mutating calls carry the same environment and a fresh directory each time.
  await ledger.claim(parseIssueRef(ISSUE), 'mb.vps.ws_test', 300);
  assert.equal(calls[1].env.GH_TOKEN, value);
  assert.notEqual(calls[1].env.GH_CONFIG_DIR, child.GH_CONFIG_DIR);
});

test('ledger fails closed without a usable ledger-gh credential, before starting python', async t => {
  const root = await governance(t);
  const scratch = join(await temp(t, 'memo-state-'), 'ledger-gh');
  const cases = [
    [{}, 'ledger-gh credential_missing'],
    [{ [LEDGER_CREDENTIAL]: 'not a token' }, 'ledger-gh credential_invalid'],
    [{ [PUSH_CREDENTIAL]: token() }, 'ledger-gh credential_missing']
  ];
  for (const [files, detail] of cases) {
    const calls = [];
    const env = { PATH: process.env.PATH, CREDENTIALS_DIRECTORY: await credentials(t, files), GH_TOKEN: 'ambient' };
    const ledger = createIssueLeaseClient({ root, env, scratchDir: scratch, run: recordingRun(calls) });
    for (const call of [() => ledger.status(parseIssueRef(ISSUE)), () => ledger.claim(parseIssueRef(ISSUE), 'mb.vps.ws_test', 300)]) {
      // Not ledger_outcome_unknown: nothing was started, so nothing can have reached GitHub.
      assert.deepEqual(await call(), { ok: false, error: 'ledger_unavailable', detail });
    }
    assert.equal(calls.length, 0, 'no ambient fallback');
  }
});

test('ledger refuses a gh config parent that other users can read', async t => {
  const root = await governance(t);
  const shared = await temp(t, 'memo-shared-');
  await chmod(shared, 0o755);
  const calls = [];
  const env = { PATH: process.env.PATH, CREDENTIALS_DIRECTORY: await credentials(t, { [LEDGER_CREDENTIAL]: token() }) };
  const ledger = createIssueLeaseClient({ root, env, scratchDir: shared, run: recordingRun(calls) });
  assert.deepEqual(await ledger.status(parseIssueRef(ISSUE)), { ok: false, error: 'ledger_unavailable', detail: 'gh config dir unavailable' });
  assert.equal(calls.length, 0);
});

test('ledger without systemd credentials (Mac) keeps the operator gh login, unchanged', async t => {
  const root = await governance(t);
  const calls = [];
  const env = { PATH: process.env.PATH, HOME: '/Users/someone', GH_CONFIG_DIR: '/Users/someone/.config/gh' };
  const ledger = createIssueLeaseClient({ root, env, run: recordingRun(calls) });
  assert.equal((await ledger.status(parseIssueRef(ISSUE))).ok, true);
  assert.deepEqual(calls[0].env, { ...env, GH_PROMPT_DISABLED: '1' });
});

test('ledgerChildEnv strips every credential carrier before adding its own', () => {
  const child = ledgerChildEnv({ PATH: '/usr/bin', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'y', GIT_ASKPASS: '/a',
    SSH_ASKPASS: '/b', CREDENTIALS_DIRECTORY: '/run/c' }, 'tok_aaaaaaaaaaaaaaaaaaaaaa', '/state/gh-1');
  for (const name of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'CREDENTIALS_DIRECTORY']) {
    assert.equal(child[name], undefined, name);
  }
  assert.equal(child.GH_TOKEN, 'tok_aaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(child.GH_CONFIG_DIR, '/state/gh-1');
  assert.equal(child.PATH, '/usr/bin');
});

// End to end through the canonical issue_lease.py and the offline fake gh, behind a `gh`
// wrapper that records what the ledger's gh process received (a digest of the token, never
// the token itself), via the runtime's own ledger client.
test('runtime ledger on the VPS: canonical script, token only in gh, config dir under the state dir', { skip: skipWithoutLedger }, async t => {
  const github = await fakeGitHub(t);
  const bin = await temp(t, 'memo-ghwrap-');
  const log = join(bin, 'calls.jsonl');
  await writeFile(join(bin, 'gh'), [
    '#!/usr/bin/env python3',
    'import hashlib, json, os, stat, sys',
    'env = os.environ',
    'cfg = env.get("GH_CONFIG_DIR", "")',
    'mode = stat.S_IMODE(os.stat(cfg).st_mode) if cfg and os.path.isdir(cfg) else None',
    'rec = {"token": hashlib.sha256(env.get("GH_TOKEN", "").encode()).hexdigest(), "cfg": cfg, "mode": mode,',
    '       "creds": "CREDENTIALS_DIRECTORY" in env, "github_token": "GITHUB_TOKEN" in env}',
    'open(env["GHWRAP_LOG"], "a").write(json.dumps(rec) + "\\n")',
    `os.execv(${JSON.stringify(join(FAKE_GH_DIR, 'gh'))}, [${JSON.stringify(join(FAKE_GH_DIR, 'gh'))}] + sys.argv[1:])`,
    ''
  ].join('\n'), { mode: 0o755 });
  const value = token();
  const stateDir = join(await temp(t, 'memo-rt-'), 'state');
  const env = { ...github.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GHWRAP_LOG: log,
    CREDENTIALS_DIRECTORY: await credentials(t, { [LEDGER_CREDENTIAL]: value }), GITHUB_TOKEN: 'ambient_should_not_pass' };
  delete env.GH_TOKEN;
  const rt = createRuntime({ stateDir, principal: OWNER, host: 'vps', env });
  t.after(() => rt.close());
  assert.notEqual(GOVERNANCE_ROOT, '');

  const issue = parseIssueRef(ISSUE);
  const claimed = await rt.ledger.claim(issue, 'mb.vps.ws_cred_test', 120);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const { claim_id: claimId, fence_sha: fence } = claimed.receipt;
  assert.equal((await rt.ledger.heartbeat(issue, 'mb.vps.ws_cred_test', claimId, fence, 120)).ok, true);
  const renewed = (await rt.ledger.status(issue)).receipt;
  assert.equal((await rt.ledger.release(issue, 'mb.vps.ws_cred_test', claimId, renewed.fence_sha ?? fence, 'completed')).ok, true);

  const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.length >= 4, `gh ran ${records.length} times`);
  for (const record of records) {
    assert.equal(record.token, sha(value), 'gh authenticated with ledger-gh');
    assert.equal(dirname(record.cfg), join(stateDir, 'ledger-gh'));
    assert.equal(record.mode, 0o700);
    assert.equal(record.creds, false);
    assert.equal(record.github_token, false);
  }
  assert.equal(new Set(records.map(r => r.cfg)).size > 1, true, 'one private directory per call');
  assert.ok(records.every(r => !existsSync(r.cfg)), 'directories removed');
});

// ---------------------------------------------------------------------------------------------
// GIT_ASKPASS helper (TODO-P4-11)

function credentialFill(input, { env }) {
  return spawnSync('git', ['-c', 'credential.helper=', 'credential', 'fill'], { input, env, encoding: 'utf8', timeout: 20_000 });
}

test('git-askpass answers GitHub HTTPS prompts only, through real git; other helpers are off', async t => {
  accessSync(ASKPASS_PATH, fsConstants.X_OK);
  const dir = await temp(t, 'memo-askpass-');
  const value = token();
  const credsDir = await credentials(t, { [PUSH_CREDENTIAL]: value });
  // A global configuration with helpers that would leak another credential if they ran.
  await writeFile(join(dir, 'gitconfig'), [
    '[credential "https://github.com"]', '\thelper = "!f() { echo username=leak; echo password=leakedpass; }; f"',
    '[credential]', '\thelper = "!f() { echo password=leakedpass2; }; f"', ''
  ].join('\n'));
  const base = { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const net = await networkGit({ ...base, CREDENTIALS_DIRECTORY: credsDir });
  assert.deepEqual(net.config, ['-c', 'credential.helper=']);
  assert.equal(net.env.GIT_ASKPASS, ASKPASS_PATH);
  assert.equal(net.env[ASKPASS_CREDENTIAL_VAR], join(credsDir, PUSH_CREDENTIAL));
  assert.equal(net.env.CREDENTIALS_DIRECTORY, undefined);
  assert.ok(!Object.values(net.env).includes(value), 'the token is not in the environment');

  const ok = credentialFill('protocol=https\nhost=github.com\n\n', { env: net.env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^username=x-access-token$/m);
  assert.ok(ok.stdout.split('\n').includes(`password=${value}`));
  assert.ok(!ok.stdout.includes('leak'));

  for (const input of ['protocol=https\nhost=evil.example\n\n', 'protocol=http\nhost=github.com\n\n',
    'protocol=https\nhost=github.com:8443\n\n', 'protocol=https\nhost=github.com.evil.example\n\n']) {
    const refused = credentialFill(input, { env: net.env });
    assert.notEqual(refused.status, 0, input);
    assert.ok(!refused.stdout.includes(value) && !refused.stdout.includes('leak'), input);
  }
  // No credential file behind the variable: no answer.
  const missing = credentialFill('protocol=https\nhost=github.com\n\n', { env: { ...net.env, [ASKPASS_CREDENTIAL_VAR]: join(dir, 'nope') } });
  assert.notEqual(missing.status, 0);
  const relative = credentialFill('protocol=https\nhost=github.com\n\n', { env: { ...net.env, [ASKPASS_CREDENTIAL_VAR]: 'push-gh' } });
  assert.notEqual(relative.status, 0);
});

test('networkGit and gitBaseEnv: Mac unchanged; VPS fails closed without push-gh', async t => {
  const mac = { PATH: '/usr/bin', HOME: '/Users/x', GH_TOKEN: 'kept_on_mac' };
  assert.deepEqual(await networkGit(mac), { config: [], env: mac });
  assert.equal(gitBaseEnv(mac), mac);
  const credsDir = await credentials(t, { [LEDGER_CREDENTIAL]: token() });
  const vps = { PATH: '/usr/bin', CREDENTIALS_DIRECTORY: credsDir, GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GIT_ASKPASS: '/tmp/evil' };
  assert.deepEqual(await networkGit(vps), { error: { ok: false, error: 'credential_unavailable', detail: 'push-gh credential_missing' } });
  assert.deepEqual(gitBaseEnv(vps), { PATH: '/usr/bin' });
});

// ---------------------------------------------------------------------------------------------
// Runner-side push on a local bare origin, through a `git` wrapper that records each call.

const REGISTRY = `# Projects

## Projets appartenant a Memo Labs

| Name | Path | Kind | Status | Nature | Stack | Vault |
|---|---|---|---|---|---|---|
| demo | demo | repo | active | test project | node | - |
`;

function realGit() {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const candidate = join(dir, 'git');
    try { if (statSync(candidate).isFile()) { accessSync(candidate, fsConstants.X_OK); return candidate; } } catch { /* next */ }
  }
  throw new Error('git not found');
}

async function pushFixture(t, { files }) {
  const base = await temp(t, 'memo-push-');
  await writeFile(join(base, 'gitconfig'), ['[user]', '\tname = Test Owner', '\temail = owner@example.test',
    '[init]', '\tdefaultBranch = main', '[commit]', '\tgpgsign = false', ''].join('\n'));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'CREDENTIALS_DIRECTORY', 'GIT_ASKPASS']) delete gitEnv[name];
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const projectsRoot = join(base, 'projects');
  const repo = join(projectsRoot, 'demo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(projectsRoot, 'PROJECTS.md'), REGISTRY);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // Repository hooks that must never run (R-P4-05): they would leave a marker.
  const marker = join(base, 'hook-ran');
  for (const hook of ['pre-commit', 'post-commit', 'pre-push', 'reference-transaction', 'post-checkout']) {
    await writeFile(join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
  }

  const bin = join(base, 'bin');
  await mkdir(bin);
  const log = join(base, 'git-calls.jsonl');
  await writeFile(join(bin, 'git'), [
    `#!${process.execPath}`,
    "const { appendFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const e = process.env;',
    "appendFileSync(e.GITWRAP_LOG, JSON.stringify({ argv: process.argv.slice(2), askpass: e.GIT_ASKPASS || null, cred: e.MEMO_BRIDGE_ASKPASS_CREDENTIAL || null,",
    "  creds: 'CREDENTIALS_DIRECTORY' in e, ghToken: 'GH_TOKEN' in e || 'GITHUB_TOKEN' in e }) + '\\n');",
    `const r = spawnSync(${JSON.stringify(realGit())}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);',
    ''
  ].join('\n'), { mode: 0o755 });

  const credsDir = await credentials(t, files);
  const env = { ...gitEnv, PATH: `${bin}${delimiter}${process.env.PATH}`, GITWRAP_LOG: log, CREDENTIALS_DIRECTORY: credsDir,
    MEMO_BRIDGE_WORKTREES_ROOT: join(base, 'worktrees'), GH_TOKEN: 'ambient_should_not_pass' };
  const ledger = { status: async () => ({ ok: true, receipt: {} }), claim: async () => ({ ok: true, receipt: {} }),
    heartbeat: async () => ({ ok: true, receipt: {} }), release: async () => ({ ok: true, receipt: {} }), verify: async () => ({ ok: true, receipt: {} }) };
  const rt = createRuntime({ stateDir: join(base, 'state'), principal: OWNER, ledger, catalogOptions: { projectsRoot }, host: 'vps', env });
  t.after(() => rt.close());
  const runner = createWorktreeRunner(rt, { env });

  const at = Date.now();
  const ws = `ws_${randomBytes(12).toString('base64url')}`;
  await rt.store().transaction(r => r.insertWorkspace({ id: ws, principal: OWNER.id, client_type: 'claude-code', client_label: null,
    project_id: 'demo', host: 'vps', branch: null, status: 'active', created_at: at, updated_at: at }));
  await rt.store().transaction(r => r.insertClaim({ claim_id: randomBytes(16).toString('hex'), workspace_id: ws, issue_ref: ISSUE,
    fence_sha: randomBytes(20).toString('hex'), epoch: 1, expires_at: new Date(at + 600_000).toISOString(), updated_at: at }));
  const calls = async () => existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [];
  return { base, repo, origin, git, rt, runner, ws, marker, calls, credsDir };
}

const NETWORK = new Set(['fetch', 'ls-remote', 'push']);
const subcommand = argv => {
  // git -C <cwd> -c k=v ... <subcommand>
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-C' || argv[i] === '-c') { i++; continue; }
    return argv[i];
  }
  return null;
};

test('runner push with push-gh: askpass only on network calls, GIT_SAFETY everywhere, hooks never run, checkpoint kept', async t => {
  const f = await pushFixture(t, { files: { [PUSH_CREDENTIAL]: token(), [LEDGER_CREDENTIAL]: token() } });
  const ctx = () => ({ ids: {} });
  const created = await f.runner.create({ workspace_id: f.ws, issue: ISSUE }, ctx());
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.worktree.worktree_id;
  assert.equal((await f.runner.writeFile({ worktree_id: id, path: 'src/a.txt', content: 'a\n' }, ctx())).ok, true);
  const committed = await f.runner.commit({ worktree_id: id, message: 'feat: a' }, ctx());
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const pushed = await f.runner.push({ worktree_id: id }, ctx());
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(f.git(f.origin, 'rev-parse', `refs/heads/${created.worktree.branch}`), committed.commit);
  assert.deepEqual(pushed.checkpoint, { ok: true, durability: 'remote' }, 'checkpoint flow unchanged');

  const calls = await f.calls();
  const seen = new Set(calls.map(c => subcommand(c.argv)));
  for (const name of NETWORK) assert.ok(seen.has(name), `${name} ran`);
  for (const call of calls) {
    const sub = subcommand(call.argv);
    const joined = call.argv.join(' ');
    assert.ok(joined.includes('core.hooksPath=/dev/null') && joined.includes('core.fsmonitor=false'), `GIT_SAFETY on ${sub}`);
    assert.equal(call.creds, false, `${sub}: no credentials directory`);
    assert.equal(call.ghToken, false, `${sub}: no token variable`);
    if (NETWORK.has(sub)) {
      assert.equal(call.askpass, ASKPASS_PATH, `${sub} uses the askpass helper`);
      assert.equal(call.cred, join(f.credsDir, PUSH_CREDENTIAL));
      assert.ok(call.argv.includes('credential.helper='), `${sub} disables other helpers`);
    } else {
      assert.equal(call.askpass, null, `${sub} gets no askpass`);
      assert.equal(call.cred, null);
    }
    assert.ok(!call.argv.some(arg => /test_token_/.test(arg)), 'no token in argv');
  }
  assert.equal(existsSync(f.marker), false, 'no repository hook ran');
});

test('runner push without push-gh fails closed with credential_unavailable and pushes nothing', async t => {
  const f = await pushFixture(t, { files: { [PUSH_CREDENTIAL]: token() } });
  const ctx = () => ({ ids: {} });
  const created = await f.runner.create({ workspace_id: f.ws, issue: ISSUE }, ctx());
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.worktree.worktree_id;
  await f.runner.writeFile({ worktree_id: id, path: 'b.txt', content: 'b\n' }, ctx());
  assert.equal((await f.runner.commit({ worktree_id: id, message: 'feat: b' }, ctx())).ok, true);
  // The credential disappears (credstore emptied, unit restarted without it).
  await rm(join(f.credsDir, PUSH_CREDENTIAL));
  const before = (await f.calls()).length;
  const pushed = await f.runner.push({ worktree_id: id }, ctx());
  assert.deepEqual(pushed, { ok: false, error: 'credential_unavailable', detail: 'push-gh credential_missing' });
  assert.ok(!(await f.calls()).slice(before).some(c => NETWORK.has(subcommand(c.argv))), 'no network call attempted');
  assert.throws(() => f.git(f.origin, 'rev-parse', '--verify', `refs/heads/${created.worktree.branch}`));
  // worktree_create fails the same way.
  assert.deepEqual(await f.runner.create({ workspace_id: f.ws, issue: ISSUE, branch: 'agent/other' }, ctx()),
    { ok: false, error: 'credential_unavailable', detail: 'push-gh credential_missing' });
});
