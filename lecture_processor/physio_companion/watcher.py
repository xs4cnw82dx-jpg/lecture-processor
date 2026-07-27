"""Dependency-free polling watcher for incremental vault index refreshes."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable


class VaultWatcher:
    def __init__(self, vault_path: Path, refresh: Callable[[], object], *, interval_seconds: float = 1.0):
        self.vault_path = Path(vault_path)
        self.refresh = refresh
        self.interval_seconds = max(0.25, float(interval_seconds))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._signature = self.snapshot()

    def snapshot(self) -> tuple[tuple[str, int, int], ...]:
        rows = []
        if self.vault_path.is_dir():
            for path in self.vault_path.rglob("*.md"):
                if not path.is_file() or path.is_symlink():
                    continue
                relative = path.relative_to(self.vault_path)
                if any(part.startswith(".") for part in relative.parts):
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                rows.append((relative.as_posix(), stat.st_mtime_ns, stat.st_size))
        return tuple(sorted(rows))

    def check_once(self) -> bool:
        current = self.snapshot()
        if current == self._signature:
            return False
        self.refresh()
        self._signature = current
        return True

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self.check_once()
            except Exception:
                # A transient partial write is retried on the next filesystem signature.
                continue

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="physio-vault-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=min(2.0, self.interval_seconds + 0.5))
