"""Knowledge-base helpers for Physio Assistant."""

from __future__ import annotations

import gzip
import heapq
import json
import math
import os
import re
import unicodedata
from pathlib import Path

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.runtime.container import get_runtime

from . import prompts as physio_prompts


PROJECT_ROOT = Path(__file__).resolve().parents[3]
PHYSIO_LIBRARY_ROOT = PROJECT_ROOT / "physio_library"
PHYSIO_LIBRARY_SOURCES_PATH = PHYSIO_LIBRARY_ROOT / "sources"
PHYSIO_LIBRARY_INDEX_PATH = PHYSIO_LIBRARY_ROOT / "index" / "manifest.json"
DEFAULT_EMBED_MODEL = "gemini-embedding-001"
DEFAULT_EMBED_DIMENSION = 256
DEFAULT_CHUNK_SIZE = 1100
DEFAULT_CHUNK_OVERLAP = 180
SUPPORTED_SOURCE_SUFFIXES = {".pdf", ".docx", ".pptx", ".txt", ".md"}
SHARDED_INDEX_FORMAT = "sharded-gzip-v1"
_INDEX_CACHE = {"path": "", "mtime": 0.0, "signature": "", "payload": None}
BODY_REGION_TERMS = {
    "algemeen": ["algemeen"],
    "nek": ["nek", "cervicaal", "cwk"],
    "schouder": ["schouder"],
    "elleboog_pols_hand": ["elleboog", "pols", "hand"],
    "thoracaal": ["thoracaal", "borstwervel", "bwk"],
    "lumbaal": ["lumbaal", "lage rug", "lumbaal", "lwk", "rug"],
    "heup": ["heup", "heupartrose", "coxartrose"],
    "knie": ["knie", "gonartrose"],
    "enkel_voet": ["enkel", "voet"],
    "neurologisch": ["neurologisch", "neurologie", "neuro"],
    "overig": ["overig"],
}


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _coerce_positive_int(value):
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _normalize_match_text(value):
    normalized = unicodedata.normalize("NFKD", str(value or "").lower())
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    compact = re.sub(r"[^a-z0-9]+", " ", ascii_text)
    return re.sub(r"\s+", " ", compact).strip()


def _tokenize_terms(value):
    normalized = _normalize_match_text(value)
    if not normalized:
        return []
    seen = []
    for token in normalized.split(" "):
        if len(token) < 3 or token in {"een", "het", "van", "met", "naar", "voor", "bij", "and", "the"}:
            continue
        if token not in seen:
            seen.append(token)
    return seen


def _body_region_terms(value):
    safe = str(value or "").strip().lower()
    terms = list(BODY_REGION_TERMS.get(safe, []))
    for token in _tokenize_terms(safe.replace("/", " ").replace("_", " ")):
        if token not in terms:
            terms.append(token)
    return terms


def _build_retrieval_query(question, *, body_region="", context_text="", case_context=None):
    parts = [f"Vraag: {str(question or '').strip()}"]
    if body_region:
        parts.append(f"Lichaamsregio: {body_region}")
    if context_text:
        parts.append(f"Extra context: {str(context_text).strip()}")
    if isinstance(case_context, dict) and case_context:
        for key in ("display_label", "patient_name", "primary_complaint", "referral_source", "notes", "tags", "body_region"):
            raw_value = case_context.get(key)
            if isinstance(raw_value, list):
                value = ", ".join(str(item or "").strip() for item in raw_value if str(item or "").strip())
            else:
                value = str(raw_value or "").strip()
            if value:
                parts.append(f"{key}: {value}")
    return "\n".join(parts).strip()


