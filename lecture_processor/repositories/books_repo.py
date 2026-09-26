"""Transactional book storage. No in-memory fallback for user content."""
from __future__ import annotations

import logging
import threading
import time
from collections import Counter
from copy import deepcopy

from google.cloud import firestore

from .query_utils import apply_where


_activity = Counter()
_lock = threading.Lock()
_revision_cache = {}


def record(kind, count=1):
    with _lock:
        _activity[kind] += count
        if sum(_activity.values()) >= 250:
            logging.getLogger(__name__).info('Book database activity: reads=%s writes=%s', _activity['reads'], _activity['writes'])
            _activity.clear()


def invalidate(book_id):
    with _lock:
        _revision_cache.pop('books/' + book_id, None)


def encode(value):
    """Firestore forbids nested arrays; wrap only inner arrays, preserving public JSON."""
    if isinstance(value, list):
        return [{'_book_list': encode(v)} if isinstance(v, list) else encode(v) for v in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        if set(value) == {'_book_list'}:
            return decode(value['_book_list'])
        return {k: decode(v) for k, v in value.items()}
    return value


class BookStore:
    def __init__(self, db):
        if db is None:
            raise RuntimeError('Cloud saving is unavailable. Your draft is safe on this device.')
        self.db = db

    def ref(self, path):
        return self.db.document(path)

    def get(self, path):
        record('reads')
        snap = self.ref(path).get()
        return decode(snap.to_dict()) if snap.exists else None

    def cached(self, path):
        with _lock:
            value = _revision_cache.get(path)
        if value and time.monotonic() - value[0] < 2:
            return deepcopy(value[1])
        value = self.get(path)
        with _lock:
            if len(_revision_cache) > 500:
                _revision_cache.clear()
            _revision_cache[path] = (time.monotonic(), value)
        return deepcopy(value)

    def put(self, path, value):
        record('writes')
        self.ref(path).set(encode(value))

    def delete(self, path):
        record('writes')
        self.ref(path).delete()

    def list(self, path, field=None, value=None, operator='==', limit=200):
        query = self.db.collection(path)
        if field:
            query = apply_where(query, field, operator, value)
        result = [dict(decode(doc.to_dict()), _id=doc.id) for doc in query.limit(limit).stream()]
        record('reads', max(1, len(result)))
        return result

    def atomic(self, operation):
        transaction = self.db.transaction()

        class Unit:
            def get(_, path):
                record('reads')
                snap = self.ref(path).get(transaction=transaction)
                return decode(snap.to_dict()) if snap.exists else None

            def list(_, path, field=None, value=None, operator='==', limit=200):
                query = self.db.collection(path)
                if field:
                    query = apply_where(query, field, operator, value)
                rows = [dict(decode(doc.to_dict()), _id=doc.id) for doc in query.limit(limit).stream(transaction=transaction)]
                record('reads', max(1, len(rows)))
                return rows

            def put(_, path, value):
                record('writes')
                transaction.set(self.ref(path), encode(value))

            def delete(_, path):
                record('writes')
                transaction.delete(self.ref(path))

        @firestore.transactional
        def execute(_transaction):
            return operation(Unit())

        return execute(transaction)
