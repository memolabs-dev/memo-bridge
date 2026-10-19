#!/usr/bin/env python3
"""Preflight a Memo Bridge runtime release against durable coordinator state.

Read-only on the live SQLite database. A consistent backup is taken via SQLite's
backup API (including WAL transactions) before a launchd runtime is switched.
Never lower PRAGMA user_version or modify the live database to fit old code.
"""
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import quote


def check(release_store: Path, database: Path) -> int:
    source = release_store.read_text(encoding="utf-8")
    match = re.search(r"export const SCHEMA_VERSION\s*=\s*(\d+);", source)
    if not match:
        raise ValueError("runtime_release_missing_coordinator_schema")
    release_version = int(match.group(1))
    if not database.exists():
        print(f"coordinator_schema={release_version} database=absent (no migration yet)")
        return 0
    if database.is_symlink() or not database.is_file():
        raise ValueError("coordinator_db_not_regular_file")

    uri = "file:" + quote(str(database), safe="/") + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=10) as live:
        current_version = int(live.execute("PRAGMA user_version").fetchone()[0])
        if current_version > release_version:
            raise ValueError(
                f"state_schema_newer_than_code: database=v{current_version}, "
                f"candidate=v{release_version}; refusing runtime downgrade"
            )
        backup_dir = database.parent / "pre-release-backups"
        if backup_dir.is_symlink():
            raise ValueError("coordinator_backup_dir_symlink")
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        backup_dir.chmod(0o700)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = backup_dir / f"coordinator-{stamp}-{os.getpid()}.sqlite"
        try:
            with sqlite3.connect(str(backup), timeout=10) as target:
                live.backup(target)
                integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise ValueError(f"backup_integrity_failed:{integrity}")
            backup.chmod(0o600)
        except BaseException:
            backup.unlink(missing_ok=True)
            raise
    digest = hashlib.sha256(backup.read_bytes()).hexdigest()
    print(f"coordinator_schema_db={current_version} runtime_schema={release_version} "
          f"backup={backup} sha256={digest}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: guard-coordinator-state.py <release-store.mjs> <coordinator.sqlite>", file=sys.stderr)
        sys.exit(2)
    try:
        sys.exit(check(Path(sys.argv[1]), Path(sys.argv[2])))
    except Exception as exc:
        print(f"runtime_upgrade_blocked: {exc}", file=sys.stderr)
        sys.exit(1)
