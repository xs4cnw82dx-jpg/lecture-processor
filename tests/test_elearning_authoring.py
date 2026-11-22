from copy import deepcopy

import pytest

from lecture_processor.domains.elearning import model


def test_structural_saves_preserve_persisted_translation_review_decisions():
    exp = model.build_default_expedition()
    old = exp['startPage']['title']
    old.update(nl='Een', de='Eins', en='One')
    write = deepcopy(exp)
    write['startPage']['title']['nl'] = 'Twee'
    model.mark_translations_for_review(exp, write, 'nl')
    assert write['startPage']['title']['_review'] == {'en': True, 'de': True}
    stale = deepcopy(write)
    stale['startPage']['title'].pop('_review')
    model.mark_translations_for_review(write, stale, 'nl')
    assert stale['startPage']['title']['_review'] == {'en': True, 'de': True}
    translated = model.apply_translation_patch(stale, 'de', {'startPage.title': 'Zwei'})
    model.mark_translations_for_review(translated, stale, 'nl')
    assert stale['startPage']['title']['_review'] == {'en': True}


def test_translation_rejects_text_that_a_later_structural_save_would_shorten():
    exp = model.build_default_expedition()
    with pytest.raises(model.ElearningError, match='300'):
        model.apply_translation_patch(exp, 'de', {'startPage.title': 'ü' * 301})
    assert exp['startPage']['title']['de'] == ''
    translated = model.apply_translation_patch(exp, 'de', {'startPage.title': 'ü' * 300})
    assert translated['startPage']['title']['de'] == 'ü' * 300


@pytest.mark.parametrize(('field', 'value', 'limit'), [
    ('eyebrow', {'en': 'a' * 121}, 120),
    ('highlights', [{'text': {'en': 'Example'}}] * 9, 8),
])
def test_authoring_limits_reject_the_whole_save(field, value, limit):
    exp = model.build_default_expedition()
    exp['startPage'][field] = value
    with pytest.raises(model.ElearningError, match=str(limit)):
        model.validate_authored_expedition(exp)
