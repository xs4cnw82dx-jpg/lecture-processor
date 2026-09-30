from datetime import date

from lecture_processor.domains.planner import study_plan


def test_new_planners_do_not_assume_weekday_evening_availability():
    assert study_plan.sanitize_preferences({})['availability'] == []


def _preferences(timezone='Europe/Amsterdam', availability=None, duration=45):
    return {
        'timezone': timezone,
        'availability': availability if availability is not None else [
            {'weekday': weekday, 'start': '18:00', 'end': '20:00'}
            for weekday in range(7)
        ],
        'default_session_minutes': duration,
    }


def _goal(exam_date='2026-03-30'):
    return {
        'goal_id': 'goal_test',
        'title': 'Final exam',
        'exam_date': exam_date,
        'pack_ids': ['pack_test'],
    }


def test_mixed_card_question_and_notes_workloads_use_expected_fallback_pace():
    mixed = study_plan.build_pack_workload(
        {'study_pack_id': 'pack_mix', 'title': 'Mixed', 'flashcards_count': 20, 'test_questions_count': 10},
        {'fc_0': {'level': 3}, 'q_0': {'correct': 2, 'wrong': 0}},
        today='2026-03-01',
    )
    notes = study_plan.build_pack_workload(
        {'study_pack_id': 'pack_notes', 'title': 'Notes', 'flashcards_count': 0, 'test_questions_count': 0},
        notes_minutes=60,
        completed_notes_minutes=15,
        today='2026-03-01',
    )

    assert mixed['cards_remaining'] == 19
    assert mixed['questions_remaining'] == 9
    assert mixed['total_minutes'] == 43  # ceil((19 + 18) * 1.15)
    assert notes['notes_minutes'] == 45
    assert notes['total_minutes'] == 52


def test_personal_pace_requires_enough_history_and_then_scales_both_outcomes():
    fallback = study_plan.estimate_personal_pace([
        {'metrics': {'minutes': 10, 'cards_reviewed': 5}},
        {'metrics': {'minutes': 10, 'questions_answered': 3}},
    ])
    personalized = study_plan.estimate_personal_pace([
        {'metrics': {'minutes': 12, 'cards_reviewed': 10}},
        {'metrics': {'minutes': 12, 'cards_reviewed': 10}},
        {'metrics': {'minutes': 12, 'questions_answered': 5}},
    ])

    assert fallback == {'card_minutes': 1.0, 'question_minutes': 2.0, 'personalized': False}
    assert personalized['personalized'] is True
    assert personalized['question_minutes'] == personalized['card_minutes'] * 2


def test_schedule_is_deterministic_and_spreads_sessions_to_the_day_before_exam():
    workload = {'pack_id': 'pack_test', 'title': 'Biology', 'due_cards': 10, 'cards_remaining': 30, 'questions_remaining': 30, 'total_minutes': 104}
    kwargs = dict(
        goal=_goal('2026-03-08'),
        pack_workloads=[workload],
        preferences=_preferences(duration=45),
        start_date='2026-03-01',
        proposal_id='proposal_12345',
    )

    first = study_plan.generate_schedule(**kwargs)
    second = study_plan.generate_schedule(**kwargs)

    assert first == second
    assert len(first['sessions']) == 3
    assert first['sessions'][0]['date'] == '2026-03-01'
    assert first['sessions'][-1]['date'] == '2026-03-07'
    assert first['shortage_minutes'] == 0


def test_over_capacity_and_no_availability_report_shortage_without_overbooking():
    workload = {'pack_id': 'pack_test', 'title': 'Biology', 'cards_remaining': 300, 'questions_remaining': 0, 'total_minutes': 345}
    limited = study_plan.generate_schedule(
        goal=_goal('2026-03-02'),
        pack_workloads=[workload],
        preferences=_preferences(availability=[{'weekday': 6, 'start': '18:00', 'end': '19:00'}], duration=45),
        start_date='2026-03-01',
        proposal_id='proposal_limit',
    )
    unavailable = study_plan.generate_schedule(
        goal=_goal('2026-03-08'),
        pack_workloads=[workload],
        preferences=_preferences(availability=[]),
        start_date='2026-03-01',
        proposal_id='proposal_none',
    )

    assert limited['capacity_minutes'] == 45
    assert limited['scheduled_minutes'] == 45
    assert limited['shortage_minutes'] == 301  # 261 remaining cards, including the pacing buffer.
    assert unavailable['sessions'] == []
    assert unavailable['shortage_minutes'] == 345


def test_locked_or_manual_occupied_sessions_are_never_reused():
    occupied = [{'id': 'legacy_locked', 'date': '2026-03-02', 'time': '18:00', 'duration': 45, 'status': 'planned', 'locked': True}]
    slots = study_plan.build_available_slots(
        start_date='2026-03-02',
        exam_date='2026-03-03',
        preferences=_preferences(availability=[{'weekday': 0, 'start': '18:00', 'end': '20:00'}], duration=45),
        occupied=occupied,
    )

    assert [slot['time'] for slot in slots] == ['19:00']


