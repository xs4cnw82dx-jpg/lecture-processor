"""Content and results shared by generation providers."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class PdfPart:
    path: str | Path


@dataclass(frozen=True)
class ImagePart:
    path: str | Path
    mime_type: str = 'image/png'


@dataclass(frozen=True)
class AudioPart:
    path: str | Path
    mime_type: str


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    # Output already includes thinking; never add thinking_tokens again.
    output_tokens: int = 0
    total_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: float | None = None


@dataclass(frozen=True)
class GenerationResult:
    text: str
    parsed: Any
    usage: Usage
    provider: str
    model: str
    # Temporary compatibility for callers migrating from the native response.
    raw_response: Any = field(default=None, repr=False, compare=False)
