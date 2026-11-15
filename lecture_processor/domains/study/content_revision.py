"""Stable content identity shared by editor saves and planned study runs."""

import hashlib
import json


CONTENT_FIELDS = ('flashcards', 'test_questions', 'notes_markdown')


def fingerprint(pack):
    # Preserve the planned-run fingerprint's serialization and missing defaults.
    content = {key: pack.get(key, []) if key != 'notes_markdown' else pack.get(key, '')
               for key in CONTENT_FIELDS}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
