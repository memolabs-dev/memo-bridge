// Read-only, cross-platform NVIDIA GPU inventory for a future independent local agent.
// This module does NOT execute workloads, enroll hosts, or use Memo Labs credentials.
// argv, binary candidates, timeouts and maximum output are constants; never run a shell.
import { execFile } from 'node:child_process';

export const GPU_QUERY_ARGS = Object.freeze([
  '--query-gpu=name,memory.total,driver_version',
  '--format=csv,noheader,nounits'
]);
export const GPU_PROBE_TIMEOUT_MS = 4000;
export const GPU_PROBE_MAX_BUFFER = 8192;
export const GPU_PROBE_MAX_DEVICES = 16;

export function gpuExecutablesForPlatform(os = process.platform) {
  if (os === 'win32') {
    return ['nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
  }
  // WSL2 commonly provides this fixed path even when it is not on PATH.
  return ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];
}

export function runGpuQuery(command, args = GPU_QUERY_ARGS, { timeoutMs = GPU_PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile(command, args, {
      shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: GPU_PROBE_MAX_BUFFER,
      encoding: 'utf8', killSignal: 'SIGKILL'
    }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout ?? '') });
      if (error.code === 'ENOENT') return resolve({ missing: true });
      if (error.killed || error.code === 'ETIMEDOUT') return resolve({ timedOut: true });
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ truncated: true });
      return resolve({ code: typeof error.code === 'number' ? error.code : 1 });
    });
  });
}

function cleanName(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 96);
}

// The last two CSV fields are numeric and cannot contain commas. Capture from the right,
// so models with embedded commas are preserved without a generic CSV parser.
export function parseNvidiaGpuCsv(input) {
  if (typeof input !== 'string' || input.length > GPU_PROBE_MAX_BUFFER) return null;
  const rows = input.split(/\r?\n/).filter(line => line.trim());
  if (rows.length < 1 || rows.length > GPU_PROBE_MAX_DEVICES) return null;
  const gpus = [];
  for (const line of rows) {
    const match = /^(.+),\s*([0-9]+),\s*([0-9]+(?:\.[0-9]+){1,3})\s*$/.exec(line);
    if (!match) return null;
    const name = cleanName(match[1].trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const memoryTotal = Number(match[2]);
    if (!name || !Number.isSafeInteger(memoryTotal) || memoryTotal < 1 || memoryTotal > 1_000_000) return null;
    gpus.push({ name, memory_total_mib: memoryTotal, driver_version: match[3] });
  }
  return gpus;
}

function unavailable(status) {
  return { source: 'observed', provider: 'nvidia', status, available: status === 'timeout' ? null : false, gpus: [] };
}

/**
 * Read-only local hardware discovery. run(command, fixedArgs, { timeoutMs }) is injectable
 * so tests never execute nvidia-smi or require a physical GPU.
 */
export async function probeNvidiaGpus({ os = process.platform, run = runGpuQuery } = {}) {
  for (const command of gpuExecutablesForPlatform(os)) {
    let result;
    try {
      result = await run(command, GPU_QUERY_ARGS, { timeoutMs: GPU_PROBE_TIMEOUT_MS });
    } catch {
      return unavailable('unusable');
    }
    if (result?.missing) continue;
    if (result?.timedOut) return unavailable('timeout');
    if (result?.truncated) return unavailable('malformed');
    if (result?.code !== 0) return unavailable('unusable');
    const gpus = parseNvidiaGpuCsv(result.stdout);
    if (!gpus) return unavailable('malformed');
    return { source: 'observed', provider: 'nvidia', status: 'available', available: true, gpus };
  }
  return unavailable('not_installed');
}
