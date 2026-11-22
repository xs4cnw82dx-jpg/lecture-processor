import json
import re
from threading import RLock, local
from types import SimpleNamespace

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.ai.providers.contracts import GenerationResult, Usage
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


def make_background():
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


def seed_regeneration(state):
    payload = {
        'user_id': 'owner', 'status': 'queued', 'study_features': 'both',
        'mode': 'voice-note-study-tools', 'job_scope': 'study', 'study_pack_id': 'pack',
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
    transaction_context = local()
    transactional = state.runtime.firestore.transactional

    def tracked_transactional(callback):
        def tracked(*args, **kwargs):
            transaction_context.active = True
            try:
                return callback(*args, **kwargs)
            finally:
                transaction_context.active = False
        return transactional(tracked)

    def generate(*_args, **_kwargs):
        assert not getattr(transaction_context, 'active', False), 'Provider work must stay outside transactions'
        calls.append(True)
        while_generating()
        if fail:
            raise RuntimeError('Synthetic provider failure')
        return GenerationResult(
            json.dumps({
                'flashcards': [{'front': 'What is original?', 'back': 'Generated answer'}],
                'test_questions': [question('generated')],
            }),
            None, Usage(12, 8, 20), 'gemini', state.runtime.MODEL_STUDY,
        )

    monkeypatch.setattr(pipelines.study_generation.factory, 'open_provider_session',
                        lambda _runtime: SimpleNamespace(generate=generate, close=lambda: None))
    monkeypatch.setattr(state.runtime.firestore, 'transactional', tracked_transactional)
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
    assert calls == [True], 'The interleaving must occur during real material generation'


def canonical_job(state):
    return state.store.docs('runtime_jobs').get('regenerate')


def writes_generated_pack(operations):
    return any(
        ref.path == ('study_packs', 'pack') and payload and 'flashcards' in payload
        for _operation, ref, payload, _merge in operations
    )
