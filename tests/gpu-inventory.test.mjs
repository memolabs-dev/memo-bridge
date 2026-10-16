import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS_GPU_CIM_ARGS, GPU_INVENTORY_TIMEOUT_MS, identifyGpuVendor,
  parseWindowsGpuJson, probeGpus
} from '../server/runners/gpu-inventory.mjs';
import { GPU_QUERY_ARGS } from '../server/runners/gpu.mjs';

const cim = adapters => JSON.stringify(adapters);
function fakeRunner(answers = {}) {
  const calls = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args: [...args], options: { ...options } });
      return answers[command] ?? { missing: true };
    }
  };
}

test('Windows probes hardware via fixed read-only PowerShell CIM query, no vendor prerequisite', async () => {
  const adapter = { Name: 'Intel(R) UHD Graphics', AdapterCompatibility: 'Intel Corporation',
    DriverVersion: '31.0.101.1234', AdapterRAM: 0 };
  const { run, calls } = fakeRunner({ 'powershell.exe': { code: 0, stdout: cim(adapter) } });
  const r = await probeGpus({ os: 'win32', run });
  assert.deepEqual(r, { source: 'observed', status: 'detected', method: 'windows-cim', gpus: [
    { name: 'Intel(R) UHD Graphics', vendor: 'intel', driver_version: '31.0.101.1234', memory_total_mib: null }
  ] });
  assert.deepEqual(calls, [{ command: 'powershell.exe', args: [...WINDOWS_GPU_CIM_ARGS],
    options: { timeoutMs: GPU_INVENTORY_TIMEOUT_MS } }]);
  assert.ok(!WINDOWS_GPU_CIM_ARGS.join(' ').includes('AdapterRAM'));
});

test('AMD GPU is detected without nvidia-smi or CUDA', async () => {
  const { run, calls } = fakeRunner({ 'powershell.exe': { code: 0, stdout: cim([
    { Name: 'AMD Radeon RX 7900 XTX', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '32.1' }
  ]) } });
  const r = await probeGpus({ os: 'win32', run });
  assert.equal(r.gpus[0].vendor, 'amd');
  assert.equal(r.gpus[0].memory_total_mib, null);
  assert.deepEqual(calls.map(c => c.command), ['powershell.exe']);
});

test('multiple different adapters retain their own vendor classification, including unknown vendors', async () => {
  const rows = [
    { Name: 'NVIDIA GeForce RTX', AdapterCompatibility: 'NVIDIA', DriverVersion: '570.12' },
    { Name: 'Intel Arc', AdapterCompatibility: 'Intel Corporation', DriverVersion: '31.1' },
    { Name: 'Unknown GPU 123', AdapterCompatibility: 'NewCorp', DriverVersion: '99.1' }
  ];
  const r = await probeGpus({ os: 'win32', run: fakeRunner({ 'powershell.exe': {
    code: 0, stdout: cim(rows) } }).run });
  assert.deepEqual(r.gpus.map(g => g.vendor), ['nvidia', 'intel', 'unknown']);
  assert.deepEqual([identifyGpuVendor('ATI Technologies'), identifyGpuVendor('AMD'), identifyGpuVendor('NVIDIA')], ['amd', 'amd', 'nvidia']);
});

test('software and remote display adapters are not claimed as physical GPUs', async () => {
  const r = await probeGpus({ os: 'win32', run: fakeRunner({ 'powershell.exe': { code: 0, stdout: cim([
    { Name: 'Microsoft Remote Display Adapter', AdapterCompatibility: 'Microsoft' },
    { Name: 'Microsoft Basic Display Adapter', AdapterCompatibility: 'Microsoft' }
  ]) } }).run });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'no_hardware_adapter_reported');
  assert.deepEqual(r.gpus, []);
});

