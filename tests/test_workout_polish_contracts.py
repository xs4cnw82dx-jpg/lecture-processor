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
