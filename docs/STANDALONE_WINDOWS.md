# Memo Bridge Standalone — personal local MCP (W1)

**Status:** a standalone, read-only local MCP prototype in PR for #72. Not a Windows remote-control agent or a public ChatGPT app. Physical Windows verification and packaging are still required before calling it production-ready.

## What it does and does not do

This entry point is **separate** from the owner's Memo Labs MCP and deliberately imports no coordinator, root operator, GitHub App, OAuth service, hub, SSH connection, state database or test runner. It exposes exactly five read-only tools:

- `bridge_info`: local-only contract; no remote endpoints.
- `host_capabilities`: local OS, CPU count, architecture and RAM (not usernames/hostname).
- `gpu_inventory`: discovers GPUs, without assuming NVIDIA (CIM on Windows, optional fallbacks).
- `projects_list`: names of **explicitly configured** projects only.
- `project_inspect`: availability and Git marker for one configured project, without showing its path or file contents.

It does **not** run commands supplied by a model, read arbitrary files, execute GPU code, manage repositories, write code, install background services, publish ports or contact a Memo Labs server. No automated online onboarding, secrets or user accounts.

## Local installation on Windows (no administrator required)

Prerequisites: Node.js >= 22.16, Git to clone the repo and pnpm as pinned in `package.json`. In PowerShell:

```powershell
git clone https://github.com/memolabs-dev/memo-bridge.git
cd memo-bridge
corepack enable
pnpm install --frozen-lockfile
pnpm run build:standalone
pnpm run install:standalone
```

This creates:
- **Local MCP executable:** `%LOCALAPPDATA%\MemoBridge\standalone\index.mjs`
- **Private user config:** `%APPDATA%\MemoBridge\config.json`

No system services, drivers, Windows startup tasks, firewall rules, login or server account are installed. The installer will not overwrite an existing config; it refuses symlink targets. Node.js must remain installed for the MCP client's `node` command to work. To upgrade, build/install again from a trusted checkout; automatic updates are **not** provided.

On Linux, the equivalents are `$XDG_DATA_HOME/memo-bridge/standalone/index.mjs` (default `~/.local/share`) and `$XDG_CONFIG_HOME/memo-bridge/config.json` (default `~/.config`). macOS currently follows the same XDG-style paths.

The installer starts with **zero permitted projects**. Edit `config.json` yourself and add only directories you want the local AI client to know exist:

```json
{
  "schema_version": 1,
  "projects": [
    { "name": "videoAI", "path": "C:\\Users\\Friend\\projects\\videoAI" }
  ]
}
```

The paths must be absolute. This is not an automatic scan of `C:\\`, your home folder or the owner's Memo Labs workspace. An invalid config causes startup to **fail closed**. The process reads its config on startup: restart your MCP client after changes. Projects are referenced by name; the tool responses do not include their full paths.

## Connect to a local stdio MCP client

Configure a client that supports **local MCP stdio** with the installed executable. The following is **generic MCP client configuration**; the exact file/settings depend on the client:

```json
{
  "mcpServers": {
    "memo-bridge-local": {
      "command": "node",
      "args": ["C:\\Users\\Friend\\AppData\\Local\\MemoBridge\\standalone\\index.mjs"]
    }
  }
}
```

Alternatively, in a local checkout point to `standalone/index.mjs` directly. The server communicates over stdin/stdout (JSON-RPC); launching it in a console will appear to wait for a client, which is expected. The helper `pnpm run smoke:standalone` tests the **built** executable using a real MCP client and a temporary isolated user config.

A separate [personal remote OAuth resource-server prototype](PERSONAL_REMOTE_MCP.md)\nexists for later self-hosting. Its loopback listener is **not** by itself a public ChatGPT endpoint.\n\n**Important:** local MCP stdio is **not** a ChatGPT cloud connector. Linking an independent Windows PC to ChatGPT remotely requires a separate authenticated HTTPS service, device enrollment, revocation and a security review (#74). Do **not** use `bridge.memolabs.dev`, the owner's Pocket ID account, SSH credentials or Github Apps. An owner-controlled MCP client on the local PC runs with that OS user's permissions: don't enable this server for untrusted apps.

## GPU

The GPU inventory tool detects names and driver versions, as available, for NVIDIA, AMD, Intel or unknown manufacturers. The underlying read-only Windows CIM query is not proof of GPU compute support. VRAM is intentionally unknown when the source cannot provide a trustworthy measure. NVIDIA-specific `nvidia-smi` is only an optional fallback. **CUDA, DirectML, Vulkan, ROCm and GPU workloads are not installed or enabled by W1.** They belong to later capability-driven, explicitly authorized runner work (#73).

## Validation and known limitations

```powershell
pnpm test
pnpm run build:standalone
pnpm run smoke:standalone
```

Tests use fake GPU responses; Linux CI can check the Windows path policy, project allowlist and stdio MCP contract. Real Windows 10/11 end-to-end testing, hardware diversity, Windows application lifecycle and signed distribution are still required. No production deployment or changes to the existing Mac/VPS control plane are made in #72.
