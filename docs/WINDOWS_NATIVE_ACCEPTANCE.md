# Windows native acceptance (#90)

**Status:** proposed, NOT yet Windows-verified and NOT an active workflow. The existing
`.github/workflows/ci.yml` runs only `ubuntu-latest` (Node 22/24). Linux path simulations,
Linux builds and mocked GPU probes are **not proof** of a working Windows install.

## Windows evidence command

On a trusted native Windows 10/11 desktop or Windows-hosted GitHub Actions runner, with
Node.js 24+, pnpm 12 and dependencies installed, run:

```powershell
pnpm install --frozen-lockfile
pnpm run build:standalone
pnpm run build:personal-remote
pnpm run smoke:windows
```

The smoke command **refuses other operating systems with exit 2**. It checks that both
bundles were built and executes the following on the real Windows OS:

- Installs the compiled standalone MCP into isolated temporary Windows-profile directories;
  the installed executable is the one exercised through a genuine stdio MCP client.
- Confirms a per-user configuration begins with **zero projects**, survives a second install,
  and reveals only an explicitly allowed temporary project.
- Verifies the five read-only tools and refusal of host control, shell, file-writing,
  worktree, GitHub and job-execution tools.
- Queries actual Windows local host capabilities and **vendor-neutral** GPU inventory.
  A probe returning `unknown` is not proof of an absent GPU; the test deliberately does
  not demand NVIDIA or any vendor.
- Runs OAuth single-owner adversarial tests and the personal **loopback** MCP HTTP tests.
  This is local HTTPS-edge simulation; it is not a live ChatGPT / public HTTPS test.
- Leaves the owner's projects, credentials, GitHub Apps, VPS and Windows user profile
  untouched. All smoke installation files are created under a temporary directory.

A successful result emits a JSON marker `{"ok":true,"platform":"win32", ...}`. This
marker must appear in a **Windows-hosted** workflow log before #90 can be signed off.
No proprietary GPU driver, VRAM number, GPU execution or default machine enrollment
is assumed or installed.

## GitHub Actions protected path

The workflow template is at
[`docs/proposed-github-workflows/standalone-windows.yml`](proposed-github-workflows/standalone-windows.yml).
It is **not executed** from this location. The Memo Bridge worktree API returns
`path_protected` for `.github/workflows`: this is intentional and must not be bypassed.
The approved workflow maintainer must review the template, copy it to
`.github/workflows/standalone-windows.yml` in a separately authorized change, and run
the resulting workflow on GitHub Actions `windows-latest`.

Then attach a verifiable green run URL and Windows evidence marker to
[#90](https://github.com/memolabs-dev/memo-bridge/issues/90). Until that happens,
mark this task as **pending Windows evidence**, not completed.

## What remains out of scope

This is not machine enrollment and not a plug-and-play ChatGPT desktop plugin.
A separately owned OIDC issuer, outbound HTTPS tunnel, device revocation and real
ChatGPT end-to-end proof remain [#91](https://github.com/memolabs-dev/memo-bridge/issues/91).
A sandboxed GPU execution backend belongs to #73 and must be chosen **after**
capability detection; the friend's GPU model/vendor is still unknown.
