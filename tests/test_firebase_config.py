import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_firestore_rules_are_configured_for_deployments():
    firebase_config = json.loads((PROJECT_ROOT / 'firebase.json').read_text(encoding='utf-8'))
    firestore_config = firebase_config.get('firestore', {})

    assert firestore_config.get('rules') == 'firestore.rules'
    assert firestore_config.get('indexes') == 'firestore.indexes.json'


def test_firestore_rules_default_to_denying_client_access():
    rules_text = (PROJECT_ROOT / 'firestore.rules').read_text(encoding='utf-8')

    assert "rules_version = '2';" in rules_text
    assert 'match /databases/{database}/documents' in rules_text
    assert 'match /{document=**}' in rules_text
    assert 'allow read, write: if false;' in rules_text


def test_required_firestore_composite_indexes_are_declared():
    indexes = json.loads((PROJECT_ROOT / 'firestore.indexes.json').read_text(encoding='utf-8')).get('indexes', [])

    def _has_index(collection_group, fields):
        expected = [(name, order) for name, order in fields]
        for index in indexes:
            if index.get('collectionGroup') != collection_group:
                continue
            actual = [
                (field.get('fieldPath'), field.get('order'))
                for field in index.get('fields', [])
            ]
            if actual == expected:
                return True
        return False

    assert _has_index(
        'batch_jobs',
        [('uid', 'ASCENDING'), ('client_submission_id', 'ASCENDING'), ('created_at', 'DESCENDING')],
    )
    assert _has_index(
        'study_shares',
        [('owner_uid', 'ASCENDING'), ('updated_at', 'DESCENDING')],
    )
    assert _has_index(
        'study_packs',
        [('uid', 'ASCENDING'), ('folder_id', 'ASCENDING'), ('created_at', 'DESCENDING')],
    )


def test_telemetry_ttl_field_overrides_are_declared():
    config = json.loads((PROJECT_ROOT / 'firestore.indexes.json').read_text(encoding='utf-8'))
    overrides = config.get('fieldOverrides', [])

    expected = {
        ('job_logs', 'expires_at_ts'),
        ('analytics_events', 'expires_at_ts'),
        ('rate_limit_logs', 'expires_at_ts'),
    }
    actual = {
        (override.get('collectionGroup'), override.get('fieldPath'))
        for override in overrides
        if override.get('ttl') is True
    }
    assert expected <= actual
