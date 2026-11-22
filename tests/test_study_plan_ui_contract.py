from pathlib import Path

from tests.runtime_test_support import get_test_core


core = get_test_core()


def _read(path):
    return Path(path).read_text(encoding='utf-8')


def test_unified_study_plan_contains_guided_views_and_reliable_states(client):
    response = client.get('/plan')
    assert response.status_code == 200
    html = response.get_data(as_text=True)

    assert '<title>Study Plan · Lecture Processor</title>' in html
    assert 'data-plan-view="today"' in html
    assert 'data-plan-view="schedule"' in html
    assert 'data-plan-view="progress"' in html
    assert 'data-wizard-step="1"' in html
    assert 'data-wizard-step="4"' in html
    assert 'id="study-plan-offline"' in html
    assert 'id="study-plan-save-state" role="status" aria-live="polite" hidden' in html
    assert 'id="rebalance-card" hidden' in html
    assert 'id="calendar-feeds-overlay" hidden aria-hidden="true"' in html
    assert 'browser notifications' not in html.lower()


def test_study_plan_uses_polished_native_controls_and_actionable_empty_states():
    template = _read('templates/study_plan.html')

    assert 'data-plan-picker="date"' in template
    assert 'data-plan-picker="time"' in template
    assert 'data-app-select' in template
    assert 'data-pretty-select' not in template
    assert 'data-pack-filter="flashcards"' in template
    assert '.btn, .primary-btn, .secondary-btn, .ghost-btn {' in _read('static/css/shared-ui.css')


def test_study_library_removes_duplicate_goals_and_adds_plan_actions():
    template = _read('templates/study.html')
    dialogs = _read('templates/_study_dialogs.html')

    assert 'id="pack-goals-panel"' not in template
    assert 'id="overall-daily-goal-input"' not in template
    assert 'id="pack-daily-goal-input"' not in template
    assert 'id="add-pack-to-plan-btn"' in template
    assert 'id="add-selected-to-plan-btn"' in template
    assert '<input type="hidden" id="folder-exam-date-input">' in dialogs
    assert 'Add to Study Plan' in template


def test_study_plan_is_responsive_and_has_mobile_agenda():
    template = _read('templates/study_plan.html')

    assert 'id="week-calendar"' in template
    assert 'id="mobile-agenda"' in template
