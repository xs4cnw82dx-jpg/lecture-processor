"""The semantic colour tokens in theme.css are the single source of page colour."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS_DIR = ROOT / "static" / "css"
THEME = CSS_DIR / "theme.css"

TOKEN_USE = re.compile(r"var\(\s*(--theme-[a-z-]+)\s*([,)])")
DECLARATION = re.compile(r"(--[\w-]+)\s*:\s*([^;]+);")


def _stylesheets():
    return sorted(CSS_DIR.glob("*.css"))


def _block(source: str, selector_pattern: str) -> dict[str, str]:
    match = re.search(selector_pattern + r"\s*\{([^{}]*)\}", source)
    assert match, selector_pattern
    return {name: value.strip() for name, value in DECLARATION.findall(match.group(1))}


def _themes():
    source = THEME.read_text(encoding="utf-8")
    light = _block(source, r"(?m)^:root")
    dark = _block(source, r':root\[data-theme="dark"\]')
    return light, dark


def _luminance(hex_value: str) -> float:
    value = hex_value.lstrip("#")
    channels = [int(value[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(foreground: str, background: str) -> float:
    high, low = sorted((_luminance(foreground), _luminance(background)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def test_component_styles_use_theme_tokens_without_light_fallbacks():
    offenders = []
    for path in _stylesheets():
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"var\(\s*--theme-[a-z-]+\s*,", line):
                offenders.append(f"{path.name}:{line_number}")
    assert offenders == [], "Use the theme token itself; theme.css owns the light value: " + ", ".join(offenders[:20])


def test_every_referenced_theme_token_has_light_and_dark_values():
    light, dark = _themes()
    referenced = set()
    for path in _stylesheets():
        referenced.update(name for name, _ in TOKEN_USE.findall(path.read_text(encoding="utf-8")))
    assert referenced, "expected stylesheets to use theme tokens"
    assert sorted(referenced - set(light)) == []
    assert sorted(referenced - set(dark)) == []
    assert sorted(name for name in light if name.startswith("--theme-")) == sorted(
        name for name in dark if name.startswith("--theme-")
    )


def test_text_tokens_stay_readable_on_every_surface_in_both_themes():
    for values in _themes():
        surfaces = [values["--theme-surface"], values["--theme-surface-soft"], values["--theme-accent-soft"]]
        for token in ("--theme-ink", "--theme-ink-soft", "--theme-muted-strong", "--theme-muted", "--theme-accent-ink"):
            for surface in surfaces:
                assert _contrast(values[token], surface) >= 4.5, (token, values[token], surface)
        for status in ("success", "warning", "danger", "violet"):
            ink, soft = values[f"--theme-{status}-ink"], values[f"--theme-{status}-soft"]
            assert _contrast(ink, soft) >= 4.5, (status, ink, soft)


def test_light_only_colours_keep_a_plain_fallback_for_older_browsers():
    # light-dark() keeps a deliberate light colour (category swatches, page
    # accents) while following the dark token. Browsers without light-dark()
    # drop the declaration, so the same property must be declared first with
    # the plain light colour, and custom properties must not use it at all.
    pattern = re.compile(r"([\w-]+)\s*:\s*[^;{}]*light-dark\(")
    for path in _stylesheets():
        source = path.read_text(encoding="utf-8")
        for match in pattern.finditer(source):
            prop = match.group(1)
            assert not prop.startswith("--"), f"{path.name}: custom property {prop} uses light-dark()"
            before = source[max(0, match.start() - 400):match.start()]
            assert re.search(rf"(?<![\w-]){re.escape(prop)}\s*:[^;{{}}]+;\s*$", before), (
                f"{path.name}:{source.count(chr(10), 0, match.start()) + 1} {prop} needs a plain fallback"
            )


def test_dark_tokens_apply_on_screen_so_print_uses_light_values():
    source = THEME.read_text(encoding="utf-8")
    screen = source.index("@media screen")
    assert source.index(':root[data-theme="dark"]') > screen
    assert "initial" not in source


def test_only_shared_ui_defines_the_base_button_recipe():
    # Pages may position buttons inside their own layouts, but the bare .btn
    # rule (and its primary variant) lives once, in shared-ui.css.
    offenders = []
    for path in _stylesheets():
        if path.name == "shared-ui.css":
            continue
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r"(?:^|[{};])\s*(\.btn(?:\.primary)?)\s*\{", source):
            offenders.append(f"{path.name}:{source.count(chr(10), 0, match.start()) + 1}")
    assert offenders == [], offenders
