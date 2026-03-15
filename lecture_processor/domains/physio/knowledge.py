"""Knowledge-base helpers for Physio Assistant."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.runtime.container import get_runtime

from . import prompts as physio_prompts


PROJECT_ROOT = Path(__file__).resolve().parents[3]
PHYSIO_LIBRARY_ROOT = PROJECT_ROOT / "physio_library"
PHYSIO_LIBRARY_INDEX_PATH = PHYSIO_LIBRARY_ROOT / "index" / "manifest.json"
DEFAULT_EMBED_MODEL = "gemini-embedding-001"
DEFAULT_CHUNK_SIZE = 1100
DEFAULT_CHUNK_OVERLAP = 180
_INDEX_CACHE = {"path": "", "mtime": 0.0, "payload": None}


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def chunk_text(text, *, chunk_size=DEFAULT_CHUNK_SIZE, chunk_overlap=DEFAULT_CHUNK_OVERLAP):
    safe_text = str(text or "").strip()
    if not safe_text:
        return []
    safe_chunk_size = max(250, int(chunk_size or DEFAULT_CHUNK_SIZE))
    safe_overlap = max(0, min(int(chunk_overlap or 0), safe_chunk_size // 2))
    chunks = []
    start = 0
    length = len(safe_text)
    while start < length:
        end = min(length, start + safe_chunk_size)
        if end < length:
            window = safe_text[start:end]
            split_points = [window.rfind(marker) for marker in ("\n\n", "\n", ". ", " ")]
            best = max(split_points)
            if best >= safe_chunk_size // 3:
                end = start + best + (2 if safe_text[start + best:start + best + 2] == ". " else 1)
        chunk = safe_text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= length:
            break
        start = max(end - safe_overlap, start + 1)
    return chunks


def build_chunk_records(text, *, source_name, source_path, source_kind="", page_label="", title="", chunk_size=DEFAULT_CHUNK_SIZE, chunk_overlap=DEFAULT_CHUNK_OVERLAP):
    records = []
    for index, chunk in enumerate(chunk_text(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)):
        records.append(
            {
                "id": f"{Path(source_name).stem or 'source'}-{index + 1}",
                "text": chunk,
                "source_name": str(source_name or "").strip(),
                "source_title": str(title or source_name or "").strip(),
                "source_path": str(source_path or "").strip(),
                "source_kind": str(source_kind or "").strip(),
                "page_label": str(page_label or "").strip(),
                "chunk_index": index,
            }
        )
    return records


def _normalize_embedding_response(response):
    if response is None:
        return []
    embeddings = getattr(response, "embeddings", None)
    if isinstance(embeddings, list) and embeddings:
        first = embeddings[0]
        values = getattr(first, "values", None)
        if isinstance(values, list):
            return [float(item or 0.0) for item in values]
    direct = getattr(response, "embedding", None)
    values = getattr(direct, "values", None) if direct is not None else None
    if isinstance(values, list):
        return [float(item or 0.0) for item in values]
    return []


def _normalize_embeddings_response(response):
    if response is None:
        return []
    embeddings = getattr(response, "embeddings", None)
    if isinstance(embeddings, list) and embeddings:
        vectors = []
        for item in embeddings:
            values = getattr(item, "values", None)
            if isinstance(values, list):
                vectors.append([float(entry or 0.0) for entry in values])
        if vectors:
            return vectors
    single = _normalize_embedding_response(response)
    return [single] if single else []


def _embed_config(types_module, task_type):
    if types_module is not None and hasattr(types_module, "EmbedContentConfig"):
        return types_module.EmbedContentConfig(task_type=task_type)
    return None


def embed_texts(texts, *, task_type="RETRIEVAL_DOCUMENT", runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    client = getattr(resolved_runtime, "client", None)
    if client is None:
        raise RuntimeError("Gemini client is not configured.")
    safe_texts = [str(text or "") for text in (texts or [])]
    if not safe_texts:
        return []
    config = _embed_config(getattr(resolved_runtime, "types", None), task_type)
    response = client.models.embed_content(
        model=str(getattr(resolved_runtime, "PHYSIO_EMBED_MODEL", DEFAULT_EMBED_MODEL) or DEFAULT_EMBED_MODEL),
        contents=safe_texts,
        config=config,
    )
    vectors = _normalize_embeddings_response(response)
    if len(vectors) != len(safe_texts):
        raise RuntimeError("Embedding response did not contain the expected number of vectors.")
    return vectors


def embed_text(text, *, task_type="RETRIEVAL_DOCUMENT", runtime=None):
    vectors = embed_texts([text], task_type=task_type, runtime=runtime)
    if not vectors:
        raise RuntimeError("Embedding response did not contain vector values.")
    return vectors[0]


def load_knowledge_index(*, index_path=None):
    candidate = Path(index_path or PHYSIO_LIBRARY_INDEX_PATH)
    cache_key = str(candidate.resolve()) if candidate.exists() else str(candidate)
    try:
        mtime = float(candidate.stat().st_mtime)
    except Exception:
        return {"documents": [], "meta": {"path": cache_key, "missing": True}}
    if _INDEX_CACHE["payload"] is not None and _INDEX_CACHE["path"] == cache_key and _INDEX_CACHE["mtime"] == mtime:
        return _INDEX_CACHE["payload"]
    with open(candidate, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        payload = {"documents": []}
    payload.setdefault("documents", [])
    payload.setdefault("meta", {})
    _INDEX_CACHE.update({"path": cache_key, "mtime": mtime, "payload": payload})
    return payload


def cosine_similarity(left, right):
    if not left or not right:
        return 0.0
    length = min(len(left), len(right))
    if length <= 0:
        return 0.0
    dot = sum(float(left[index] or 0.0) * float(right[index] or 0.0) for index in range(length))
    left_norm = math.sqrt(sum(float(left[index] or 0.0) ** 2 for index in range(length)))
    right_norm = math.sqrt(sum(float(right[index] or 0.0) ** 2 for index in range(length)))
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return dot / (left_norm * right_norm)


def format_citation_label(record):
    payload = record if isinstance(record, dict) else {}
    title = str(payload.get("source_title", "") or payload.get("source_name", "Bron")).strip() or "Bron"
    page_label = str(payload.get("page_label", "") or "").strip()
    if page_label:
        return f"{title} ({page_label})"
    return title


def rank_index_documents(query_vector, documents, *, limit=5):
    scored = []
    for record in documents or []:
        if not isinstance(record, dict):
            continue
        score = cosine_similarity(query_vector, record.get("embedding", []))
        item = dict(record)
        item["score"] = round(float(score), 6)
        scored.append(item)
    scored.sort(key=lambda item: float(item.get("score", 0) or 0), reverse=True)
    return scored[: max(1, int(limit or 1))]


def query_knowledge_index(question, *, body_region="", context_text="", case_context=None, limit=5, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_question = str(question or "").strip()
    if not safe_question:
        raise ValueError("Vraag is verplicht.")
    index_payload = load_knowledge_index()
    documents = index_payload.get("documents", [])
    if not documents:
        return {
            "answer_markdown": "De kennisbank is nog leeg. Voeg documenten toe aan `physio_library/sources/` en draai daarna `python3 scripts/build_physio_library.py`.",
            "citations": [],
            "retrieved_sources": [],
        }

    query_vector = embed_text(safe_question, task_type="RETRIEVAL_QUERY", runtime=resolved_runtime)
    ranked = rank_index_documents(query_vector, documents, limit=limit)
    context_blocks = []
    citations = []
    for item in ranked:
        label = format_citation_label(item)
        excerpt = str(item.get("text", "") or "").strip()
        context_blocks.append(f"[{label}]\n{excerpt}")
        citations.append(
            {
                "label": label,
                "source_name": str(item.get("source_name", "") or "").strip(),
                "page_label": str(item.get("page_label", "") or "").strip(),
                "score": float(item.get("score", 0) or 0),
            }
        )

    context_markdown = "\n\n---\n\n".join(context_blocks)
    prompt = physio_prompts.knowledge_prompt(
        safe_question,
        context_markdown,
        body_region=body_region,
        context_text=context_text,
    )
    response = ai_provider.generate_with_optional_thinking(
        getattr(resolved_runtime, "MODEL_TOOLS", "gemini-3.1-flash-lite-preview"),
        prompt,
        max_output_tokens=4096,
        operation_name="physio_knowledge_answer",
        runtime=resolved_runtime,
    )
    answer = str(getattr(response, "text", "") or "").strip()
    if not answer:
        answer = "Er kon geen antwoord uit de huidige kennisbankcontext worden gegenereerd."

    retrieved_sources = []
    for item in ranked:
        retrieved_sources.append(
            {
                "source_name": str(item.get("source_name", "") or "").strip(),
                "source_title": str(item.get("source_title", "") or "").strip(),
                "page_label": str(item.get("page_label", "") or "").strip(),
                "score": float(item.get("score", 0) or 0),
                "excerpt": str(item.get("text", "") or "").strip(),
            }
        )
    return {
        "answer_markdown": answer,
        "citations": citations,
        "retrieved_sources": retrieved_sources,
    }
