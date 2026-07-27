"""Composition root for the local Physio companion."""

from __future__ import annotations

from urllib.parse import quote

from .cases import CaseStore
from .config import CompanionConfig
from .index import KnowledgeIndex
from .jobs import CodexJobManager
from .media import MediaManifest
from .sources import SourceManager
from .watcher import VaultWatcher


class CompanionService:
    def __init__(self, config: CompanionConfig, *, refresh_index: bool = True, popen_factory=None):
        self.config = config
        config.ensure_directories()
        self.index = KnowledgeIndex(config.vault_path, config.index_path)
        self.cases = CaseStore(config.cases_path)
        self.sources = SourceManager(
            config.manifest_path,
            config.sources_path,
            config.vault_path,
            max_source_bytes=config.max_source_bytes,
        )
        self.media = MediaManifest(config.manifest_path)
        job_kwargs = {}
        if popen_factory is not None:
            job_kwargs["popen_factory"] = popen_factory
        self.jobs = CodexJobManager(
            config,
            context_provider=lambda note_ids, max_chars: self.index.reviewed_context(note_ids, max_chars=max_chars),
            source_context_provider=lambda query, region, max_chars: self.sources.deep_context(
                query, region=region, max_chars=max_chars
            ),
            case_provider=self.cases.export_case,
            **job_kwargs,
        )
        self.last_refresh = self.index.refresh() if refresh_index else None
        self.watcher = VaultWatcher(config.vault_path, self.refresh_index)

    def refresh_index(self):
        self.last_refresh = self.index.refresh()
        return self.last_refresh

    def start_watcher(self) -> None:
        self.watcher.start()

    def obsidian_uri(self, note: dict) -> str:
        vault = quote(self.config.vault_path.name, safe="")
        file_path = quote(note["path"].removesuffix(".md"), safe="/")
        return f"obsidian://open?vault={vault}&file={file_path}"

    def close(self) -> None:
        self.watcher.stop()
        self.jobs.shutdown()
