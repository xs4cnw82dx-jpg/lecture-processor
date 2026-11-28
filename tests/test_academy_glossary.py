"""Keep retired interface terminology out of the Academy's published catalogs."""

import re

import pytest

from lecture_processor.blueprints.academy_language import catalog


@pytest.mark.parametrize(('language', 'retired'), [
    ('nl', r'pilotlinks?|medebewerkers?|co[- ]?editors?|cohort(?:en)?'),
    ('de', r'pilotlinks?|lernlinks?|co[- ]?editor(?:en)?|kohort(?:e|en)?'),
])
def test_academy_catalog_uses_current_product_terms(language, retired):
    pattern = re.compile(rf'\b(?:{retired})\b', re.IGNORECASE)
    matches = [
        f'{section}: {key} → {value}'
        for section, messages in catalog(language).items()
        for key, value in messages.items()
        if pattern.search(value)
    ]
    assert not matches, '\n'.join(matches)