def _build_query_context(question, *, body_region="", context_text="", case_context=None):
    complaint_text = ""
    if isinstance(case_context, dict):
        complaint_text = " ".join(
            [
                str(case_context.get("primary_complaint", "") or "").strip(),
                str(case_context.get("notes", "") or "").strip(),
                ", ".join(str(item or "").strip() for item in (case_context.get("tags") or []) if str(item or "").strip())
                if isinstance(case_context.get("tags"), list)
                else str(case_context.get("tags", "") or "").strip(),
            ]
        ).strip()
    body_terms = _body_region_terms(body_region)
    complaint_terms = _tokenize_terms(complaint_text)[:8]
    question_terms = _tokenize_terms(question)[:10]
    context_terms = _tokenize_terms(context_text)[:8]
    focus_terms = []
    for bucket in (body_terms, complaint_terms, question_terms, context_terms):
        for term in bucket:
            if term not in focus_terms:
                focus_terms.append(term)
    return {
        "body_terms": body_terms,
        "complaint_terms": complaint_terms,
        "question_terms": question_terms,
        "context_terms": context_terms,
        "focus_terms": focus_terms,
    }


def _count_term_hits(text, terms):
    safe_text = _normalize_match_text(text)
    if not safe_text:
        return 0
    count = 0
    for term in terms or []:
        if term and term in safe_text:
            count += 1
    return count


def _source_key(record):
    payload = record if isinstance(record, dict) else {}
    for key in ("source_path", "source_name", "source_title", "id"):
        candidate = str(payload.get(key, "") or "").strip()
        if candidate:
            return candidate
    return "unknown-source"


def score_index_record(query_vector, record, *, query_context=None):
    payload = record if isinstance(record, dict) else {}
    base_score = cosine_similarity(query_vector, payload.get("embedding", []))
    if not query_context:
        return float(base_score)

    title_blob = " ".join(
        [
            str(payload.get("source_title", "") or ""),
            str(payload.get("source_name", "") or ""),
            str(payload.get("source_path", "") or ""),
            str(payload.get("page_label", "") or ""),
        ]
    )
    text_blob = str(payload.get("text", "") or "")
    source_kind = str(payload.get("source_kind", "") or "").strip().lower()

    bonus = 0.0
    if source_kind == "guidelines":
        bonus += 0.08

    title_body_hits = _count_term_hits(title_blob, query_context.get("body_terms"))
    title_focus_hits = _count_term_hits(title_blob, query_context.get("focus_terms"))
    text_body_hits = _count_term_hits(text_blob, query_context.get("body_terms"))
    text_complaint_hits = _count_term_hits(text_blob, query_context.get("complaint_terms"))

    if title_body_hits:
        bonus += min(0.08, 0.05 + 0.015 * max(title_body_hits - 1, 0))
    if title_focus_hits:
        bonus += min(0.06, 0.02 + 0.01 * max(title_focus_hits - 1, 0))
    if text_body_hits:
        bonus += min(0.04, 0.015 * text_body_hits)
    if text_complaint_hits:
        bonus += min(0.04, 0.012 * text_complaint_hits)
    return float(base_score) + float(bonus)


def _diversify_ranked_records(records, *, limit=5):
    safe_limit = max(1, int(limit or 1))
    selected = []
    counts = {}
    selected_ids = set()
    for pass_limit in (1, 2, 9999):
        for record in records:
            record_id = str(record.get("id", "") or "")
            source_key = _source_key(record)
            if record_id and record_id in selected_ids:
                continue
            if counts.get(source_key, 0) >= pass_limit:
                continue
            selected.append(record)
            counts[source_key] = counts.get(source_key, 0) + 1
            if record_id:
                selected_ids.add(record_id)
            if len(selected) >= safe_limit:
                return selected
    return selected[:safe_limit]


def resolve_embed_dimension(*, runtime=None, output_dimensionality=None):
    explicit = _coerce_positive_int(output_dimensionality)
    if explicit is not None:
        return explicit
    resolved_runtime = runtime if runtime is not None else None
    runtime_value = _coerce_positive_int(getattr(resolved_runtime, "PHYSIO_EMBED_DIMENSION", None))
    if runtime_value is not None:
        return runtime_value
    env = getattr(resolved_runtime, "os", os) if resolved_runtime is not None else os
    env_value = _coerce_positive_int(getattr(env, "getenv", os.getenv)("PHYSIO_EMBED_DIMENSION", ""))
    if env_value is not None:
        return env_value
    return DEFAULT_EMBED_DIMENSION


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


