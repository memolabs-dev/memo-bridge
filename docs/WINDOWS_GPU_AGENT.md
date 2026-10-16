# Windows GPU discovery and independent Memo Bridge agent (W0)

**Scope:** hardware inventory and an independent, read-only local MCP entry point (W1, #72). This is not a remote desktop controller or GPU job runner. The owner's Memo Labs hub remains owner-only. See [STANDALONE_WINDOWS.md](STANDALONE_WINDOWS.md) for personal Windows installation.

## Principle: detect first, choose a compute backend later

A Windows collaborator's GPU brand/model **is unknown** until their machine is queried. Never assume NVIDIA, AMD, Intel, CUDA, WSL2, dedicated VRAM, or an installed GPU driver. Integrated, dedicated, multiple and virtual adapters are possible.

Hardware inventory is separated from compute support. A detected AMD, Intel or NVIDIA graphics adapter does **not** prove that CUDA, ROCm, DirectML, Vulkan or another compute backend will run; backend support requires its own runtime and workload tests. A machine can also run CPU-only tasks.

## Local read-only inventory

From a local checkout (Node >=22.16, pnpm installed):

```powershell
pnpm install --frozen-lockfile
pnpm run probe:gpu
```

The command performs **local, read-only discovery** and prints a small JSON summary. No owner hub, authentication, GitHub, network enrollment or GPU job is involved.

On native Windows, a fixed PowerShell command queries **Win32_VideoController** through CIM, selecting only `Name`, `AdapterCompatibility` and `DriverVersion`. No variable or argument controlled by a model is interpolated. It can identify adapters from NVIDIA, AMD and Intel, and preserves `unknown` vendors rather than guessing. Software / Remote Desktop display adapters are excluded from the physical GPU list. Example (illustrative, not measured on the collaborator's PC):

```json
{
  "source": "observed",
  "status": "detected",
  "method": "windows-cim",
  "gpus": [
    { "name": "AMD Radeon Graphics", "vendor": "amd", "driver_version": "32.0", "memory_total_mib": null }
  ]
}
```

**Why null VRAM?** `Win32_VideoController.AdapterRAM` is not a reliable measure of installed or usable GPU VRAM (including its 32-bit limit). The Windows CIM probe deliberately does not report it. A separate, vendor-specific backend may eventually provide verified values.

If Windows CIM is inaccessible, `nvidia-smi` can *optionally* identify a compatible NVIDIA GPU and its driver/total VRAM. On Linux/WSL2, detection first tries Windows PowerShell interop when WSL markers are present, then this optional NVIDIA probe. **Missing `nvidia-smi` NEVER means no GPU, and it does not exclude AMD or Intel.** The tool returns `status: "unknown"` when it cannot establish the inventory. Linux systems without WSL interop or NVIDIA tools require an additional platform inventory provider in a subsequent phase.

Commands are bounded in duration and output, subprocesses are invoked with fixed arguments rather than model-provided commands, and outputs are sanitized to omit serial numbers, device paths, process lists and credentials. Only explicit allowlisted GPU fields are returned. PowerShell interprets a fixed query; no user-controlled shell execution is permitted.

## Isolation and installation stages

The currently deployed Memo Bridge knows only `mac` and `vps`, uses Mac sandboxes or Linux systemd, and authenticates the single Memo Labs owner. **It must never enroll a collaborator through `bridge.memolabs.dev`, `auth.memolabs.dev`, the owner's VPS, project catalog, tokens, GitHub credentials, SSH aliases or machine keys.**

- **W0 (this PR + previous #75):** local inventory and unit tests; no Windows agent yet.
- **W1 (#72):** portable local stdio MCP server, per-user Windows/XDG installation and explicit project allowlist (read-only). Remote machine enrollment/revocation requires W3.
- **W2 (#73, corrected by #76):** opt-in GPU recipes based on detected *backend capabilities*, explicit authorization, safe sandbox/least privileges, budgets, cancellation, audit, CPU fallback. Do not run with sandbox disabled.
- **W3 (#74):** owner-isolated remote MCP connections and user-scoped OAuth; multi-tenant publishing only after security review.

Hardware and runtime testing on real Windows/WSL2 configurations is **still required** before promising end-to-end GPU support or Windows installer readiness. No production deployment or user-sharing change is part of this work.
