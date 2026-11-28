"""Transactional Firestore storage for xPEDitie Pijn E-Learning Studio."""
from __future__ import annotations

import logging
import threading
from collections import Counter

from google.api_core.exceptions import FailedPrecondition
from google.cloud import firestore
from google.cloud.firestore_v1 import _helpers
from google.cloud.firestore_v1.types import Document

from lecture_processor.domains.elearning.model import ElearningError

from .admin_repo import count_collection
from .query_utils import apply_where

_activity = Counter()
_lock = threading.Lock()


def record(kind: str, count: int = 1) -> None:
    with _lock:
        _activity[kind] += count
        if sum(_activity.values()) >= 250:
            logging.getLogger(__name__).info(
                'E-learning database activity: reads=%s writes=%s',
                _activity['reads'],
                _activity['writes'],
            )
            _activity.clear()


def encode(value):
    """Firestore forbids nested arrays; wrap inner arrays while preserving JSON shape."""
    if isinstance(value, list):
        return [{'_el_list': encode(v)} if isinstance(v, list) else encode(v) for v in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        if set(value) == {'_el_list'}:
            return decode(value['_el_list'])
        return {k: decode(v) for k, v in value.items()}
    return value


def document_fields(value):
    fields = encode(value)
    # Keep room for the Firestore document name and encoding overhead at its 1 MiB limit.
    wire = Document(fields=_helpers.encode_dict(fields))
    if Document.pb(wire).ByteSize() > 1024 * 1024 - 8192:
        raise ElearningError('This expedition or response is too large to save. Shorten it and try again.', 413)
    return fields


class ElearningStore:
    def __init__(self, db):
        if db is None:
            raise RuntimeError('Cloud saving is unavailable right now.')
        self.db = db

    def ref(self, path: str):
        return self.db.document(path)

    def get(self, path: str, *, fields=None):
        record('reads')
        snap = self.ref(path).get(field_paths=fields)
        return decode(snap.to_dict()) if snap.exists else None

    def put(self, path: str, value: dict) -> None:
        record('writes')
        self.ref(path).set(document_fields(value))

    def delete(self, path: str) -> None:
        record('writes')
        self.ref(path).delete()

    def stream(self, collection: str, field=None, value=None, operator: str = '==', limit: int | None = 200, fields=None):
        query = self.db.collection(collection)
        if field:
            query = apply_where(query, field, operator, value)
        if fields:
            query = query.select(fields)
        if limit is not None:
            query = query.limit(limit)
        count = 0
        try:
            for doc in query.stream():
                count += 1
                yield dict(decode(doc.to_dict()), _id=doc.id)
        finally:
            record('reads', max(1, count))

    def list(self, collection: str, field=None, value=None, operator: str = '==', limit: int | None = 200, fields=None):
        return list(self.stream(collection, field, value, operator, limit, fields))

    def dashboard_sessions(self, scope, start, end, fields):
        field, value = scope
        query = apply_where(self.db.collection('elearning_responses'), field, '==', value)
        period = apply_where(apply_where(query, 'started_at', '>=', start), 'started_at', '<', end)
        count = 0
        try:
            for doc in period.select(fields).stream():
                count += 1
                yield decode(doc.to_dict())
        except FailedPrecondition as exc:
            if count or 'index' not in str(exc).lower():
                raise
            # Serve new projects through the existing single-course index while the period index builds.
            rows = self.stream('elearning_responses', field, value, limit=None, fields=fields)
            yield from (row for row in rows if start <= (row.get('started_at') or 0) < end)
        finally:
            record('reads', max(1, count))

    def count(self, collection: str, filters):
        # Firestore answers count aggregations from the index, without loading session documents.
        record('reads')
        return count_collection(self.db, collection, filters)

    def atomic(self, operation):
        transaction = self.db.transaction()

        class Unit:
            def get(_, path: str, *, fields=None):
                record('reads')
                snap = self.ref(path).get(transaction=transaction, field_paths=fields)
                return decode(snap.to_dict()) if snap.exists else None

            def response_page(_, scope, after, limit):
                field, value = scope
                collection = self.db.collection('elearning_responses')
                query = apply_where(collection, field, '==', value).order_by('__name__')
                if after:
                    query = query.start_after({'__name__': collection.document(after)})
                docs = query.select(['statisticsScope', 'expedition_id']).limit(limit).stream(transaction=transaction)
                page = [dict(doc.to_dict(), _id=doc.id) for doc in docs]
                record('reads', max(1, len(page)))
                return page

            def put(_, path: str, value: dict) -> None:
                record('writes')
                transaction.set(self.ref(path), document_fields(value))

            def update_fields(_, path: str, values: dict, *, remove=()) -> None:
                """Replace the given top-level fields of an existing document."""
                record('writes')
                changes = document_fields(values)
                changes.update(dict.fromkeys(remove, firestore.DELETE_FIELD))
                transaction.update(self.ref(path), changes)

            def delete(_, path: str) -> None:
                record('writes')
                transaction.delete(self.ref(path))

        @firestore.transactional
        def execute(_transaction):
            return operation(Unit())

        return execute(transaction)
