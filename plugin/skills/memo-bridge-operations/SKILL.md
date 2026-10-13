---
name: memo-bridge-operations
description: Observe Memo Labs host status through Memo Bridge MCP tools, without modifying hosts or depending on the Sentinel X commercial hub.
---

# Memo Bridge (MVP)

Use `bridge_info` to discover the current capabilities, then `list_hosts` to find which machines respond. Use `host_status` only with the exact IDs `mac` or `vps`.

Do not claim this MVP provides independent always-on VPS access: it runs locally on the Mac and uses the already configured SSH alias `lab` for the VPS. It has no shell-execution or mutation tools.

If the VPS is unreachable, report it as offline; do not change SSH, firewall, routing, services, or credentials. Use a separate approved workflow before any deployment or write-capable action is added.
