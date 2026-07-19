from pathlib import Path

from tests.runtime_test_support import get_test_core


core = get_test_core()


def _read(path):
    return Path(path).read_text(encoding='utf-8')


def test_unified_study_plan_contains_guided_views_and_reliable_states(client):
    response = client.get('/plan')
    assert response.status_code == 200
    html = response.get_data(as_text=True)

    assert '<title>Study Plan - Lecture Processor</title>' in html
    assert 'data-plan-view="today"' in html
    assert 'data-plan-view="schedule"' in html
    assert 'data-plan-view="progress"' in html
    assert 'data-wizard-step="1"' in html
    assert 'data-wizard-step="4"' in html
    assert 'id="study-plan-offline"' in html
    assert 'id="study-plan-save-state"' in html
    assert 'id="rebalance-card" hidden' in html
    assert 'id="calendar-feeds-overlay" hidden aria-hidden="true"' in html
    assert 'browser notifications' not in html.lower()


def test_study_plan_client_has_approval_rebalance_and_failed_save_rollback():
    script = _read('static/js/study-plan.js')

    assert "'/api/study-plan/preview'" in script
    assert "'/api/study-plan/apply'" in script
    assert "state.applyIdempotencyKey = randomId('idem')" in script
    assert 'idempotency_key: state.applyIdempotencyKey' in script
    assert "code: 'revision_conflict'" not in script  # conflicts are supplied by the server, not invented client-side
    assert "state.data.sessions = previous;" in script
    assert "Your visible change was undone." in script
    assert "state.online" in script
    assert "readCache()" in script
    assert "nothing moves until you accept it" in script
    assert 'notes_minutes_by_pack: wizardNotesMinutes(packIds)' in script
    assert 'data-notes-minutes' in script


def test_study_library_removes_duplicate_goals_and_adds_plan_actions():
    template = _read('templates/study.html')
    dialogs = _read('templates/_study_dialogs.html')
    script = _read('static/js/study.js')

    assert 'id="pack-goals-panel"' not in template
    assert 'id="overall-daily-goal-input"' not in template
    assert 'id="pack-daily-goal-input"' not in template
    assert 'id="add-pack-to-plan-btn"' in template
    assert 'id="add-selected-to-plan-btn"' in template
    assert '<input type="hidden" id="folder-exam-date-input">' in dialogs
    assert 'Add to Study Plan' in template
    assert "apiCall('/api/study-plan/membership')" in script
    assert "'/plan?add_packs='" in script
    assert 'plannerSessionFromUrl' in script
    assert "'/api/study-activity/sessions/'" in script


def test_study_plan_is_responsive_and_has_mobile_agenda():
    template = _read('templates/study_plan.html')
    styles = _read('static/css/study-plan.css')

    assert 'id="week-calendar"' in template
    assert 'id="mobile-agenda"' in template
    assert '@media (max-width: 980px)' in styles
    assert '.week-calendar { display: none; }' in styles
    assert '.mobile-agenda { display: grid;' in styles


def test_study_plan_v2_flag_keeps_legacy_pages_as_one_release_rollback(client, monkeypatch):
    monkeypatch.setattr(core, 'STUDY_PLAN_V2', False)

    plan = client.get('/plan')
    calendar = client.get('/calendar')
    stats = client.get('/stats')

    assert plan.status_code == 200
    assert 'Planning &amp; Progress' in plan.get_data(as_text=True)
    assert calendar.status_code == 200
    assert 'id="session-modal-overlay" hidden aria-hidden="true"' in calendar.get_data(as_text=True)
    assert stats.status_code == 200
