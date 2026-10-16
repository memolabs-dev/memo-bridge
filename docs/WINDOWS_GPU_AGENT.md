# Windows / NVIDIA GPU agent — independent installation (Phase W0)

**Status:** foundation only; Windows remote execution and a public ChatGPT connector are **not implemented**. This work must not enroll another user in the existing Memo Labs deployment.

## Goal and isolation contract

A collaborator should be able to install their own Memo Bridge instance on Windows, inspect their NVIDIA GPU and eventually authorize narrowly scoped work on **their own machine**. They must not receive access to `bridge.memolabs.dev`, `auth.memolabs.dev`, the Memo Labs VPS, the Mac, the owner's projects, GitHub App keys, bearer tokens or SSH credentials.

The existing deployment recognizes only `mac` and `vps` and is single-owner by design. The current local runner uses macOS sandboxing; the remote Linux runner uses systemd. **Neither implementation is a Windows job sandbox.** Renaming a `mac` host to `windows` or connecting a second account to the owner's hub would bypass the intended trust boundary.

## Deliverable W0: read-only GPU inventory

From a local checkout with Node >=22.16 and pnpm installed:

```powershell
pnpm install --frozen-lockfile
pnpm run probe:gpu
```

The command runs locally; it does not contact Memo Labs services, GitHub, ChatGPT or the internet. The JSON result is intentionally small:

```json
{
  "source": "observed",
  "provider": "nvidia",
  "status": "available",
  "available": true,
  "gpus": [
    { "name": "NVIDIA GPU", "memory_total_mib": 8192, "driver_version": "570.86" }
  ]
}
```

The probe uses fixed `nvidia-smi` arguments (`--query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`) and never runs a shell. On native Windows it tries `nvidia-smi.exe` and its conventional NVIDIA install location. On Linux/WSL2 it tries `nvidia-smi` and `/usr/lib/wsl/lib/nvidia-smi`. Missing drivers, disabled GPUs, bad output and timeouts yield a structured unavailable/unknown result. Output lines and lengths are bounded; no serial numbers, PCI addresses, paths, user names, process lists or tokens are returned. Reported VRAM is *total VRAM*, not memory currently allocatable.

This is **hardware discovery, not a CUDA job runner**. It is not yet exposed as an independently enrollable MCP tool. Tests stub command execution so Linux CI runs without an NVIDIA GPU or Windows.

## Next phases (not delivered by W0)

1. **W1 — local Windows agent:** Windows-aware host IDs and project roots, agent service installation, native/WSL2 capability detection, strong per-user config directories, separate GitHub authentication, signed update flow. No inherited owner `lab` SSH alias or fixed Memo Labs project catalog.
2. **W2 — safe GPU jobs:** named recipes (not arbitrary shells), explicit opt-in, working-directory allowlist, sandbox/low privilege under Windows/WSL2, resource budgets (GPU memory, duration, disk/network), cancellation, owner confirmation for expensive runs, audit log. Do not use `MEMO_BRIDGE_JOB_SANDBOX=off` as a workaround.
3. **W3 — personal ChatGPT connection:** each installer owns a distinct remote MCP endpoint or a rigorously tenant-isolated hosted gateway with user-scoped OAuth tokens, per-user project/host ACLs, enrollment + revocation, threat modeling and end-to-end adversarial tests. Publishing an app is a separate review/deployment decision.

## Windows + WSL2 prerequisites

An NVIDIA GPU with a driver supporting CUDA on WSL2 may be used from a WSL2 Linux environment. Check the current NVIDIA WSL guidance for driver/OS/GPU compatibility: https://docs.nvidia.com/cuda/wsl-user-guide/index.html . The native Windows probe also works without WSL2 when `nvidia-smi.exe` is installed. **Do not install a Linux NVIDIA display driver into WSL2 merely to run the probe.**

## Acceptance and non-goals

Run `pnpm test` and `pnpm run build` before merging. Until W1–W3 pass an explicit security review: no Windows execution claims, no GPU reservation, no Windows host in the production coordinator, no second human principal on the owner's hub, and no public one-click ChatGPT plugin.
