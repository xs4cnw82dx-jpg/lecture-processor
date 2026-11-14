"""Background pack writes with deterministic interleavings and synthetic storage."""

from copy import deepcopy
import json
import re
from threading import RLock
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import runtime_jobs_repo, study_repo
from lecture_processor.services import job_state_service
from tests.credit_test_support import make_credit_runtime


def question(label):
    return {
        'question': f'Which item is {label}?', 'options': ['A', 'B', 'C', 'D'],
        'answer': 'A', 'explanation': f'Explanation for {label}',
    }


@pytest.fixture
def background():
    def make(scheme='unified'):
        user = {'uid': 'owner', 'account_status': 'active', 'total_processed': 0}
        user.update({'credits_version': 2, 'credits': 100} if scheme == 'unified' else {'slides_credits': 0})
        runtime, store = make_credit_runtime(users={'owner': user}, unified_enabled=scheme == 'unified')
        runtime.__dict__.update(
            study_repo=study_repo, repositories=SimpleNamespace(study=study_repo),
            runtime_jobs_repo=runtime_jobs_repo, RUNTIME_JOBS_COLLECTION='runtime_jobs',
            RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS,
            job_state_service=job_state_service, jobs={}, JOBS_LOCK=RLock(), re=re,
            FEATURE_AUDIO_SECTION_SYNC=False, MODEL_STUDY='synthetic-study-model',
            PROMPT_STUDY_TEMPLATE='{source_text} {flashcard_amount} {question_amount} {output_language}',
            PROCESSING_PUBLIC_ERROR_MESSAGE='Processing could not finish. Please try again.',
            save_job_log=lambda *_args, **_kwargs: None,
        )
        store.documents[('study_packs', 'pack')] = {
            'uid': 'owner', 'mode': 'voice-note', 'title': 'Original title',
            'notes_markdown': '# Original notes',
            'flashcards': [{'front': 'What is original?', 'back': 'Original answer'}],
            'test_questions': [question('original')], 'audio_sessions': [],
            'flashcards_count': 1, 'test_questions_count': 1, 'study_features': 'both',
            'updated_at': 100.0,
        }
        store.documents[('study_pack_sources', 'pack')] = {
            'study_pack_id': 'pack', 'uid': 'owner', 'mode': 'voice-note',
            'transcript': 'Original transcript', 'has_source_transcript': True, 'created_at': 100.0,
        }
        return SimpleNamespace(runtime=runtime, store=store, scheme=scheme)
    return make


def pack(state):
    return state.store.docs('study_packs')['pack']


def source(state):
    return state.store.docs('study_pack_sources')['pack']


def seed_regeneration(state):
    payload = {
        'user_id': 'owner', 'status': 'queued', 'study_features': 'both',
        'flashcard_selection': '20', 'question_selection': '10',
        'study_tools_credit_cost': 1, 'extra_slides_refunded': 0, 'credit_refunded': False,
    }
    if state.scheme == 'unified':
        job_charges.admit_runtime_job(
            'owner', 'regenerate', 'study-tools',
            {'extras': {'action': 'regenerate_study_tools', 'units': 1}}, runtime=state.runtime,
        )
        job_charges.set_admitted_job('regenerate', payload, runtime=state.runtime)
        assert state.store.docs('users')['owner']['credits'] == 98
    else:
        # A historical job already spent its one slides credit before this test starts.
        payload['billing_receipt'] = {'charged': {'slides_credits': 1}, 'refunded': {}}
        runtime_jobs_store.set_job('regenerate', payload, runtime=state.runtime)


def run_regeneration(state, monkeypatch, while_generating=lambda: None, *, fail=False):
    calls = []

    def generate(*_args, **_kwargs):
        calls.append(True)
        while_generating()
        if fail:
            raise RuntimeError('Synthetic provider failure')
        return SimpleNamespace(
            text=json.dumps({
                'flashcards': [{'front': 'What is original?', 'back': 'Generated answer'}],
                'test_questions': [question('generated')],
            }),
            usage_metadata=SimpleNamespace(prompt_token_count=12, candidates_token_count=8, total_token_count=20),
        )

    monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', generate)
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
    assert calls == [True], 'The interleaving must occur during real material generation'


