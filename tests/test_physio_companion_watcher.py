from pathlib import Path

from lecture_processor.physio_companion.watcher import VaultWatcher


def test_watcher_refreshes_only_after_markdown_signature_changes(tmp_path):
    calls = []
    watcher = VaultWatcher(tmp_path, lambda: calls.append("refresh"), interval_seconds=1)

    assert watcher.check_once() is False
    (tmp_path / "note.md").write_text("# Eén", encoding="utf-8")
    assert watcher.check_once() is True
    assert watcher.check_once() is False
    (tmp_path / "note.md").write_text("# Twee — langer", encoding="utf-8")
    assert watcher.check_once() is True
    assert calls == ["refresh", "refresh"]


def test_watcher_ignores_hidden_obsidian_files(tmp_path):
    hidden = tmp_path / ".obsidian"
    hidden.mkdir()
    watcher = VaultWatcher(tmp_path, lambda: None)
    (hidden / "internal.md").write_text("hidden", encoding="utf-8")

    assert watcher.check_once() is False
