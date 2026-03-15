#!/usr/bin/env python3
"""Build the deployable Physio Assistant knowledge index."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from docx import Document

from lecture_processor import create_app
from lecture_processor.domains.physio import knowledge as physio_knowledge
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import file_service
DEFAULT_SOURCE_ROOT = PROJECT_ROOT / "physio_library" / "sources"
DEFAULT_INDEX_PATH = PROJECT_ROOT / "physio_library" / "index" / "manifest.json"
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".pptx", ".txt", ".md"}
EMBED_BATCH_SIZE = 24
MAX_INDEX_SHARD_BYTES = 90 * 1024 * 1024


def _relative_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(PROJECT_ROOT.resolve()))
    except Exception:
        return str(path)


def _title_from_path(path: Path) -> str:
    return path.stem.replace("_", " ").strip() or path.name


def iter_source_files(source_root: Path):
    for path in sorted(source_root.rglob("*")):
        if path.is_dir() or path.name.startswith("."):
            continue
        if path.name.lower() == "readme.md":
            continue
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        yield path


def _batched(items, size):
    safe_size = max(1, int(size or 1))
    for index in range(0, len(items), safe_size):
        yield items[index:index + safe_size]


def _compact_vector(values):
    return [round(float(value or 0.0), 6) for value in (values or [])]


def _serialized_json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def extract_docx_pages(path: Path):
    document = Document(str(path))
    text = "\n".join(
        paragraph.text.strip()
        for paragraph in document.paragraphs
        if str(paragraph.text or "").strip()
    ).strip()
    if not text:
        return []
    return [{"text": text, "page_label": ""}]


def _pdf_reader_class():
    try:
        from pypdf import PdfReader
    except Exception as exc:
        raise RuntimeError("PDF extraction requires the `pypdf` package.") from exc
    return PdfReader


def extract_pdf_pages(path: Path):
    PdfReader = _pdf_reader_class()
    reader = PdfReader(str(path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        text = str(page.extract_text() or "").strip()
        if not text:
            continue
        pages.append({"text": text, "page_label": f"pagina {index}"})
    return pages


def extract_pptx_pages(path: Path):
    with TemporaryDirectory() as tmpdir:
        target_pdf = Path(tmpdir) / f"{path.stem}.pdf"
        converted_pdf, error = file_service.convert_pptx_to_pdf(
            str(path),
            str(target_pdf),
            soffice_binary_getter=file_service.get_soffice_binary,
        )
        if error:
            raise RuntimeError(error)
        return extract_pdf_pages(Path(converted_pdf))


def extract_source_pages(path: Path):
    extension = path.suffix.lower()
    if extension == ".pdf":
        return extract_pdf_pages(path)
    if extension == ".docx":
        return extract_docx_pages(path)
    if extension == ".pptx":
        return extract_pptx_pages(path)
    if extension in {".txt", ".md"}:
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            return []
        return [{"text": text, "page_label": ""}]
    raise RuntimeError(f"Unsupported source format: {path.suffix}")


def build_manifest(
    source_root: Path,
    *,
    index_path: Path | None = None,
    chunk_size: int = physio_knowledge.DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = physio_knowledge.DEFAULT_CHUNK_OVERLAP,
    embed_text_fn=None,
    embed_texts_fn=None,
):
    embed = embed_text_fn or physio_knowledge.embed_text
    embed_many = embed_texts_fn
    documents = []
    errors = []
    source_files = list(iter_source_files(source_root))

    for path in source_files:
        source_path = _relative_path(path)
        source_kind = path.parent.name
        source_title = _title_from_path(path)
        try:
            pages = extract_source_pages(path)
            if not pages:
                errors.append({"source_path": source_path, "error": "No extractable text found."})
                continue
            source_records = []
            for page in pages:
                records = physio_knowledge.build_chunk_records(
                    page.get("text", ""),
                    source_name=path.name,
                    source_path=source_path,
                    source_kind=source_kind,
                    page_label=page.get("page_label", ""),
                    title=source_title,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )
                source_records.extend(records)
            if embed_many:
                for batch in _batched(source_records, EMBED_BATCH_SIZE):
                    vectors = embed_many(
                        [record["text"] for record in batch],
                        task_type="RETRIEVAL_DOCUMENT",
                    )
                    for record, vector in zip(batch, vectors):
                        record["embedding"] = _compact_vector(vector)
                        documents.append(record)
            else:
                for record in source_records:
                    record["embedding"] = _compact_vector(embed(record["text"], task_type="RETRIEVAL_DOCUMENT"))
                    documents.append(record)
        except Exception as exc:
            errors.append({"source_path": source_path, "error": str(exc)[:300]})

    manifest = {
        "meta": {
            "generated_at": time.time(),
            "source_root": _relative_path(source_root),
            "source_count": len(source_files),
            "document_count": len(documents),
            "embedding_model": physio_knowledge.DEFAULT_EMBED_MODEL,
            "chunk_size": int(chunk_size),
            "chunk_overlap": int(chunk_overlap),
        },
        "documents": documents,
        "errors": errors,
    }
    if index_path is not None:
        write_manifest(manifest, index_path)
    return manifest


def write_manifest(manifest: dict, index_path: Path):
    index_path.parent.mkdir(parents=True, exist_ok=True)
    for stale_path in index_path.parent.glob(f"{index_path.stem}.documents-*.json.gz"):
        stale_path.unlink(missing_ok=True)

    document_shards = []
    current_records = []
    current_size = 2  # []
    shard_index = 0

    def flush_shard():
        nonlocal current_records, current_size, shard_index
        if not current_records:
            return
        shard_index += 1
        shard_name = f"{index_path.stem}.documents-{shard_index:03d}.json.gz"
        shard_path = index_path.parent / shard_name
        with gzip.open(shard_path, "wb", compresslevel=6) as handle:
            handle.write(b"[")
            for index, payload in enumerate(current_records):
                if index:
                    handle.write(b",")
                handle.write(payload)
            handle.write(b"]\n")
        document_shards.append(shard_name)
        current_records = []
        current_size = 2

    for record in manifest.get("documents", []) or []:
        payload = _serialized_json_bytes(record)
        separator_size = 1 if current_records else 0
        if current_records and current_size + separator_size + len(payload) > MAX_INDEX_SHARD_BYTES:
            flush_shard()
        current_records.append(payload)
        current_size += len(payload) + (1 if len(current_records) > 1 else 0)
    flush_shard()

    index_payload = {
        "meta": {
            **(manifest.get("meta", {}) or {}),
            "format": physio_knowledge.SHARDED_INDEX_FORMAT,
            "document_shards": document_shards,
            "document_shard_count": len(document_shards),
        },
        "documents": [],
        "errors": list(manifest.get("errors", []) or []),
    }
    index_path.write_text(
        json.dumps(index_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Build the Physio Assistant knowledge index.")
    parser.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT))
    parser.add_argument("--index-path", default=str(DEFAULT_INDEX_PATH))
    parser.add_argument("--chunk-size", type=int, default=physio_knowledge.DEFAULT_CHUNK_SIZE)
    parser.add_argument("--chunk-overlap", type=int, default=physio_knowledge.DEFAULT_CHUNK_OVERLAP)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    source_root = Path(args.source_root).resolve()
    index_path = Path(args.index_path).resolve()
    if not source_root.exists():
        raise SystemExit(f"Source root not found: {source_root}")
    app = create_app()
    with app.app_context():
        runtime = get_runtime(app)
        manifest = build_manifest(
            source_root,
            index_path=index_path,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
            embed_text_fn=lambda text, task_type="RETRIEVAL_DOCUMENT": physio_knowledge.embed_text(
                text,
                task_type=task_type,
                runtime=runtime,
            ),
            embed_texts_fn=lambda texts, task_type="RETRIEVAL_DOCUMENT": physio_knowledge.embed_texts(
                texts,
                task_type=task_type,
                runtime=runtime,
            ),
        )
    print(
        "Built physio library index with "
        f"{manifest['meta']['document_count']} chunks from "
        f"{manifest['meta']['source_count']} source files."
    )
    if manifest["errors"]:
        print(f"Warnings: {len(manifest['errors'])} source file(s) could not be indexed.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
