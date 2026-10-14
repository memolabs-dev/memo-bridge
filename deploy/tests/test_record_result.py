"""Tests for deploy/record-result (Phase 4, TODO-P4-12, design decision D5, AC-P4-16, AC-P4-20).

Run: python3 -I -m unittest discover -s deploy/tests -v

record-result runs as `ExecStopPost=+/usr/local/lib/memo-runner/record-result %i`; here it runs
as the current user against a temporary /var/lib/memo-runner, with the variables systemd would
set (systemd.exec(5): $SERVICE_RESULT, $EXIT_CODE, $EXIT_STATUS, $INVOCATION_ID).
"""

import hashlib
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RECORD = os.path.join(os.path.dirname(HERE), 'record-result')
USER = pwd.getpwuid(os.geteuid()).pw_name
JOB_ID = 'job_AbCdEfGh12345678'
# The dispatch id names the unit, its folder and the spool files (executor-systemd.mjs dispatchIdFor).
JOB = 'j' + hashlib.sha256(JOB_ID.encode()).hexdigest()[:31]
INVOCATION = '0123456789abcdef0123456789abcdef'


class RecordResultTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='memo-record-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, 'var-lib-memo-runner')
        self.jobs = os.path.join(self.root, 'jobs')
        os.makedirs(self.jobs)
        os.chmod(self.root, 0o755)
        os.chmod(self.jobs, 0o751)
        self.job_dir = os.path.join(self.jobs, JOB)
        os.mkdir(self.job_dir)
        os.chmod(self.job_dir, 0o751)
        self.dropin = os.path.join(self.tmp, 'run-systemd-system')
        self.unit_dropin = os.path.join(self.dropin, f'memo-job@{JOB}.service.d')
        os.makedirs(self.unit_dropin)
        with open(os.path.join(self.unit_dropin, '50-dispatch.conf'), 'w') as handle:
            handle.write('[Service]\nRuntimeMaxSec=60\n')
        self.config = os.path.join(self.tmp, 'runner.json')
        with open(self.config, 'w') as handle:
            json.dump({'dispatch': {'root': self.root, 'runner_user': USER, 'job_user': USER,
                                    'dropin_dir': self.dropin}}, handle)
        os.chmod(self.config, 0o644)

    def run_record(self, job_id=JOB, **systemd_env):
        env = {'PATH': '/usr/bin:/bin', 'INVOCATION_ID': INVOCATION}
        env.update({key: value for key, value in systemd_env.items() if value is not None})
        for key in [key for key, value in systemd_env.items() if value is None]:
            env.pop(key, None)
        return subprocess.run([sys.executable, '-I', RECORD, '--config', self.config, job_id],
                              env=env, capture_output=True, text=True, timeout=60)

    def status(self):
        with open(os.path.join(self.job_dir, 'status.json')) as handle:
            return json.load(handle)

    def mark_cancel(self, reason):
        path = os.path.join(self.job_dir, 'cancel.json')
        with open(path, 'w') as handle:
            json.dump({'version': 1, 'id': JOB, 'reason': reason, 'requested_at': '2026-10-14T00:00:00.000Z'}, handle)
        os.chmod(path, 0o640)
        return path

    def assertRecorded(self, result, status, reason):
        self.assertEqual(result.returncode, 0, result.stderr)
        document = self.status()
        self.assertEqual(document['status'], status)
        self.assertEqual(document['reason'], reason)
        self.assertEqual((document['version'], document['id']), (1, JOB))
        self.assertEqual(document['unit'], f'memo-job@{JOB}.service')
        self.assertIsNone(document['started_at'])
        self.assertRegex(document['ended_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
        self.assertIn(f'status={status}', result.stderr)
        return document


class MappingTests(RecordResultTestCase):
    def test_clean_exit_is_succeeded(self):
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0'),
                                       'succeeded', None)
        self.assertEqual(document['exit_code'], 'exited')
        self.assertEqual(document['exit_status'], '0')
        self.assertEqual(document['invocation_id'], INVOCATION)
        self.assertIsNone(document['cancel_reason'])

    def test_non_zero_exit_is_failed(self):
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='exit-code', EXIT_CODE='exited', EXIT_STATUS='3'),
                                       'failed', 'exit_status')
        self.assertEqual(document['exit_status'], '3')

    def test_runtime_max_sec_overrun_is_timed_out(self):
        # AC-P4-16: RuntimeMaxSec= overrun is reported as SERVICE_RESULT=timeout.
        self.assertRecorded(self.run_record(SERVICE_RESULT='timeout', EXIT_CODE='killed', EXIT_STATUS='TERM'),
                            'timed_out', 'runtime_max_sec')

    def test_timeout_after_sigkill(self):
        self.assertRecorded(self.run_record(SERVICE_RESULT='timeout', EXIT_CODE='killed', EXIT_STATUS='KILL'),
                            'timed_out', 'runtime_max_sec')

    def test_oom_kill_is_oom(self):
        self.assertRecorded(self.run_record(SERVICE_RESULT='oom-kill', EXIT_CODE='killed', EXIT_STATUS='KILL'),
                            'oom', 'oom_kill')

    def test_oom_wins_over_a_cancel(self):
        self.mark_cancel('cancelled')
        self.assertRecorded(self.run_record(SERVICE_RESULT='oom-kill', EXIT_CODE='killed', EXIT_STATUS='KILL'),
                            'oom', 'oom_kill')

    def test_signal_and_core_dump_are_failed(self):
        self.assertRecorded(self.run_record(SERVICE_RESULT='signal', EXIT_CODE='killed', EXIT_STATUS='SEGV'),
                            'failed', 'signal')
        self.assertRecorded(self.run_record(SERVICE_RESULT='core-dump', EXIT_CODE='dumped', EXIT_STATUS='ABRT'),
                            'failed', 'signal')

    def test_unit_that_never_started(self):
        # WorkingDirectory= gone, start limit, ...: no main process, so no EXIT_CODE/EXIT_STATUS.
        for result, reason in (('resources', 'resources'), ('start-limit-hit', 'start_limit_hit'),
                               ('protocol', 'protocol'), ('exec-condition', 'exec_condition'),
                               ('watchdog', 'watchdog')):
            with self.subTest(result=result):
                document = self.assertRecorded(self.run_record(SERVICE_RESULT=result), 'failed', reason)
                self.assertIsNone(document['exit_code'])
                self.assertIsNone(document['exit_status'])

    def test_clean_sigterm_without_marker_is_failed(self):
        # A stop by SIGTERM counts as success for systemd (SuccessExitStatus=). Without the
        # dispatcher's marker it may be the job killing itself, so it is not an outside stop
        # (verifier finding 3); the runtime alone says interrupted, when the runner was down.
        self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='killed', EXIT_STATUS='TERM'),
                            'failed', 'stopped_by_signal')


