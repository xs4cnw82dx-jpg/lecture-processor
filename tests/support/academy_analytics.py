"""Isolated Studio plus its own synthetic owner, course store and consent helpers."""
import pytest

from lecture_processor import academy
from lecture_processor.services import elearning_service as service
from scripts.academy_preview import academy_preview
from tests.test_elearning_api import MemoryStore


@pytest.fixture()
def academy_studio(tmp_path, monkeypatch):
    with academy_preview(tmp_path / 'synthetic-academy-owner.json') as app:
        runtime = app.extensions['lecture_processor']['runtime']
        runtime.ADMIN_UIDS = {'owner'}
        runtime.XPED_STUDIO_ADMIN_UID = 'owner'
        store = MemoryStore()
        monkeypatch.setattr(service, '_store', lambda _runtime: store)

        def verify(token, **_):
            if token != 'owner':
                raise ValueError('Unknown test identity')
            return {'uid': 'owner', 'email': 'owner@example.test', 'email_verified': True}

        monkeypatch.setattr(academy.auth, 'verify_id_token', verify)
        yield app.test_client(), store