def test_past_exam_returns_no_slots_and_dst_conversion_is_utc_safe():
    assert study_plan.build_available_slots(
        start_date='2026-03-10',
        exam_date='2026-03-10',
        preferences=_preferences(),
    ) == []

    before_dst = study_plan.build_available_slots(
        start_date='2026-03-28',
        exam_date='2026-03-29',
        preferences=_preferences(availability=[{'weekday': date(2026, 3, 28).weekday(), 'start': '19:00', 'end': '20:00'}]),
    )[0]
    after_dst = study_plan.build_available_slots(
        start_date='2026-03-29',
        exam_date='2026-03-30',
        preferences=_preferences(availability=[{'weekday': date(2026, 3, 29).weekday(), 'start': '19:00', 'end': '20:00'}]),
    )[0]

    assert before_dst['starts_at_utc'].endswith('18:00:00Z')
    assert after_dst['starts_at_utc'].endswith('17:00:00Z')


def test_today_slots_exclude_elapsed_local_times_using_an_aware_cutoff():
    from datetime import datetime, timezone

    slots = study_plan.build_available_slots(
        start_date='2026-09-30', exam_date='2026-10-01',
        preferences=_preferences(availability=[{'weekday': 2, 'start': '09:00', 'end': '20:00'}]),
        now=datetime(2026, 9, 30, 16, 30, tzinfo=timezone.utc),
    )
    assert [slot['time'] for slot in slots] == ['19:00']
    assert slots[0]['starts_at_utc'] == '2026-09-30T17:00:00Z'


def test_scheduling_cutoff_preserves_local_next_day_and_utc_order():
    from datetime import datetime, timezone

    slots = study_plan.build_available_slots(
        start_date='2026-10-01', exam_date='2026-10-02',
        preferences=_preferences(availability=[{'weekday': 3, 'start': '00:00', 'end': '02:00'}]),
        now=datetime(2026, 9, 30, 22, 30, tzinfo=timezone.utc),
    )
    assert [slot['time'] for slot in slots] == ['01:00']
    assert slots[0]['starts_at_utc'] == '2026-09-30T23:00:00Z'


def test_two_small_packs_both_receive_sessions_when_combined_work_fits_one_slot():
    workloads = [study_plan.build_pack_workload({'study_pack_id': pack_id, 'title': pack_id, 'flashcards_count': 10})
                 for pack_id in ['pack_alpha', 'pack_beta']]
    result = study_plan.generate_schedule(
        goal=_goal('2026-03-08'), pack_workloads=workloads,
        preferences=_preferences(), start_date='2026-03-01', proposal_id='proposal_small',
    )
    assert [session['pack_id'] for session in result['sessions']] == ['pack_alpha', 'pack_beta']
    assert [session['planned_outcomes']['flashcards'] for session in result['sessions']] == [10, 10]
    assert result['shortage_minutes'] == 0


def test_question_remainders_are_scheduled_without_empty_sessions_or_false_completion():
    workload = study_plan.build_pack_workload({'study_pack_id': 'pack_test', 'test_questions_count': 40})
    result = study_plan.generate_schedule(
        goal=_goal('2026-03-08'), pack_workloads=[workload],
        preferences=_preferences(), start_date='2026-03-01', proposal_id='proposal_remainder',
    )
    assert [session['planned_outcomes']['questions'] for session in result['sessions']] == [19, 19, 2]
    assert all(any(session['planned_outcomes'].values()) for session in result['sessions'])
    assert all(5 <= session['duration'] <= 45 for session in result['sessions'])
    assert result['shortage_minutes'] == 0


def test_personalized_pace_and_mixed_pack_outcomes_are_conserved():
    for card_pace, question_pace in [(0.35, 0.7), (1, 2), (2.3, 4.6), (5, 10)]:
        workload = study_plan.build_pack_workload(
            {'study_pack_id': 'pack_test', 'flashcards_count': 13, 'test_questions_count': 17},
            card_minutes=card_pace, question_minutes=question_pace,
        )
        result = study_plan.generate_schedule(
            goal=_goal('2026-03-30'), pack_workloads=[workload],
            preferences=_preferences(duration=15), start_date='2026-03-01',
        )
        assert sum(item['planned_outcomes']['flashcards'] for item in result['sessions']) == 13
        assert sum(item['planned_outcomes']['questions'] for item in result['sessions']) == 17
        assert all(5 <= item['duration'] <= 15 for item in result['sessions'])
        assert result['shortage_minutes'] == 0


def test_limited_capacity_reports_remaining_questions_even_after_rounding():
    workload = study_plan.build_pack_workload({'study_pack_id': 'pack_test', 'test_questions_count': 40})
    result = study_plan.generate_schedule(
        goal=_goal('2026-03-02'), pack_workloads=[workload],
        preferences=_preferences(availability=[{'weekday': 6, 'start': '18:00', 'end': '20:00'}]),
        start_date='2026-03-01',
    )
    assert sum(item['planned_outcomes']['questions'] for item in result['sessions']) == 38
    assert result['shortage_minutes'] == 5  # Two questions remain, not an empty five-minute session.


def test_notes_only_workload_preserves_all_requested_minutes():
    workload = study_plan.build_pack_workload({'study_pack_id': 'pack_test'}, notes_minutes=80)
    result = study_plan.generate_schedule(
        goal=_goal('2026-03-08'), pack_workloads=[workload],
        preferences=_preferences(), start_date='2026-03-01',
    )
    assert sum(item['planned_outcomes']['notes_minutes'] for item in result['sessions']) == 80
    assert result['shortage_minutes'] == 0
