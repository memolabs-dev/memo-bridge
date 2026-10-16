// Vendor-neutral read-only GPU discovery. No GPU vendor or compute backend is assumed.
// Windows uses a fixed CIM hardware query; NVIDIA SMI is an optional fallback only.
// This is local diagnostics, NOT GPU execution or an MCP authorization mechanism.
import { GPU_PROBE_MAX_BUFFER, GPU_PROBE_MAX_DEVICES, probeNvidiaGpus, runGpuQuery } from './gpu.mjs';

export const WINDOWS_GPU_CIM_SCRIPT =
  "$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_VideoController | " +
  "Select-Object -Property Name,AdapterCompatibility,DriverVersion | ConvertTo-Json -Compress -Depth 3";
export const WINDOWS_GPU_CIM_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU_CIM_SCRIPT
]);
export const GPU_INVENTORY_TIMEOUT_MS = 4000;

const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function safeText(v, max = 96) {
  if (typeof v !== 'string') return null;
  return v.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

export function identifyGpuVendor(...values) {
  const text = values.filter(v => typeof v === 'string').join(' ').toLowerCase();
  if (/\bnvidia\b/.test(text)) return 'nvidia';
  if (/\b(amd|ati|advanced micro devices)\b/.test(text)) return 'amd';
  if (/\bintel\b/.test(text)) return 'intel';
  return 'unknown';
}

function isSoftwareDisplay(name, manufacturer) {
  const haystack = [name, manufacturer].filter(Boolean).join(' ').toLowerCase();
  return /microsoft (basic|remote) display|remote desktop|virtual display|render-only|indirect display|citrix|vmware svga|virtualbox graphics/.test(haystack);
}

/** Parse only three allowlisted CIM fields, and never trust AdapterRAM (a legacy
 * UInt32 often wrapping/truncating VRAM above 4 GiB). */
export function parseWindowsGpuJson(input) {
  if (typeof input !== 'string' || input.length > GPU_PROBE_MAX_BUFFER) return null;
  let raw;
  try { raw = JSON.parse(input); } catch { return null; }
  const rows = Array.isArray(raw) ? raw : [raw];
  if (rows.length > GPU_PROBE_MAX_DEVICES || rows.some(r => !r || Array.isArray(r) || typeof r !== 'object')) return null;
  const gpus = [];
  for (const row of rows) {
    const name = safeText(row.Name);
    const manufacturer = safeText(row.AdapterCompatibility);
    if (!name || isSoftwareDisplay(name, manufacturer)) continue;
    gpus.push({
      name,
      vendor: identifyGpuVendor(manufacturer, name),
      driver_version: safeText(row.DriverVersion, 48),
      memory_total_mib: null // do not misrepresent WMI AdapterRAM as actual VRAM
    });
  }
  return gpus;
}

function unknown(reason) {
  return { source: 'observed', status: 'unknown', reason, gpus: [] };
}

function inventoryFromNvidia(nv) {
  if (nv.status !== 'available') return unknown(nv.status === 'timeout' ? 'probe_timeout' : 'probe_unavailable');
  return {
    source: 'observed', status: 'detected', method: 'nvidia-smi',
    gpus: nv.gpus.map(gpu => ({ ...gpu, vendor: 'nvidia' }))
  };
}

/**
 * run(command, CONSTANT_ARGS, { timeoutMs }) is injectable for fake Windows CI tests.
 * os controls platform: win32 => CIM first; WSL2 => attempt Windows interop first;
 * other Linux => optional NVIDIA CLI probe (unknown when this tool is missing).
 */
export async function probeGpus({ os = process.platform, env = process.env, run = runGpuQuery } = {}) {
  const canQueryWindows = os === 'win32' || (os === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
  let failure = null;
  if (canQueryWindows) {
    let r;
    try { r = await run('powershell.exe', WINDOWS_GPU_CIM_ARGS, { timeoutMs: GPU_INVENTORY_TIMEOUT_MS }); }
    catch { r = { code: 1 }; }
    if (r?.code === 0 && typeof r.stdout === 'string') {
      const gpus = parseWindowsGpuJson(r.stdout);
      if (gpus && gpus.length > 0) return { source: 'observed', status: 'detected', method: 'windows-cim', gpus };
      failure = gpus === null ? 'malformed_inventory' : 'no_hardware_adapter_reported';
    } else {
      failure = r?.timedOut ? 'probe_timeout' : 'windows_inventory_unavailable';
    }
  }

  const nv = await probeNvidiaGpus({ os, run });
  if (nv.status === 'available') return inventoryFromNvidia(nv);
  // Absence of nvidia-smi says nothing about AMD, Intel or an iGPU.
  return unknown(failure ?? (nv.status === 'timeout' ? 'probe_timeout' : 'inventory_unavailable'));
}
