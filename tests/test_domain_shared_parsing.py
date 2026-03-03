from lecture_processor.domains.shared import parsing
from lecture_processor.runtime.container import get_runtime


def test_shared_parsing_dispatch_uses_explicit_runtime():
    class _Runtime:
        def parse_requested_amount(self, raw, allowed, default):
            return f"amount:{raw}:{default}:{len(allowed)}"

        def parse_study_features(self, raw):
            return f"study:{raw}"

        def normalize_output_language_choice(self, key, custom=""):
            return (key, custom)

        def parse_output_language(self, key, custom=""):
            return f"lang:{key}:{custom}"

        def sanitize_output_language_pref_key(self, raw):
            return str(raw).strip().lower()

        def sanitize_output_language_pref_custom(self, raw):
            return str(raw).strip()

        def build_user_preferences_payload(self, user):
            return {"uid": user.get("uid")}

        def parse_interview_features(self, raw):
            return [str(raw)]

    runtime = _Runtime()
    assert parsing.parse_requested_amount("20", {"10", "20"}, "10", runtime=runtime) == "amount:20:10:2"
    assert parsing.parse_study_features("both", runtime=runtime) == "study:both"
    assert parsing.normalize_output_language_choice("english", "EN", runtime=runtime) == ("english", "EN")
    assert parsing.parse_output_language("other", "Italian", runtime=runtime) == "lang:other:Italian"
    assert parsing.sanitize_output_language_pref_key(" Dutch ", runtime=runtime) == "dutch"
    assert parsing.sanitize_output_language_pref_custom("  Italiano  ", runtime=runtime) == "Italiano"
    assert parsing.build_user_preferences_payload({"uid": "u1"}, runtime=runtime) == {"uid": "u1"}
    assert parsing.parse_interview_features("summary", runtime=runtime) == ["summary"]


def test_shared_parsing_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "parse_study_features", lambda raw: f"core:{raw}")
    monkeypatch.setattr(runtime.core, "sanitize_output_language_pref_key", lambda raw: f"key:{raw}")

    with app.app_context():
        assert parsing.parse_study_features("none") == "core:none"
        assert parsing.sanitize_output_language_pref_key("english") == "key:english"