test('missing Windows CIM and NVIDIA CLI yields unknown hardware, not no GPU', async () => {
  const { run, calls } = fakeRunner();
  const r = await probeGpus({ os: 'win32', run });
  assert.deepEqual(r, { source: 'observed', status: 'unknown',
    reason: 'windows_inventory_unavailable', gpus: [] });
  assert.ok(calls.some(c => c.command === 'powershell.exe'));
  assert.ok(calls.some(c => c.command === 'nvidia-smi.exe'));
});

test('when Windows inventory cannot run, NVIDIA may still be detected as an optional fallback', async () => {
  const { run } = fakeRunner({ 'nvidia-smi.exe': { code: 0, stdout: 'NVIDIA RTX, 16000, 570.12\n' } });
  const r = await probeGpus({ os: 'win32', run });
  assert.equal(r.method, 'nvidia-smi');
  assert.equal(r.gpus[0].vendor, 'nvidia');
  assert.equal(r.gpus[0].memory_total_mib, 16000);
});

test('WSL2 tries the host Windows inventory before an optional NVIDIA fallback', async () => {
  const script = fakeRunner({ 'powershell.exe': { code: 0, stdout: cim({
    Name: 'AMD Radeon 780M', AdapterCompatibility: 'AMD', DriverVersion: '33.0'
  }) } });
  const r = await probeGpus({ os: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run: script.run });
  assert.equal(r.method, 'windows-cim');
  assert.equal(r.gpus[0].vendor, 'amd');
  assert.deepEqual(script.calls.map(c => c.command), ['powershell.exe']);
});

test('WSL2 lacking Windows interop and nvidia-smi is unknown, not NVIDIA-only', async () => {
  const script = fakeRunner();
  const r = await probeGpus({ os: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run: script.run });
  assert.equal(r.status, 'unknown');
  assert.ok(script.calls.some(c => c.command === '/usr/lib/wsl/lib/nvidia-smi'));
});

test('a Linux host with available nvidia-smi is still supported', async () => {
  const script = fakeRunner({ 'nvidia-smi': { code: 0, stdout: 'NVIDIA 4080, 16000, 570.12\n' } });
  const r = await probeGpus({ os: 'linux', env: {}, run: script.run });
  assert.equal(r.gpus[0].vendor, 'nvidia');
  assert.deepEqual(script.calls[0].args, [...GPU_QUERY_ARGS]);
});

test('malformed CIM output or an exception never leaks private data or invents VRAM', async () => {
  for (const reply of [
    { code: 0, stdout: '{broken private_password' },
    { code: 0, stdout: 'a'.repeat(8193) },
    { truncated: true },
    { timedOut: true }
  ]) {
    const r = await probeGpus({ os: 'win32',
      run: fakeRunner({ 'powershell.exe': reply }).run });
    assert.equal(r.status, 'unknown');
    assert.equal(r.gpus.length, 0);
    assert.ok(!JSON.stringify(r).includes('private_password'));
  }
  const r = await probeGpus({ os: 'win32', run: () => { throw Error('secret bearer=token'); } });
  assert.equal(r.status, 'unknown');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(parseWindowsGpuJson('[null]'), null);
});

test('Windows parser bounds, sanitizes and rejects malformed inventory', () => {
  assert.equal(parseWindowsGpuJson('[]').length, 0);
  assert.equal(parseWindowsGpuJson('{broken'), null);
  assert.equal(parseWindowsGpuJson(cim(new Array(17).fill({ Name: 'GPU' }))), null);
  assert.equal(parseWindowsGpuJson('x'.repeat(8193)), null);
  const r = parseWindowsGpuJson(cim({ Name: 'GPU\u202e device\u0007', AdapterCompatibility: 'Intel',
    DriverVersion: '31.0', AdapterRAM: 4294967295, SerializedSecret: 'do-not-emit' }));
  assert.equal(r[0].name, 'GPU device');
  assert.equal(r[0].memory_total_mib, null);
  assert.ok(!JSON.stringify(r).includes('do-not-emit'));
});
