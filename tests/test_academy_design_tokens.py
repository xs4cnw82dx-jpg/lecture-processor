"""The Academy palette keeps text readable in both themes, like theme.css."""

from __future__ import annotations

import re
from pathlib import Path

from tests.test_design_tokens import DECLARATION, _contrast

FOUNDATION = Path(__file__).resolve().parents[1] / 'static' / 'css' / 'elearning-foundation.css'


def _palettes():
    source = FOUNDATION.read_text(encoding='utf-8')
    blocks = re.findall(r'(:root\[data-product="academy"\](?:\[data-theme="dark"\])?)\s*\{([^{}]*)\}', source)
    light, dark = {}, {}
    for selector, body in blocks:
        values = {name: value.strip() for name, value in DECLARATION.findall(body)}
        (dark if 'dark' in selector else light).update(values)
    return light, {**light, **dark}


def test_academy_text_tokens_stay_readable_on_every_surface_in_both_themes():
    for values in _palettes():
        surfaces = [values[name] for name in ('--theme-canvas', '--theme-surface', '--theme-surface-soft', '--theme-accent-soft')]
        for token in ('--theme-ink', '--theme-ink-soft', '--theme-muted-strong', '--theme-muted', '--theme-accent-ink'):
            for surface in surfaces:
                assert _contrast(values[token], surface) >= 4.5, (token, values[token], surface)
        for status in ('success', 'warning', 'danger'):
            assert _contrast(values[f'--theme-{status}-ink'], values[f'--theme-{status}-soft']) >= 4.5, status


def test_academy_overrides_only_semantic_tokens_that_theme_css_defines():
    theme = (FOUNDATION.parent / 'theme.css').read_text(encoding='utf-8')
    defined = set(re.findall(r'(--theme-[a-z-]+)\s*:', theme))
    light, dark = _palettes()
    overridden = {name for name in {*light, *dark} if name.startswith('--theme-')}
    assert overridden <= defined, sorted(overridden - defined)
    assert sorted(name for name in light if name.startswith('--theme-')) == sorted(
        name for name in dark if name.startswith('--theme-'))


def test_academy_chart_colours_stand_out_from_their_track():
    for values in _palettes():
        for token in ('--chart-fill', '--chart-good'):
            assert _contrast(values[token], values['--chart-track']) >= 3, (token, values[token])
