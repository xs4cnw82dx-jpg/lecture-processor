"""Isolated Academy factory with empty Firestore, a synthetic identity and disabled media I/O."""
from contextlib import contextmanager
import os
from unittest.mock import Mock, patch


@contextmanager
def academy_preview(credential_path):
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
    database.collection.return_value.document.return_value.get.return_value.exists = False
    database.collection.return_value.where.return_value.limit.return_value.stream.return_value = ()
    database.document.return_value.get.return_value.exists = False
    firebase_app = object()

    def verify_token(token, *, app, **_options):
        if app is not firebase_app or token != 'academy-preview-token':
            raise ValueError('Unknown preview identity')
        return {'uid': 'studio-owner', 'email': 'studio@example.test', 'email_verified': True}

    with patch.dict(os.environ, environment), \
         patch.object(academy, '_firebase_clients', return_value=(database, firebase_app)), \
         patch('firebase_admin.auth.verify_id_token', side_effect=verify_token), \
         patch('lecture_processor.services.book_storage.request', side_effect=RuntimeError('Preview media is offline')):
        app = academy.create_app()
        app.config['TESTING'] = True
        yield app