def list_supported_source_paths(*, source_root=None):
    root = Path(source_root or PHYSIO_LIBRARY_SOURCES_PATH)
    if not root.exists():
        return []
    paths = []
    for path in sorted(root.rglob("*")):
        if path.is_dir() or path.name.startswith("."):
            continue
        if path.suffix.lower() not in SUPPORTED_SOURCE_SUFFIXES:
            continue
        try:
            relative = str(path.resolve().relative_to(PROJECT_ROOT.resolve()))
        except Exception:
            relative = str(path)
        paths.append(relative)
    return paths


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


def _embed_config(types_module, task_type, *, output_dimensionality=None):
    if types_module is not None and hasattr(types_module, "EmbedContentConfig"):
        payload = {"task_type": task_type}
        dimension = _coerce_positive_int(output_dimensionality)
        if dimension is not None:
            payload["output_dimensionality"] = dimension
        return types_module.EmbedContentConfig(**payload)
    return None


def embed_texts(texts, *, task_type="RETRIEVAL_DOCUMENT", runtime=None, output_dimensionality=None):
    resolved_runtime = _resolve_runtime(runtime)
    client = getattr(resolved_runtime, "client", None)
    if client is None:
        raise RuntimeError("Gemini client is not configured.")
    safe_texts = [str(text or "") for text in (texts or [])]
    if not safe_texts:
        return []
    config = _embed_config(
        getattr(resolved_runtime, "types", None),
        task_type,
        output_dimensionality=resolve_embed_dimension(
            runtime=resolved_runtime,
            output_dimensionality=output_dimensionality,
        ),
    )
    response = client.models.embed_content(
        model=str(getattr(resolved_runtime, "PHYSIO_EMBED_MODEL", DEFAULT_EMBED_MODEL) or DEFAULT_EMBED_MODEL),
        contents=safe_texts,
        config=config,
    )
    vectors = _normalize_embeddings_response(response)
    if len(vectors) != len(safe_texts):
        raise RuntimeError("Embedding response did not contain the expected number of vectors.")
    return vectors


def embed_text(text, *, task_type="RETRIEVAL_DOCUMENT", runtime=None, output_dimensionality=None):
    vectors = embed_texts(
        [text],
        task_type=task_type,
        runtime=runtime,
        output_dimensionality=output_dimensionality,
    )
    if not vectors:
        raise RuntimeError("Embedding response did not contain vector values.")
    return vectors[0]


