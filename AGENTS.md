# Memo Bridge contributor policy

Follow ~/projects/AGENTS.md, PROJECTS.md and docs/STAR.md. Treat host probing as read-only. Never embed credentials or read SSH private keys. Changes go to isolated worktrees if concurrent work exists. Preserve any running Sentinel X services. Do not add arbitrary command execution, credential retrieval or privileged operations without explicit design and review. No deployment without TLS, user authentication, host authorization and a tested rollback.
