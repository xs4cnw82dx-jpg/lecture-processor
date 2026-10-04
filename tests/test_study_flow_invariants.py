"""Cross-mode invariants: selecting another viewer must not erase earned work."""
from tests.test_study_runs import create_session, checkpoint
from tests.test_study_plan_api import core, study_plan_runtime, _headers  # noqa: F401


def choose(client, mode, **options):
    response = client.post('/api/study-plan/items/session_run/run', headers=_headers(),
                           json={'study_mode': mode, **options})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def test_every_viewer_retains_first_answers_and_timing_across_mode_switches(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    study_plan_runtime['pack']['notes_markdown'] = '# Read and recall'
    result = choose(client, 'write', timer_mode='pomodoro')
    run = checkpoint(client, result['run'], {'fc_0': {'correct': False}}, 60)
    for mode in ('match', 'notes', 'test', 'flashcards', 'review', 'write'):
        result = choose(client, mode, timer_mode='countdown')
        switched = result['run']
        assert switched['activity_id'] == run['activity_id']
        assert switched['answers']['fc_0'] == {'type': 'fc', 'correct': False}
        assert switched['slot_seconds'] == switched['active_seconds'] == 60
        assert switched['timer_mode'] == 'pomodoro'
        assert switched['metrics']['cards_reviewed'] == 1
        assert switched['metrics']['incorrect'] == 1
        assert len({item['id'] for item in switched['queue']}) == len(switched['queue'])
        # Returning to a different viewer cannot mark the original work complete.
        finish = client.post('/api/study-plan/items/session_run/completion', headers=_headers(),
                             json={'source': 'tracked', 'revision': result['session']['revision']})
        assert finish.status_code == 400


def test_switching_from_questions_keeps_original_unanswered_card_targets(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    result = choose(client, 'test')
    checkpoint(client, result['run'], {'q_0': {'correct': True}}, 30)
    result = choose(client, 'flashcards')
    assert result['run']['answers'] == {'q_0': {'type': 'q', 'correct': True}}
    assert {item['id'] for item in result['run']['queue']} >= {'q_0', 'fc_0', 'fc_1'}
    finish = client.post('/api/study-plan/items/session_run/completion', headers=_headers(),
                         json={'source': 'tracked', 'revision': result['session']['revision']})
    assert finish.status_code == 400
    saved = checkpoint(client, result['run'], {'fc_0': {'correct': True}, 'fc_1': {'correct': True}}, 90)
    assert saved['metrics']['cards_reviewed'] == 2
    assert saved['metrics']['questions_answered'] == 1
    finish = client.post('/api/study-plan/items/session_run/completion', headers=_headers(),
                         json={'source': 'tracked', 'revision': result['session']['revision']})
    assert finish.status_code == 200
    assert finish.get_json()['session']['completion']['reason'] == 'targets_met'


def test_old_viewer_cannot_overwrite_a_new_mode_even_with_higher_local_revision(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    original = choose(client, 'write')['run']
    switched = choose(client, 'test')['run']
    stale = dict(original, checkpoint_revision=switched['checkpoint_revision'] + 50,
                 answers={'fc_0': {'correct': True}})
    response = client.put('/api/study-plan/runs/' + original['activity_id'], headers=_headers(), json=stale)
    assert response.status_code == 409
    saved = core.planner_repo.get_study_activity(None, study_plan_runtime['uid'], original['activity_id']).to_dict()
    assert saved['study_mode'] == 'test'
    assert saved['answers'] == {}
