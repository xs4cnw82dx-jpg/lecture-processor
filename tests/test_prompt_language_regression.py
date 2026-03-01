import app as app_module


def _contains_any(text, needles):
    lower = text.lower()
    return any(needle in lower for needle in needles)


def test_core_prompts_are_english_and_language_controlled():
    language_controlled_prompts = [
        app_module.PROMPT_AUDIO_TRANSCRIPTION,
        app_module.PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED,
        app_module.PROMPT_MERGE_TEMPLATE,
        app_module.PROMPT_MERGE_WITH_AUDIO_MARKERS,
    ]
    all_core_prompts = [
        app_module.PROMPT_SLIDE_EXTRACTION,
        *language_controlled_prompts,
    ]
    dutch_markers = [
        "instructies:",
        "regels:",
        "schrijf",
        "maak een nauwkeurig",
        "geef alleen geldige json",
    ]

    for prompt in language_controlled_prompts:
        assert "{output_language}" in prompt

    for prompt in all_core_prompts:
        assert not _contains_any(prompt, dutch_markers)


def test_output_language_mapping_stays_stable():
    assert app_module.parse_output_language("english") == "English"
    assert app_module.parse_output_language("dutch") == "Dutch"
    assert app_module.parse_output_language("spanish") == "Spanish"
    assert app_module.parse_output_language("other", "Italian") == "Italian"