def assert_refunded_once(state):
    job = runtime_jobs_store.get_job_snapshot('regenerate', runtime=state.runtime)
    balance_field, expected_balance = ('credits', 100) if state.scheme == 'unified' else ('slides_credits', 1)
    assert {
        'status': job['status'], 'refunded': job['credit_refunded'],
        'balance': state.store.docs('users')['owner'][balance_field],
        'refund_records': len(state.store.docs('credit_refunds')),
    } == {'status': 'error', 'refunded': True, 'balance': expected_balance, 'refund_records': 1}
    if state.scheme == 'unified':
        assert job['billing_receipt']['refunded_credits'] == job['billing_receipt']['charged_credits'] == 2
    else:
        assert job['billing_receipt']['refunded'] == {'slides_credits': 1}
    before = state.store.docs('users'), state.store.docs('credit_refunds')
    assert job_charges.refund_component(
        job, 'extras', 1, 'runtime-job:regenerate:extras',
        legacy_credit_type='slides_credits', legacy_charged_units=1, runtime=state.runtime,
    )
    assert (state.store.docs('users'), state.store.docs('credit_refunds')) == before


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('changed', ['cards', 'notes', 'pictures'])
def test_regeneration_preserves_a_content_edit_committed_during_generation(background, monkeypatch, scheme, changed):
    state = background(scheme)
    seed_regeneration(state)
    expected = []

    def edit():
        current = pack(state)
        if changed == 'notes':
            fields = {'notes_markdown': '# The owner has revised these notes'}
        else:
            cards = current['flashcards']
            if changed == 'cards':
                cards[0]['back'] = 'The owner has revised this answer'
            else:
                cards[0]['image_ids'] = ['a' * 64]
            fields = {'flashcards': cards}
        study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update(fields)
        expected.append(pack(state))

    run_regeneration(state, monkeypatch, edit)

    assert pack(state) == expected[0]
    assert_refunded_once(state)


def test_regeneration_rejects_a_changed_fallback_source(background, monkeypatch):
    state = background()
    state.store.documents[('study_packs', 'pack')]['notes_markdown'] = ''
    original = pack(state)
    seed_regeneration(state)

    def edit():
        study_repo.study_pack_source_doc_ref(state.runtime.db, 'pack').update({'transcript': 'Revised source transcript'})

    run_regeneration(state, monkeypatch, edit)

    assert pack(state) == original
    assert source(state)['transcript'] == 'Revised source transcript'
    assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('metadata_change', [False, True], ids=['unchanged', 'metadata'])
def test_regeneration_succeeds_with_unchanged_content(background, monkeypatch, scheme, metadata_change):
    state = background(scheme)
    seed_regeneration(state)

    def edit():
        if metadata_change:
            study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update({
                'title': 'Revised title', 'pinned': True, 'updated_at': state.store.now + 1,
            })

    run_regeneration(state, monkeypatch, edit)

    saved = pack(state)
    assert saved['flashcards'][0]['back'] == 'Generated answer'
    assert saved['test_questions'] == [question('generated')]
    assert saved['title'] == ('Revised title' if metadata_change else 'Original title')
    assert runtime_jobs_store.get_job_snapshot('regenerate', runtime=state.runtime)['status'] == 'complete'
    assert not state.store.docs('credit_refunds')
    balance_field, expected_balance = ('credits', 98) if scheme == 'unified' else ('slides_credits', 0)
    assert state.store.docs('users')['owner'][balance_field] == expected_balance


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_provider_failure_preserves_pack_and_refunds_once(background, monkeypatch, scheme):
    state = background(scheme)
    original = pack(state)
    seed_regeneration(state)

    run_regeneration(state, monkeypatch, fail=True)

    assert pack(state) == original
    assert_refunded_once(state)


