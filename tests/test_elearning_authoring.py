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


def test_lecture_processor_keeps_bidirectional_review_for_nondefault_language_edits():
    course = model.build_default_expedition('Bron', 'nl')
    modified = deepcopy(course)
    modified['startPage']['title']['de'] = 'Übersetzung'
    model.mark_translations_for_review(course, modified, 'de')
    assert modified['startPage']['title']['_review'] == {'nl': True}
    assert model.compute_language_coverage(modified)['nl']['needsReview'] == 1
    row = next(row for row in model.extract_translation_rows(modified, 'de', 'nl') if row['key'] == 'startPage.title')
    assert row['status'] == 'needs_review'


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


def test_story_framing_and_semantic_styles_survive_normalization_and_publication():
    exp = model.build_default_expedition()
    exp['id'] = 'course'
    story = model.normalize_block({'type': 'story', 'data': {
        'portraitZoom': 2500, 'portraitX': -25, 'portraitY': 'unusable'}})
    assert [story['data'][key] for key in ('portraitZoom', 'portraitX', 'portraitY')] == [250, -25, 0]
    belief = model.normalize_block({'type': 'myth_fact', 'settings': {'textStyles': {
        'statement': 'h2', 'body': 'unknown', 'unexpected': 'h3'}}})
    step = exp['modules'][0]['steps'][0]
    step['blocks'] = [story, belief]
    public_blocks = model.sanitize_public_expedition(exp)['modules'][0]['steps'][0]['blocks']
    assert public_blocks[0]['data']['portraitX'] == -25
    assert public_blocks[1]['settings']['textStyles'] == {'statement': 'h2'}


def test_disabling_custom_steps_accepts_only_suggestions_in_current_and_legacy_answers():
    from lecture_processor.services.elearning_service import _learner_answer
    block = {'type': 'mini_plan', 'data': {'allowCustom': False, 'suggestions': [
        {'id': 'walk', 'label': {'en': 'Take a walk', 'nl': 'Even wandelen'}}]}}
    assert _learner_answer(block, {'ids': ['walk'], 'custom': ['Private idea']}) == {'ids': ['walk'], 'custom': []}
    assert _learner_answer(block, ['Private idea', 'Even wandelen']) == ['Even wandelen']


def test_percentage_chart_and_custom_result_survive_publication_and_translation():
    draft = model.build_default_expedition()
    draft['startPage']['summaryPlanHeading'] = {'nl': 'Mijn boekenlegger'}
    draft['modules'][0]['steps'][0]['blocks'] = [{'type': 'custom_visual', 'data': {
        'preset': 'percentage', 'percentage': 0, 'sourceUrl': '10.1000/example',
        'citation': {'nl': 'De onderzoeksgroep'}, 'alt': {'nl': 'Nul procent'}}}]
    normalized = model.validate_authored_expedition(draft)
    translated = model.apply_translation_patch(normalized, 'de', {'startPage.summaryPlanHeading': 'Mein Lesezeichen'})
    public = model.sanitize_public_expedition({**translated, 'id': 'example'})
    assert public['startPage']['summaryPlanHeading']['de'] == 'Mein Lesezeichen'
    chart = public['modules'][0]['steps'][0]['blocks'][0]['data']
    assert chart['percentage'] == 0
    assert chart['citation']['nl'] == 'De onderzoeksgroep'
    assert chart['sourceUrl'] == 'https://doi.org/10.1000/example'


@pytest.mark.parametrize('value', ['NaN', 'Infinity', '-Infinity'])
def test_imported_nonfinite_percentage_uses_default(value):
    chart = model.normalize_block({'type': 'custom_visual', 'data': {'preset': 'percentage', 'percentage': value}})
    assert chart['data']['percentage'] == 50