class CancelTests(RecordResultTestCase):
    """AC-P4-20: a stop requested through the dispatcher ends `cancelled`."""

    def test_cancel_marker_makes_cancelled(self):
        self.mark_cancel('cancelled')
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='killed', EXIT_STATUS='TERM'),
                                       'cancelled', 'cancelled')
        self.assertEqual(document['cancel_reason'], 'cancelled')

    def test_stale_lease_is_cancelled_with_reason(self):
        self.mark_cancel('stale_lease')
        self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='killed', EXIT_STATUS='TERM'),
                            'cancelled', 'stale_lease')

    def test_budget_marker_makes_budget_exceeded(self):
        self.mark_cancel('budget_exceeded')
        self.assertRecorded(self.run_record(SERVICE_RESULT='exit-code', EXIT_CODE='exited', EXIT_STATUS='143'),
                            'budget_exceeded', 'budget_exceeded')

    def test_marker_wins_over_a_stop_timeout(self):
        # A job that ignores SIGTERM is killed after TimeoutStopSec=, reported as "timeout".
        self.mark_cancel('cancelled')
        self.assertRecorded(self.run_record(SERVICE_RESULT='timeout', EXIT_CODE='killed', EXIT_STATUS='KILL'),
                            'cancelled', 'cancelled')

    def test_unknown_marker_reason_is_still_a_cancel(self):
        self.mark_cancel('$(reboot)')
        self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='killed', EXIT_STATUS='TERM'),
                            'cancelled', 'cancelled')

    def test_marker_not_owned_or_writable_by_others_is_ignored(self):
        path = self.mark_cancel('cancelled')
        os.chmod(path, 0o666)
        self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0'),
                            'succeeded', None)

    def test_symlinked_marker_is_ignored(self):
        target = os.path.join(self.tmp, 'elsewhere.json')
        with open(target, 'w') as handle:
            json.dump({'reason': 'cancelled'}, handle)
        os.symlink(target, os.path.join(self.job_dir, 'cancel.json'))
        self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0'),
                            'succeeded', None)