def voice_job(name):
    return {
        'user_id': 'owner', 'status': 'processing', 'voice_note_append_to_pack_id': 'pack',
        'study_pack_title': name, 'result': f'# Notes from {name}', 'transcript': f'Transcript from {name}',
        'flashcards': [{'front': f'What is {name}?', 'back': f'Answer from {name}'}],
        'test_questions': [question(name)], 'audio_storage_key': f'study_audio/{name}.webm',
        'started_at': 1000.0, 'study_features': 'both',
    }


def interleave_voice_preparation(monkeypatch, callback):
    original = pipelines._demote_markdown_headings
    fired = []

    def prepare(markdown, runtime=None):
        if not fired:
            fired.append(True)
            callback()
        return original(markdown, runtime=runtime)

    monkeypatch.setattr(pipelines, '_demote_markdown_headings', prepare)
    return fired


def assert_voice_content(state, names, *, original_notes='# Original notes', original_answer='Original answer'):
    saved, transcript = pack(state), source(state)['transcript']
    assert saved['notes_markdown'].startswith(original_notes)
    assert saved['flashcards'][0]['back'] == original_answer
    assert {card['back'] for card in saved['flashcards'][1:]} == {f'Answer from {name}' for name in names}
    assert {item['question'] for item in saved['test_questions'][1:]} == {question(name)['question'] for name in names}
    assert [item['session_id'] for item in saved['audio_sessions']] == names
    for name in names:
        assert saved['notes_markdown'].count(f'Notes from {name}') == 1
        assert transcript.count(f'Transcript from {name}') == 1
    assert transcript.startswith('Original transcript')


def test_overlapping_voice_appends_keep_both_content_and_source(background, monkeypatch):
    state = background()
    first, second = voice_job('first'), voice_job('second')
    fired = interleave_voice_preparation(
        monkeypatch, lambda: pipelines._append_voice_note_to_existing_pack('second', second, runtime=state.runtime),
    )

    assert pipelines._append_voice_note_to_existing_pack('first', first, runtime=state.runtime)

    assert fired == [True]
    assert_voice_content(state, ['second', 'first'])


def test_voice_append_composes_with_a_manual_content_edit(background, monkeypatch):
    state = background()

    def edit():
        cards = pack(state)['flashcards']
        cards[0]['back'] = 'Revised original answer'
        study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update({
            'notes_markdown': '# Revised original notes', 'flashcards': cards,
        })

    fired = interleave_voice_preparation(monkeypatch, edit)

    assert pipelines._append_voice_note_to_existing_pack('first', voice_job('first'), runtime=state.runtime)

    assert fired == [True]
    assert_voice_content(state, ['first'], original_notes='# Revised original notes', original_answer='Revised original answer')


def test_replaying_a_committed_voice_append_does_not_duplicate_notes_or_source(background):
    state = background()
    job = voice_job('first')
    assert pipelines._append_voice_note_to_existing_pack('first', job, runtime=state.runtime)
    original = pack(state), source(state)

    assert pipelines._append_voice_note_to_existing_pack('first', deepcopy(job), runtime=state.runtime)

    assert (pack(state), source(state)) == original
    assert_voice_content(state, ['first'])


@pytest.mark.parametrize('metadata_change', [False, True], ids=['unchanged', 'metadata'])
def test_voice_append_succeeds_without_a_content_conflict(background, monkeypatch, metadata_change):
    state = background()
    if metadata_change:
        interleave_voice_preparation(
            monkeypatch, lambda: study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update({
                'title': 'Revised title', 'updated_at': state.store.now + 1,
            }),
        )

    assert pipelines._append_voice_note_to_existing_pack('first', voice_job('first'), runtime=state.runtime)

    assert_voice_content(state, ['first'])
    assert pack(state)['title'] == ('Revised title' if metadata_change else 'Original title')
