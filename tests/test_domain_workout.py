from copy import deepcopy

from lecture_processor.domains.workout import models


def _exercise_log(*, reps=(10, 10, 10), rpes=(8, 8.5, 9), completed=True, load=10, target_sets=3, rep_min=8, rep_max=10, last_rpe=9):
    return {
        'load_type': 'DB pair',
        'tracking_type': 'weight_reps',
        'pair_multiplier': 2,
        'target_sets': target_sets,
        'rep_min': rep_min,
        'rep_max': rep_max,
        'last_rpe': last_rpe,
        'sets': [
            {'type': 'normal', 'kg': load, 'reps': rep, 'rpe': rpe, 'completed': completed}
            for rep, rpe in zip(reps, rpes)
        ],
    }


def test_workout_seed_matches_selected_excel_contract():
    seed = models.load_seed()
    assert seed['source']['filename'] == 'dumbbell_hypertrofie_programma_slim.xlsx'
    assert seed['source']['sha256'] == '69364dddcdc1d2f502e36b0d215a3f46cb2aa6295ada8575638dd1eaf283e716'
    assert seed['integrity'] == {
        'program_rows': 60,
        'prescription_rows': 300,
        'start_tests': 10,
        'templates': 8,
        'weeks': 10,
        'scheduled_workouts': 40,
    }
    assert [len([row for row in seed['prescriptions'] if row['week'] == week]) for week in range(1, 11)] == [30] * 10
    assert seed['rest_mapping_seconds'] == {'1-2 min': 90, '2-3 min': 150, '3-4 min': 210}
    assert seed['available_loads']['dumbbell_per_hand_kg'] == [0, 2, 3, 5, 7, 8, 10, 12, 13, 15, 17, 18, 20]
    assert seed['available_loads']['backpack_kg'][-1] == 10
    assert seed['prescriptions'][0]['exercise_name'] == 'Weighted Pull-Up'


def test_cycle_builds_40_occurrences_and_exact_phase_boundaries():
    cycle, occurrences = models.build_cycle('admin-1', 'cycle-1', '2026-07-13', now_ts=0, routines=models.baseline_routines('admin-1'))
    assert cycle['start_monday'] == '2026-07-13'
    assert len(occurrences) == 40
    assert occurrences[0]['date'] == '2026-07-13'
    assert occurrences[3]['optional'] is True
    assert {item['phase'] for item in occurrences if item['week'] == 4} == {'Build'}
    assert {item['phase'] for item in occurrences if item['week'] == 5} == {'Semi-deload'}
    assert {item['phase'] for item in occurrences if item['week'] == 6} == {'Novelty'}

    _, custom_days = models.build_cycle(
        'admin-1',
        'cycle-2',
        '2026-07-13',
        now_ts=0,
        routines=models.baseline_routines('admin-1'),
        training_days={'A': 2, 'B': 4, 'C': 6, 'D': 7},
    )
    assert [item['date'] for item in custom_days[:4]] == ['2026-07-14', '2026-07-16', '2026-07-18', '2026-07-19']


def test_progression_rules_match_workbook_branches():
    assert models.progression_for_exercise(_exercise_log(completed=False), phase='Build')['next_action'] == 'Nog invullen'
    assert models.progression_for_exercise(_exercise_log(reps=(10, 10), rpes=(8, 9), target_sets=3), phase='Build')['next_action'] == 'Sets missen'
    assert models.progression_for_exercise(_exercise_log(), phase='Semi-deload')['next_action'] == 'Deload: techniek + herstel'
    increase = models.progression_for_exercise(_exercise_log(), phase='Build')
    assert increase['next_action'] == 'Verhoog load volgende keer'
    assert increase['suggested_next_kg'] == 12
    assert increase['flag'] == 'Groen'
    assert models.progression_for_exercise(_exercise_log(rpes=(7, 7, 7)), phase='Build')['next_action'] == 'Verhoog effort/tempo of load'
    lower = models.progression_for_exercise(_exercise_log(reps=(6, 7, 7)), phase='Build')
    assert lower['next_action'] == 'Te zwaar: verlaag load of mik op min reps'
    assert lower['flag'] == 'Load omlaag'
    assert models.progression_for_exercise(_exercise_log(reps=(8, 9, 9)), phase='Build')['next_action'] == 'Zelfde load: voeg reps toe'


def test_start_test_advice_and_available_load_rounding():
    assert models.start_test_advice(test_kg=12, test_reps=None, rep_min=8, rep_max=12, load_type='DB pair')['advice'] == 'Invullen na eerste test'
    assert models.start_test_advice(test_kg=12, test_reps=7, rep_min=8, rep_max=12, load_type='DB pair')['suggested_start_kg'] == 10
    assert models.start_test_advice(test_kg=12, test_reps=13, rep_min=8, rep_max=12, load_type='DB pair')['suggested_start_kg'] == 13
    assert models.start_test_advice(test_kg=20, test_reps=20, rep_min=8, rep_max=12, load_type='DB pair')['advice'] == 'Load capped: zwaardere variant/tempo/partials'
    assert models.warmup_sets(20, 'DB pair') == [
        {'percent': 40, 'reps': 10, 'kg': 8.0},
        {'percent': 60, 'reps': 5, 'kg': 12.0},
        {'percent': 80, 'reps': 3, 'kg': 15.0},
    ]


