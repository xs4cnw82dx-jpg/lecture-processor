"""Transactional Firestore storage for xPEDitie Pijn E-Learning Studio."""
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
_cache: dict[str, tuple[float, object]] = {}


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


def invalidate(expedition_id: str) -> None:
    with _lock:
        _cache.pop('elearning_expeditions/' + str(expedition_id), None)


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


class ElearningStore:
    def __init__(self, db):
        if db is None:
            raise RuntimeError('Cloud saving is unavailable right now.')
        self.db = db

    def ref(self, path: str):
        return self.db.document(path)

    def get(self, path: str):
        record('reads')
        snap = self.ref(path).get()
        return decode(snap.to_dict()) if snap.exists else None

    def cached(self, path: str):
        with _lock:
            entry = _cache.get(path)
        if entry and time.monotonic() - entry[0] < 2:
            return deepcopy(entry[1])
        value = self.get(path)
        with _lock:
            if len(_cache) > 500:
                _cache.clear()
            _cache[path] = (time.monotonic(), value)
        return deepcopy(value)

    def put(self, path: str, value: dict) -> None:
        record('writes')
        self.ref(path).set(encode(value))

    def delete(self, path: str) -> None:
        record('writes')
        self.ref(path).delete()

    def list(self, collection: str, field=None, value=None, operator: str = '==', limit: int = 200):
        query = self.db.collection(collection)
        if field:
            query = apply_where(query, field, operator, value)
        rows = [dict(decode(doc.to_dict()), _id=doc.id) for doc in query.limit(limit).stream()]
        record('reads', max(1, len(rows)))
        return rows

    def atomic(self, operation):
        transaction = self.db.transaction()

        class Unit:
            def get(_, path: str):
                record('reads')
                snap = self.ref(path).get(transaction=transaction)
                return decode(snap.to_dict()) if snap.exists else None

            def list(_, collection: str, field=None, value=None, operator: str = '==', limit: int = 200):
                query = self.db.collection(collection)
                if field:
                    query = apply_where(query, field, operator, value)
                rows = [dict(decode(doc.to_dict()), _id=doc.id) for doc in query.limit(limit).stream(transaction=transaction)]
                record('reads', max(1, len(rows)))
                return rows

            def put(_, path: str, value: dict) -> None:
                record('writes')
                transaction.set(self.ref(path), encode(value))

            def delete(_, path: str) -> None:
                record('writes')
                transaction.delete(self.ref(path))

        @firestore.transactional
        def execute(_transaction):
            return operation(Unit())

        return execute(transaction)
