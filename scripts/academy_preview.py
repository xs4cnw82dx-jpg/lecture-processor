"""Isolated Academy factory with empty Firestore, a synthetic identity and disabled media I/O."""
from contextlib import ExitStack, contextmanager
import os
from unittest.mock import Mock, patch
from types import SimpleNamespace
import time


@contextmanager
def academy_preview(credential_path, *, memory=False):
    from lecture_processor import academy

    environment = {
        'ACADEMY_FIREBASE_PROJECT_ID': 'demo-xped-academy',
        'ACADEMY_FIREBASE_API_KEY': 'synthetic-web-api-key',
        'ACADEMY_FIREBASE_APP_ID': '1:123456789:web:abc123',
        'ACADEMY_FIREBASE_CREDENTIALS': '',
        'XPED_STUDIO_ADMIN_EMAIL': '',
        'GOOGLE_APPLICATION_CREDENTIALS': str(credential_path),
        'BOOK_STORAGE_URL': 'https://storage.example.invalid',
        'BOOK_STORAGE_KEY': 'synthetic-private-storage-key',
        'BOOK_STORAGE_BUCKET': 'academy-test-media',
        'FLASK_SECRET_KEY': 'isolated-academy-test-secret-for-signed-grants',
        'PUBLIC_BASE_URL': 'https://academy.example.test',
        'LEGAL_CONTACT_EMAIL': 'contact@example.test',
        'XPED_STUDIO_ADMIN_UID': 'studio-owner',
    }
    # A missing document and an empty query emulate the fresh project.
    database = Mock()
    database.collection.return_value.stream.return_value = ()
    database.collection.return_value.where.return_value.stream.return_value = ()
    database.collection.return_value.document.return_value.get.return_value.exists = False
    database.collection.return_value.where.return_value.limit.return_value.stream.return_value = ()
    database.document.return_value.get.return_value.exists = False
    firebase_app = object()

    profile = SimpleNamespace(display_name='Studio', uid='studio-owner', email='studio@example.test', email_verified=True, disabled=False,
                              user_metadata=SimpleNamespace(creation_timestamp=1, last_sign_in_timestamp=1), provider_data=[])
    database.collection.return_value.select.return_value.stream.return_value = ()
    database.collection.return_value.where.return_value.select.return_value.stream.return_value = ()

    def verify_token(token, *, app, **_options):
        if memory and app is firebase_app and token in ('academy-preview-editor', 'academy-preview-translator'):
            role = token.rsplit('-', 1)[-1]
            return {'uid': 'preview-' + role, 'email': role + '@example.test', 'email_verified': True, 'auth_time': time.time()}
        if app is not firebase_app or token != 'academy-preview-token':
            raise ValueError('Unknown preview identity')
        return {'uid': 'studio-owner', 'email': 'studio@example.test', 'email_verified': True, 'auth_time': time.time()}

    with patch.dict(os.environ, environment), \
         patch.object(academy, '_firebase_clients', return_value=(database, firebase_app)), \
         patch('firebase_admin.auth.get_user', return_value=profile), \
         patch('firebase_admin.auth.get_users', return_value=SimpleNamespace(users=[profile])), \
         patch('firebase_admin.auth.verify_id_token', side_effect=verify_token), \
         patch('lecture_processor.services.academy_accounts._delete_signin', side_effect=RuntimeError('Preview identity removal is offline')), \
         patch('lecture_processor.services.book_storage.request', side_effect=RuntimeError('Preview media is offline')):
        app = academy.create_app()
        app.config['TESTING'] = True
        with ExitStack() as isolated:
            if memory:
                from tests.support.elearning_store import MemoryStore
                repository = MemoryStore()
                isolated.enter_context(patch('lecture_processor.services.elearning_service._store', return_value=repository))
            yield app