def test_equipment_aware_volume_and_epley_records():
    set_item = {'type': 'normal', 'kg': 10, 'reps': 10, 'completed': True}
    assert models.set_volume({'tracking_type': 'weight_reps', 'pair_multiplier': 2}, set_item, 62.5) == 200
    assert models.set_volume({'tracking_type': 'weight_reps', 'pair_multiplier': 1}, set_item, 62.5) == 100
    assert models.set_volume({'tracking_type': 'weighted_bodyweight', 'bodyweight_contributes': True}, set_item, 62.5) == 725
    assert models.set_volume({'tracking_type': 'assisted_bodyweight'}, set_item, 62.5) == 525
    assert round(models.epley_1rm(60, 10), 1) == 80.0


def test_warmup_statistics_setting_controls_set_count_and_volume():
    session = {
        'bodyweight_kg': 62.5,
        'phase': 'Build',
        'exercises': [{
            **_exercise_log(),
            'exercise_id': 'exercise-1',
            'exercise_name': 'Exercise',
        }],
    }
    session['exercises'][0]['sets'].insert(0, {'type': 'warmup', 'kg': 5, 'reps': 10, 'rpe': 0, 'completed': True})
    without = models.calculate_session(session)
    with_warmups = models.calculate_session(session, include_warmups=True)
    assert without['completed_sets'] == 3
    assert with_warmups['completed_sets'] == 4
    assert with_warmups['volume_kg'] == without['volume_kg'] + 100


def test_previous_values_can_be_scoped_to_same_routine_or_day():
    sessions = [
        {'status': 'completed', 'finished_at': '2026-07-01T10:00:00Z', 'routine_id': 'routine-a', 'day': 'A', 'exercises': [{'exercise_id': 'curl', 'sets': [{'completed': True, 'kg': 10, 'reps': 10, 'rpe': 9, 'type': 'normal'}]}]},
        {'status': 'completed', 'finished_at': '2026-07-02T10:00:00Z', 'routine_id': 'routine-b', 'day': 'B', 'exercises': [{'exercise_id': 'curl', 'sets': [{'completed': True, 'kg': 12, 'reps': 8, 'rpe': 9, 'type': 'normal'}]}]},
    ]
    same_routine = models.previous_values(sessions, reference={'routine_id': 'routine-a'}, scope='same_routine')
    any_workout = models.previous_values(sessions, reference={'routine_id': 'routine-a'}, scope='any_workout')
    assert same_routine['curl'][0]['kg'] == 10
    assert any_workout['curl'][0]['kg'] == 12


def test_adherence_excludes_optional_and_unscheduled_workouts():
    occurrences = [
        {'id': 'required-a', 'optional': False, 'date': '2020-01-01', 'week': 1, 'exercises': []},
        {'id': 'optional-d', 'optional': True, 'date': '2020-01-01', 'week': 1, 'exercises': []},
    ]
    sessions = [
        {'id': 's1', 'occurrence_id': 'required-a', 'status': 'completed', 'finished_at': '2020-01-01T10:00:00Z', 'exercises': []},
        {'id': 's2', 'occurrence_id': 'optional-d', 'status': 'completed', 'finished_at': '2020-01-01T11:00:00Z', 'optional': True, 'exercises': []},
        {'id': 's3', 'occurrence_id': '', 'status': 'completed', 'finished_at': '2020-01-01T12:00:00Z', 'exercises': []},
    ]
    stats = models.build_statistics(sessions, occurrences, [])
    assert stats['summary']['adherence_percent'] == 100
    assert stats['summary']['optional_d_completed'] == 1


def test_shares_remove_private_and_start_weight_fields():
    routine = deepcopy(models.baseline_routines('admin-1')[0])
    lookup = {item['id']: item for item in models.merged_exercises('admin-1', [])}
    routine_snapshot = models.routine_share_snapshot(routine, lookup)
    assert 'start_kg' not in routine_snapshot['exercises'][0]
    assert 'uid' not in routine_snapshot

    session = models.create_session_snapshot('admin-1', 'session-1', routine=routine, exercises_by_id=lookup, bodyweight_kg=62.5, now_ts=0)
    session['notes'] = 'private session note'
    session['exercises'][0]['notes'] = 'private exercise note'
    session['exercises'][0]['sets'][0].update({'completed': True, 'kg': 5, 'reps': 8, 'rpe': 9})
    snapshot = models.session_share_snapshot(session)
    serialized = str(snapshot)
    assert 'private' not in serialized
    assert 'bodyweight' not in serialized
    assert 'uid' not in serialized
