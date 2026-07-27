from scripts import recover_stuck_account_deletions as recovery


class _Snapshot:
    def __init__(self, doc_id, payload, store):
        self.id = doc_id
        self._payload = payload
        self.reference = _Reference(store, doc_id)

    def to_dict(self):
        return dict(self._payload)


class _Reference:
    def __init__(self, store, doc_id):
        self._store = store
        self._doc_id = doc_id

    def set(self, payload, merge=False):
        existing = dict(self._store.get(self._doc_id) or {}) if merge else {}
        existing.update(payload)
        self._store[self._doc_id] = existing


class _Query:
    def __init__(self, documents):
        self._documents = documents

    def where(self, *_args, **_kwargs):
        return self

    def limit(self, _limit):
        return self

    def stream(self):
        return iter(self._documents)


class _Collection:
    def __init__(self, db, name):
        self._db = db
        self._name = name

    def where(self, *_args, **_kwargs):
        if self._name in {'runtime_jobs', 'batch_jobs'}:
            return _Query([])
        documents = [
            _Snapshot(doc_id, payload, self._db.store[self._name])
            for doc_id, payload in self._db.store[self._name].items()
        ]
        return _Query(documents)

    def document(self, doc_id):
        return _Reference(self._db.store.setdefault(self._name, {}), doc_id)


class _Database:
    def __init__(self, users):
        self.store = {'users': users, 'account_deletions': {}}

    def collection(self, name):
        return _Collection(self, name)


def test_recovery_only_reactivates_pre_purge_deletions(monkeypatch):
    now = 10_000.0
    monkeypatch.setattr(recovery.time, 'time', lambda: now)
    db = _Database({
        'safe': {
            'uid': 'safe',
            'account_status': 'deleting',
            'deletion_phase': 'requested',
            'delete_started_at': 1,
        },
        'unsafe': {
            'uid': 'unsafe',
            'account_status': 'deleting',
            'deletion_phase': 'purging',
            'delete_started_at': 1,
        },
        'legacy-unknown': {
            'uid': 'legacy-unknown',
            'account_status': 'deleting',
            'delete_started_at': 1,
        },
    })

    summary = recovery.recover_stuck_accounts(
        db,
        stale_minutes=1,
        apply_changes=True,
        limit=10,
    )

    assert summary['recovered'] == 1
    assert summary['retry_required'] == 2
    assert db.store['users']['safe']['account_status'] == 'active'
    assert db.store['account_deletions']['safe']['phase'] == 'cancelled'
    assert db.store['users']['unsafe']['account_status'] == 'deleting'
    assert db.store['users']['unsafe']['deletion_phase'] == 'retry_required'
    assert db.store['users']['legacy-unknown']['deletion_phase'] == 'retry_required'
    assert db.store['account_deletions']['unsafe']['phase'] == 'retry_required'
