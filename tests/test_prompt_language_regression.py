import app as app_module

core = app_module.app.extensions["lecture_processor"]["runtime"].core


def _contains_any(text, needles):
    lower = text.lower()
    return any(needle in lower for needle in needles)


def test_core_prompts_are_english_and_language_controlled():
    language_controlled_prompts = [
        core.PROMPT_AUDIO_TRANSCRIPTION,
        core.PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED,
        core.PROMPT_MERGE_TEMPLATE,
        core.PROMPT_MERGE_WITH_AUDIO_MARKERS,
    ]
    all_core_prompts = [
        core.PROMPT_SLIDE_EXTRACTION,
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
    assert core.parse_output_language("english") == "English"
    assert core.parse_output_language("dutch") == "Dutch"
    assert core.parse_output_language("spanish") == "Spanish"
    assert core.parse_output_language("other", "Italian") == "Italian"


def test_study_prompt_template_formats_without_key_errors():
    rendered = core.PROMPT_STUDY_TEMPLATE.format(
        flashcard_amount=30,
        question_amount=15,
        output_language="English",
        source_text="Sample source text",
    )
    assert '"flashcards"' in rendered
    assert '"test_questions"' in rendered
