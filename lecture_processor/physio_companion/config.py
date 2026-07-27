"""Configuration for the loopback-only Physio companion."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_VAULT_PATH = Path.home() / "Documents" / "Physio Knowledge Vault"
DEFAULT_SUPPORT_PATH = (
    Path.home() / "Library" / "Application Support" / "Lecture Processor" / "Physio"
)


@dataclass(slots=True)
class CompanionConfig:
    """Filesystem and process settings for a companion instance.

    Both roots are intentionally configurable so tests and alternate vaults never
    need to write to the user's default locations.
    """

    vault_path: Path = field(default_factory=lambda: DEFAULT_VAULT_PATH)
    app_support_path: Path = field(default_factory=lambda: DEFAULT_SUPPORT_PATH)
    secret_key: str = field(default_factory=lambda: secrets.token_hex(32))
    owner_token: str = field(default_factory=lambda: secrets.token_urlsafe(48))
    url_prefix: str = "/api/local/physio"
    codex_binary: str = "codex"
    codex_timeout_seconds: float = 90.0
    codex_max_jobs: int = 4
    codex_max_context_chars: int = 60_000
    codex_extra_args: tuple[str, ...] = ()
    max_source_bytes: int = 500 * 1024 * 1024

    def __post_init__(self) -> None:
        self.vault_path = Path(self.vault_path).expanduser().resolve()
        self.app_support_path = Path(self.app_support_path).expanduser().resolve()
        if not self.url_prefix.startswith("/"):
            raise ValueError("url_prefix must start with '/'")
        if self.codex_max_jobs < 1:
            raise ValueError("codex_max_jobs must be positive")
        if self.codex_max_context_chars < 1:
            raise ValueError("codex_max_context_chars must be positive")
        if self.max_source_bytes < 1:
            raise ValueError("max_source_bytes must be positive")
        if len(str(self.owner_token or "")) < 32:
            raise ValueError("owner_token must contain at least 32 characters")

    @property
    def index_path(self) -> Path:
        return self.app_support_path / "knowledge-index.sqlite3"

    @property
    def cases_path(self) -> Path:
        return self.app_support_path / "cases.sqlite3"

    @property
    def manifest_path(self) -> Path:
        json_path = self.app_support_path / "source-manifest.json"
        jsonl_path = self.app_support_path / "source-manifest.jsonl"
        return json_path if json_path.exists() or not jsonl_path.exists() else jsonl_path

    @property
    def sources_path(self) -> Path:
        return self.app_support_path / "Sources"

    @property
    def runtime_path(self) -> Path:
        return self.app_support_path / "runtime"

    def ensure_directories(self) -> None:
        self.vault_path.mkdir(parents=True, exist_ok=True)
        self.app_support_path.mkdir(parents=True, exist_ok=True)
        self.runtime_path.mkdir(parents=True, exist_ok=True)
        self.sources_path.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.app_support_path, 0o700)
            os.chmod(self.runtime_path, 0o700)
            os.chmod(self.sources_path, 0o700)
        except OSError:
            # Some filesystems do not expose POSIX permissions.
            pass
