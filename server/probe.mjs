import { spawn } from 'node:child_process';

// Only static read-only probes; never accept an LLM-provided shell command.
const PYTHON_PROBE = String.raw`import json, platform, os, shutil, subprocess
disk = shutil.disk_usage("/")
result = {
  "hostname": platform.node(),
  "system": platform.system(),
  "release": platform.release(),
  "architecture": platform.machine(),
  "cpu_count": os.cpu_count(),
  "load_average": [round(v, 2) for v in os.getloadavg()] if hasattr(os, "getloadavg") else None,
  "disk_total_gib": round(disk.total / (1024**3), 1),
  "disk_free_gib": round(disk.free / (1024**3), 1)
}
if platform.system() == "Linux":
  try:
    completed = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True, timeout=4)
    result["docker_running_containers"] = len(completed.stdout.splitlines()) if completed.returncode == 0 else None
  except (OSError, subprocess.TimeoutExpired):
    result["docker_running_containers"] = None
print(json.dumps(result))
`;

export const HOST_IDS = ['mac', 'vps'];

export function validateHost(host) {
  if (!HOST_IDS.includes(host)) throw new Error('Unknown host: permitted hosts are mac or vps');
  return host;
}

// Spawn without a shell. The remote program is a constant: python3 - on the SSH alias lab.
export async function collectHost(host, opts = {}) {
  validateHost(host);
  const timeoutMs = opts.timeoutMs ?? 9000;
  const program = host === 'mac' ? 'python3' : 'ssh';
  const args = host === 'mac'
    ? ['-']
    : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', 'lab', 'python3 -'];
  return await new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(0, 12000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 1000); });
    child.once('error', (err) => { clearTimeout(t); resolve({ host, online: false, error: err.code || 'spawn_failed' }); });
    child.once('close', (code) => {
      clearTimeout(t);
      if (timedOut || code !== 0) {
        resolve({ host, online: false, error: timedOut ? 'timeout' : 'unavailable', detail: stderr.trim().slice(0, 250) });
        return;
      }
      try {
        resolve({ host, online: true, ...JSON.parse(output.trim()) });
      } catch {
        resolve({ host, online: false, error: 'invalid_probe_response' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(PYTHON_PROBE);
  });
}

export async function listHosts() {
  const statuses = await Promise.all(HOST_IDS.map((host) => collectHost(host)));
  return statuses.map(({ host, online, hostname, error }) => ({ host, online, hostname: hostname ?? null, ...(error && { error }) }));
}
