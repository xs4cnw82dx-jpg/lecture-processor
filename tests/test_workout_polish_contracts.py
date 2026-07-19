from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_workout_template_keeps_accessibility_and_pwa_controls_visible_to_code():
    template = _read("templates/workout.html")

    assert "maximum-scale=1" not in template
    assert 'id="workout-routine-count"' in template
    assert 'id="workout-install-btn"' in template
    assert 'id="workout-update-btn"' in template
    assert 'id="workout-manage-shares"' in template
    assert "changes will sync automatically" not in template


def test_workout_ui_source_contains_recoverable_async_and_accessible_dialog_flows():
    source = _read("static/js/workout.js")

    assert "openModalOverlay" in source
    assert "closeModalOverlay" in source
    assert "aria-busy" in source
    assert "AbortError" in source
    assert "beforeinstallprompt" in source
    assert ".slice(0, 5)" not in source
    assert ".slice(0,5)" not in source


def test_offline_finish_uses_effective_connectivity_and_does_not_resurrect_draft():
    source = _read("static/js/workout.js")
    finish_flow = source.split("function finishWorkout()", 1)[1].split("function discardWorkout()", 1)[0]

    assert "if (!isOnline())" in finish_flow
    assert "state.data.active_session = null" in finish_flow
    assert "state.activeSession = null" in finish_flow
    assert "saveBootstrap(state.data)" in finish_flow
    assert finish_flow.index("state.activeSession = null") < finish_flow.index("closeLogger()")


def test_workout_service_worker_caches_only_a_successful_workout_shell():
    source = _read("static/workout-service-worker.js")

    assert "response.ok" in source
    assert "response.redirected" in source
    assert "WORKOUT_SHELL" in source
    assert "cache: 'no-store'" in source
    assert "CACHE_WORKOUT_SHELL" in source
    assert "credentials: 'same-origin'" in source


def test_workout_styles_include_keyboard_focus_and_readable_supporting_text():
    source = _read("static/css/workout.css")

    assert ":focus-visible" in source
    assert "body-scroll-locked" in _read("static/css/shared-ui.css") or "body-scroll-locked" in source
    assert "font-size: 8px" not in source
    assert "font-size: 9px" not in source
