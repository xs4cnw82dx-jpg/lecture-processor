"""xPED metadata stays bounded and faithful across cloud/backup/export validation."""
from copy import deepcopy

import pytest

from lecture_processor.domains.books import model


def test_xped_theme_and_decoration_are_identifiers_not_executable_markup():
    value = {'id': 'xped', 'variant': 'shapes', 'mode': 'dark'}
    assert model.metadata({'theme': value})['theme'] == value
    p = model.page({'id': 'p1', 'role': 'page', 'decoration': value, 'themeArtwork': False, 'items': []})
    assert p['decoration'] == value
    assert p['themeArtwork'] is False
    assert model.theme({'id': 'xped', 'variant': '<svg onload=alert(1)>', 'mode': 'https://bad.test/'}) == {
        'id': 'xped', 'variant': 'corner', 'mode': 'light'}
    for value in (None, 'xped', ['xped'], {'id': 'custom', 'svg': '<script>'}):
        assert model.theme(value) is None


def test_old_book_defaults_keep_no_artwork_and_missing_fonts_still_safe():
    assert model.metadata({})['theme'] is None
    p = model.page({'id': 'old', 'items': []})
    assert p['decoration'] is None
    assert p['themeArtwork'] is True
    assert model.style({'font': '<script>'})['font'] == 'Nunito'


def test_interior_position_is_derived_from_order_instead_of_persisted_as_decoration():
    p = model.page({
        'id': 'inside', 'role': 'page', 'interiorIndex': 99,
        'decoration': {'id': 'xped', 'variant': 'corner', 'mode': 'dark', 'mirrored': True},
        'themeArtwork': False, 'items': [],
    })
    assert 'interiorIndex' not in p
    assert p['decoration'] == {'id': 'xped', 'variant': 'corner', 'mode': 'dark'}
    assert p['themeArtwork'] is False


@pytest.mark.parametrize('font,weight,expected', [
    ('Nohemi', 400, 700), ('Nohemi', 900, 700),
    ('General Sans', 300, 400), ('General Sans', 500, 400), ('General Sans', 900, 700),
])
def test_xped_fonts_use_supplied_static_faces_without_synthetic_italics(font, weight, expected):
    style = model.style({'font': font, 'weight': weight, 'italic': True})
    assert style['font'] == font
    assert style['weight'] == expected
    assert style['italic'] is False


def test_xped_page_round_trip_preserves_custom_flow_and_table_choices():
    raw = {
        'id': 'inside', 'role': 'page', 'background': '#062940',
        'decoration': {'id': 'xped', 'variant': 'minimal', 'mode': 'dark'}, 'themeArtwork': False,
        'items': [
            {'id': 'table', 'type': 'table', 'tableStyle': 'custom', 'fill': '#bbccaa', 'style': {'font': 'General Sans', 'weight': 700}},
            {'id': 'flow', 'type': 'flow', 'flowStyle': 'custom', 'steps': ['One', 'Two'], 'style': {'font': 'General Sans'}},
        ],
    }
    first = model.page(raw)
    assert model.page(deepcopy(first)) == first
    assert first['items'][0]['fill'] == '#bbccaa'
    assert first['items'][1]['flowStyle'] == 'custom'
    assert first['themeArtwork'] is False


@pytest.mark.parametrize('count', [4, 5, 8, 12])
def test_cut_sheets_begin_with_the_cover_on_the_left_and_preserve_reading_order(count):
    sheets = model.sheets([{'id': f'p{i}'} for i in range(count)])
    assert sheets[0] == (0, None)
    assert sheets[-1] == (count - 1, None)
    assert [page for pair in sheets for page in pair if page is not None] == list(range(count))
    assert len(sheets) == 2 + (count - 1) // 2


def test_old_fold_export_requests_get_a_useful_error():
    with pytest.raises(model.BookError, match='Refresh'):
        model.sheets([{}] * 4, 'fold')


def test_page_number_metadata_defaults_off_and_preserves_safe_options():
    assert model.metadata({})['pageNumbers'] == {
        'enabled': False, 'position': 'logo', 'font': 'General Sans', 'size': 9,
        'weight': 400, 'colorMode': 'theme', 'color': '#062940',
    }
    options = {'enabled': True, 'position': 'outer', 'font': 'Nohemi', 'size': 12,
               'weight': 700, 'colorMode': 'custom', 'color': '#007ACC'}
    assert model.metadata({'pageNumbers': options})['pageNumbers'] == options
    assert model.metadata(model.metadata({'pageNumbers': options}))['pageNumbers'] == options


@pytest.mark.parametrize('font,weight,expected', [
    ('Nohemi', 400, 700), ('General Sans', 550, 400), ('General Sans', 600, 700),
    ('Playpen Sans', 999, 800), ('Fraunces', 999, 900), ('Nunito', 100, 200),
])
def test_number_weights_use_actual_font_weights(font, weight, expected):
    assert model.page_numbers({'font': font, 'weight': weight})['weight'] == expected


def test_page_number_inputs_are_bounded_and_never_accept_markup_or_external_colors():
    value = model.page_numbers({'enabled': 'true', 'position': '<svg>', 'font': 'external',
                                'size': 999, 'weight': None, 'colorMode': '<script>', 'color': 'url(bad)'})
    assert value == {'enabled': False, 'position': 'logo', 'font': 'General Sans', 'size': 24,
                     'weight': 400, 'colorMode': 'theme', 'color': '#062940'}
    assert model.page_numbers({'size': -10})['size'] == 6
