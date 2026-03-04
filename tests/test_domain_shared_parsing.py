from lecture_processor.domains.shared import parsing
from lecture_processor.runtime.container import get_runtime


def test_shared_parsing_uses_runtime_constants():
    class _Runtime:
        DEFAULT_OUTPUT_LANGUAGE_KEY = 'english'
        OUTPUT_LANGUAGE_MAP = {'english': 'English', 'dutch': 'Dutch'}
        OUTPUT_LANGUAGE_KEYS = {'english', 'dutch', 'other'}
        MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH = 20

    runtime = _Runtime()
    assert parsing.parse_requested_amount("20", {"10", "20"}, "10", runtime=runtime) == "20"
    assert parsing.parse_study_features("both", runtime=runtime) == "both"
    assert parsing.normalize_output_language_choice("english", "EN", runtime=runtime) == ("english", "", "English")
    assert parsing.parse_output_language("other", "Italian", runtime=runtime) == "Italian"
    assert parsing.sanitize_output_language_pref_key(" Dutch ", runtime=runtime) == "dutch"
    assert parsing.sanitize_output_language_pref_custom("  Italiano  ", runtime=runtime) == "Italiano"
    assert parsing.build_user_preferences_payload({"uid": "u1"}, runtime=runtime) == {
        "output_language": "english",
        "output_language_custom": "",
        "output_language_label": "English",
        "onboarding_completed": False,
    }
    assert parsing.parse_interview_features("summary", runtime=runtime) == ["summary"]


def test_shared_parsing_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "DEFAULT_OUTPUT_LANGUAGE_KEY", "english")
    monkeypatch.setattr(runtime, "OUTPUT_LANGUAGE_MAP", {"english": "English", "dutch": "Dutch"})
    monkeypatch.setattr(runtime, "OUTPUT_LANGUAGE_KEYS", {"english", "dutch", "other"})
    monkeypatch.setattr(runtime, "MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH", 12)

    with app.app_context():
        assert parsing.parse_study_features("none") == "none"
        assert parsing.sanitize_output_language_pref_key("english") == "english"
