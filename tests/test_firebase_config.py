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
