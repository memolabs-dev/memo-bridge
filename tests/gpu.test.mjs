import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPU_QUERY_ARGS, GPU_PROBE_TIMEOUT_MS, gpuExecutablesForPlatform,
  parseNvidiaGpuCsv, probeNvidiaGpus, runGpuQuery
} from '../server/runners/gpu.mjs';

const gpuSample = 'NVIDIA GeForce RTX 4090, 24564, 570.86.16\n';
const scripted = (answers = {}) => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return answers[command] ?? { missing: true };
  };
  return { run, calls };
};

test('GPU command candidates are fixed for native Windows and WSL/Linux', () => {
  assert.deepEqual(gpuExecutablesForPlatform('win32'), [
    'nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
  ]);
  assert.deepEqual(gpuExecutablesForPlatform('linux'), ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']);
});

test('Windows detects GPU from nvidia-smi.exe with an allowlisted read-only argv', async () => {
  const { run, calls } = scripted({ 'nvidia-smi.exe': { code: 0, stdout: gpuSample } });
  const report = await probeNvidiaGpus({ os: 'win32', run });
  assert.deepEqual(report, {
    source: 'observed', provider: 'nvidia', status: 'available', available: true,
    gpus: [{ name: 'NVIDIA GeForce RTX 4090', memory_total_mib: 24564, driver_version: '570.86.16' }]
  });
  assert.deepEqual(calls, [{
    command: 'nvidia-smi.exe', args: [...GPU_QUERY_ARGS], options: { timeoutMs: GPU_PROBE_TIMEOUT_MS }
  }]);
  assert.ok(!JSON.stringify(report).includes('C:\\'), 'never reveals executable paths');
});

test('Windows falls back to its conventional absolute binary only when PATH lookup misses', async () => {
  const binary = gpuExecutablesForPlatform('win32')[1];
  const { run, calls } = scripted({ [binary]: { code: 0, stdout: gpuSample } });
  assert.equal((await probeNvidiaGpus({ os: 'win32', run })).available, true);
  assert.deepEqual(calls.map(c => c.command), ['nvidia-smi.exe', binary]);
});

test('WSL2 falls back to /usr/lib/wsl/lib/nvidia-smi and preserves multiple GPUs', async () => {
  const { run, calls } = scripted({
    '/usr/lib/wsl/lib/nvidia-smi': { code: 0, stdout: 'NVIDIA GPU A, 8192, 560.10\nNVIDIA GPU B, 16384, 560.10\n' }
  });
  const r = await probeNvidiaGpus({ os: 'linux', run });
  assert.equal(r.status, 'available');
  assert.equal(r.gpus.length, 2);
  assert.equal(r.gpus[1].memory_total_mib, 16384);
  assert.deepEqual(calls.map(c => c.command), ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi']);
});

test('missing drivers, command failures, timeouts and truncated outputs are explicit statuses', async () => {
  const cases = [
    [{ missing: true }, 'not_installed', false],
    [{ code: 1, stdout: 'NVIDIA-SMI has failed' }, 'unusable', false],
    [{ timedOut: true }, 'timeout', null],
    [{ truncated: true }, 'malformed', false],
    [{ code: 0, stdout: '' }, 'malformed', false],
    [{ code: 0, stdout: 'not a gpu, VRAM: secret' }, 'malformed', false]
  ];
  for (const [reply, status, available] of cases) {
    const { run } = scripted({ 'nvidia-smi.exe': reply });
    const r = await probeNvidiaGpus({ os: 'win32', run });
    assert.deepEqual([r.status, r.available, r.gpus.length], [status, available, 0]);
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
});

test('a runner exception returns an unavailable result without leaking error text', async () => {
  const r = await probeNvidiaGpus({ os: 'linux', run: () => { throw Error('token=secret'); } });
  assert.deepEqual([r.status, r.available], ['unusable', false]);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('CSV parser supports quoted model names containing commas and strips control/bidi', () => {
  const r = parseNvidiaGpuCsv('"RTX, sample\u202e", 12345, 555.12\n');
  assert.equal(r[0].name, 'RTX, sample');
  assert.equal(r[0].memory_total_mib, 12345);
  assert.equal(parseNvidiaGpuCsv('"GPU", -1, 555.12'), null);
  assert.equal(parseNvidiaGpuCsv('GPU, 0, 555.12'), null);
  assert.equal(parseNvidiaGpuCsv('GPU, 8192, private-token'), null);
  assert.equal(parseNvidiaGpuCsv('GPU, 8192, 555.12\n'.repeat(17)), null);
  assert.equal(parseNvidiaGpuCsv('x'.repeat(8193)), null);
});

test('missing executable is handled by the real no-shell runner', async () => {
  const r = await runGpuQuery('memo-bridge-no-such-gpu-command-94314', GPU_QUERY_ARGS);
  assert.deepEqual(r, { missing: true });
});