def load_knowledge_manifest(*, index_path=None):
    candidate = Path(index_path or PHYSIO_LIBRARY_INDEX_PATH)
    cache_key = str(candidate.resolve()) if candidate.exists() else str(candidate)
    try:
        with open(candidate, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return {"documents": [], "errors": [], "meta": {"path": cache_key, "missing": True}}
    if not isinstance(payload, dict):
        payload = {"documents": []}
    payload.setdefault("documents", [])
    payload.setdefault("errors", [])
    payload.setdefault("meta", {})
    return payload


def _index_cache_signature(candidate: Path, payload: dict):
    parts = []
    try:
        stat = candidate.stat()
        parts.append(f"{candidate.resolve()}:{stat.st_mtime_ns}:{stat.st_size}")
    except Exception:
        parts.append(str(candidate))
    shard_names = ((payload.get("meta", {}) or {}).get("document_shards") or [])
    for name in shard_names:
        shard_path = candidate.parent / str(name)
        try:
            stat = shard_path.stat()
            parts.append(f"{shard_path.resolve()}:{stat.st_mtime_ns}:{stat.st_size}")
        except Exception:
            parts.append(f"{shard_path}:missing")
    return "|".join(parts)


def _load_sharded_documents(candidate: Path, payload: dict):
    shard_names = ((payload.get("meta", {}) or {}).get("document_shards") or [])
    if not shard_names:
        return list(payload.get("documents", []) or []), []
    documents = []
    errors = []
    for name in shard_names:
        shard_path = candidate.parent / str(name)
        try:
            with gzip.open(shard_path, "rt", encoding="utf-8") as handle:
                shard_documents = json.load(handle)
            if not isinstance(shard_documents, list):
                raise RuntimeError("Shard payload is not a document list.")
            documents.extend(item for item in shard_documents if isinstance(item, dict))
        except Exception as exc:
            errors.append(
                {
                    "source_path": str(shard_path),
                    "error": f"Failed to load index shard: {str(exc)[:240]}",
                }
            )
            return [], errors
    return documents, errors


def load_knowledge_index(*, index_path=None):
    candidate = Path(index_path or PHYSIO_LIBRARY_INDEX_PATH)
    cache_key = str(candidate.resolve()) if candidate.exists() else str(candidate)
    try:
        mtime = float(candidate.stat().st_mtime)
    except Exception:
        return {"documents": [], "meta": {"path": cache_key, "missing": True}}
    payload = load_knowledge_manifest(index_path=candidate)
    signature = _index_cache_signature(candidate, payload)
    if _INDEX_CACHE["payload"] is not None and _INDEX_CACHE["path"] == cache_key and _INDEX_CACHE.get("signature") == signature:
        return _INDEX_CACHE["payload"]
    documents, shard_errors = _load_sharded_documents(candidate, payload)
    payload["documents"] = documents
    payload.setdefault("errors", [])
    if shard_errors:
        payload["errors"] = list(payload.get("errors", []) or []) + shard_errors
    _INDEX_CACHE.update({"path": cache_key, "mtime": mtime, "signature": signature, "payload": payload})
    return payload


def knowledge_index_status(*, index_path=None, source_root=None):
    candidate = Path(index_path or PHYSIO_LIBRARY_INDEX_PATH)
    payload = load_knowledge_manifest(index_path=candidate)
    meta = payload.get("meta", {}) or {}
    errors = payload.get("errors", [])
    on_disk_sources = list_supported_source_paths(source_root=source_root)
    indexed_source_paths = meta.get("indexed_source_paths") or []
    if indexed_source_paths:
        indexed_sources = {
            str(item or "").strip()
            for item in indexed_source_paths
            if str(item or "").strip()
        }
    else:
        documents = payload.get("documents", []) or []
        if not documents and (meta.get("document_shards") or []):
            loaded_payload = load_knowledge_index(index_path=candidate)
            documents = loaded_payload.get("documents", [])
            errors = list(loaded_payload.get("errors", []) or [])
        indexed_sources = {
            str(item.get("source_path", "") or item.get("source_name", "")).strip()
            for item in documents
            if isinstance(item, dict)
        }
    indexed_sources.discard("")
    try:
        manifest_mtime = float(candidate.stat().st_mtime)
    except Exception:
        manifest_mtime = 0.0
    source_mtimes = []
    for relative_path in on_disk_sources:
        try:
            source_mtimes.append(float((PROJECT_ROOT / relative_path).stat().st_mtime))
        except Exception:
            continue
    latest_source_mtime = max(source_mtimes) if source_mtimes else 0.0
    missing_sources = [path for path in on_disk_sources if path not in indexed_sources]
    return {
        "index_path": str(candidate),
        "generated_at": float(meta.get("generated_at", 0) or 0),
        "manifest_mtime": manifest_mtime,
        "latest_source_mtime": latest_source_mtime,
        "stale": bool(manifest_mtime and latest_source_mtime and manifest_mtime < latest_source_mtime),
        "source_count": int(meta.get("source_count", len(on_disk_sources)) or 0),
        "source_count_on_disk": len(on_disk_sources),
        "indexed_source_count": len(indexed_sources),
        "document_count": int(meta.get("document_count", len(payload.get("documents", []) or [])) or 0),
        "error_count": len(errors),
        "error_samples": errors[:5] if isinstance(errors, list) else [],
        "missing_source_paths": missing_sources[:10],
    }


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
    safe_limit = max(1, int(limit or 1))
    candidate_limit = max(safe_limit, safe_limit * 6)
    top_matches = []
    for index, record in enumerate(documents or []):
        if not isinstance(record, dict):
            continue
        score = cosine_similarity(query_vector, record.get("embedding", []))
        sortable = (float(score), -index, record)
        if len(top_matches) < candidate_limit:
            heapq.heappush(top_matches, sortable)
            continue
        if sortable > top_matches[0]:
            heapq.heapreplace(top_matches, sortable)
    ranked = []
    for score, _neg_index, record in sorted(top_matches, reverse=True):
        item = dict(record)
        item["score"] = round(float(score), 6)
        ranked.append(item)
    return ranked[:safe_limit]


def rank_sharded_index_documents(query_vector, payload, *, index_path=None, limit=5, query_context=None):
    candidate = Path(index_path or PHYSIO_LIBRARY_INDEX_PATH)
    safe_limit = max(1, int(limit or 1))
    candidate_limit = max(safe_limit, safe_limit * 6)
    shard_names = ((payload.get("meta", {}) or {}).get("document_shards") or [])
    top_matches = []
    record_index = 0
    for name in shard_names:
        shard_path = candidate.parent / str(name)
        with gzip.open(shard_path, "rt", encoding="utf-8") as handle:
            shard_documents = json.load(handle)
        for record in shard_documents or []:
            if not isinstance(record, dict):
                continue
            score = score_index_record(query_vector, record, query_context=query_context)
            sortable = (float(score), -record_index, record)
            if len(top_matches) < candidate_limit:
                heapq.heappush(top_matches, sortable)
            elif sortable > top_matches[0]:
                heapq.heapreplace(top_matches, sortable)
            record_index += 1
    ranked = []
    for score, _neg_index, record in sorted(top_matches, reverse=True):
        item = dict(record)
        item["score"] = round(float(score), 6)
        ranked.append(item)
    return _diversify_ranked_records(ranked, limit=safe_limit)


def query_knowledge_index(question, *, body_region="", context_text="", case_context=None, limit=5, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_question = str(question or "").strip()
    if not safe_question:
        raise ValueError("Vraag is verplicht.")
    index_payload = load_knowledge_manifest()
    meta = index_payload.get("meta", {}) or {}
    shard_names = meta.get("document_shards") or []
    documents = index_payload.get("documents", []) or []
    if not documents and not shard_names:
        return {
            "answer_markdown": "De kennisbank is nog leeg. Voeg documenten toe aan `physio_library/sources/` en draai daarna `python3 scripts/build_physio_library.py`.",
            "citations": [],
            "retrieved_sources": [],
        }

    embedding_dimension = _coerce_positive_int(meta.get("embedding_dimension"))
    if embedding_dimension is None and documents:
        first_embedding = documents[0].get("embedding", []) if documents else []
        embedding_dimension = len(first_embedding) if isinstance(first_embedding, list) and first_embedding else None
    retrieval_query = _build_retrieval_query(
        safe_question,
        body_region=body_region,
        context_text=context_text,
        case_context=case_context,
    )
    query_context = _build_query_context(
        safe_question,
        body_region=body_region,
        context_text=context_text,
        case_context=case_context,
    )
    query_vector = embed_text(
        retrieval_query,
        task_type="RETRIEVAL_QUERY",
        runtime=resolved_runtime,
        output_dimensionality=embedding_dimension,
    )
    if shard_names:
        ranked = rank_sharded_index_documents(query_vector, index_payload, limit=limit, query_context=query_context)
    else:
        raw_ranked = []
        candidate_limit = max(1, int(limit or 1)) * 6
        top_matches = []
        for index, record in enumerate(documents or []):
            if not isinstance(record, dict):
                continue
            score = score_index_record(query_vector, record, query_context=query_context)
            sortable = (float(score), -index, record)
            if len(top_matches) < candidate_limit:
                heapq.heappush(top_matches, sortable)
                continue
            if sortable > top_matches[0]:
                heapq.heapreplace(top_matches, sortable)
        for score, _neg_index, record in sorted(top_matches, reverse=True):
            item = dict(record)
            item["score"] = round(float(score), 6)
            raw_ranked.append(item)
        ranked = _diversify_ranked_records(raw_ranked, limit=limit)
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
                "source_kind": str(item.get("source_kind", "") or "").strip(),
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
                "source_kind": str(item.get("source_kind", "") or "").strip(),
                "source_path": str(item.get("source_path", "") or "").strip(),
                "score": float(item.get("score", 0) or 0),
                "excerpt": str(item.get("text", "") or "").strip(),
            }
        )
    return {
        "answer_markdown": answer,
        "citations": citations,
        "retrieved_sources": retrieved_sources,
    }