class OutputTests(RecordResultTestCase):
    def test_status_file_mode_and_atomic_write(self):
        self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        path = os.path.join(self.job_dir, 'status.json')
        info = os.lstat(path)
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o640)
        self.assertEqual(info.st_uid, os.geteuid())
        self.assertEqual(info.st_gid, pwd.getpwnam(USER).pw_gid)
        self.assertEqual([name for name in os.listdir(self.job_dir) if name.startswith('.')], [])

    def test_rewrites_existing_status(self):
        self.run_record(SERVICE_RESULT='exit-code', EXIT_CODE='exited', EXIT_STATUS='1')
        self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(self.status()['status'], 'succeeded')

    def test_removes_the_dispatch_dropin(self):
        self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertFalse(os.path.exists(self.unit_dropin))

    def test_keeps_other_dropins(self):
        other = os.path.join(self.unit_dropin, '10-operator.conf')
        with open(other, 'w') as handle:
            handle.write('[Service]\n')
        self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertTrue(os.path.exists(other))
        self.assertFalse(os.path.exists(os.path.join(self.unit_dropin, '50-dispatch.conf')))

    def test_creates_the_job_folder_when_missing(self):
        shutil.rmtree(self.job_dir)
        self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(stat.S_IMODE(os.lstat(self.job_dir).st_mode), 0o751)
        self.assertEqual(self.status()['status'], 'succeeded')

    def test_garbage_variables_are_reduced(self):
        # Only values the executor accepts are written (executor-systemd.mjs readStatusFile).
        document = self.assertRecorded(
            self.run_record(SERVICE_RESULT='success\n; rm -rf /', EXIT_CODE='exited', EXIT_STATUS='0 && id',
                            INVOCATION_ID='not-an-id'),
            'failed', 'unknown_service_result')
        self.assertEqual(document['service_result'], 'resources')
        self.assertIsNone(document['exit_status'])
        self.assertIsNone(document['invocation_id'])
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='signal', EXIT_CODE='weird', EXIT_STATUS='TERM'),
                                       'failed', 'signal')
        self.assertIsNone(document['exit_code'])
        self.assertIsNone(document['exit_status'])
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='exit-code', EXIT_CODE='exited', EXIT_STATUS='999'),
                                       'failed', 'exit_status')
        self.assertIsNone(document['exit_status'])
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='signal', EXIT_CODE='killed', EXIT_STATUS='sigterm'),
                                       'failed', 'signal')
        self.assertIsNone(document['exit_status'])

    def test_missing_service_result(self):
        document = self.assertRecorded(self.run_record(SERVICE_RESULT=None), 'failed', 'unknown_service_result')
        self.assertEqual(document['service_result'], 'resources')

    def test_job_id_comes_from_the_dispatch_record(self):
        path = os.path.join(self.job_dir, 'dispatch.json')
        with open(path, 'w') as handle:
            json.dump({'version': 1, 'id': JOB, 'job_id': JOB_ID, 'outcome': 'started'}, handle)
        os.chmod(path, 0o640)
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0'),
                                       'succeeded', None)
        self.assertEqual(document['job_id'], JOB_ID)

    def test_job_id_absent_without_a_dispatch_record(self):
        document = self.assertRecorded(self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0'),
                                       'succeeded', None)
        self.assertIsNone(document['job_id'])


class RefusalTests(RecordResultTestCase):
    def test_invalid_job_id(self):
        for job_id in ('short', '../../etc', f'{JOB}/..', JOB_ID, 'J' + JOB[1:], 'a' * 65, '-abcdefgh'):
            with self.subTest(job_id=job_id):
                result = self.run_record(job_id=job_id, SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
                self.assertNotEqual(result.returncode, 0)
                if not job_id.startswith('-'):
                    self.assertIn('reason=invalid_id', result.stderr)
                self.assertFalse(os.path.exists(os.path.join(self.job_dir, 'status.json')))

    def test_symlinked_job_folder_is_refused(self):
        shutil.rmtree(self.job_dir)
        elsewhere = os.path.join(self.tmp, 'elsewhere')
        os.mkdir(elsewhere)
        os.symlink(elsewhere, self.job_dir)
        result = self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('reason=job_dir_untrusted', result.stderr)
        self.assertEqual(os.listdir(elsewhere), [])

    def test_group_writable_jobs_folder_is_refused(self):
        os.chmod(self.jobs, 0o775)
        result = self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('reason=jobs_untrusted', result.stderr)

    def test_untrusted_config_is_refused(self):
        os.chmod(self.config, 0o666)
        result = self.run_record(SERVICE_RESULT='success', EXIT_CODE='exited', EXIT_STATUS='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('reason=config_untrusted', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.job_dir, 'status.json')))


if __name__ == '__main__':
    unittest.main()
