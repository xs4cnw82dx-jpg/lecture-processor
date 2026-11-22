from copy import deepcopy
from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.ai.providers.contracts import GenerationResult, Usage
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import runtime_jobs_repo, study_repo
from lecture_processor.services import job_state_service
from tests.credit_test_support import make_credit_runtime


def make_regeneration(monkeypatch):
    pack = {
        'uid': 'synthetic-owner',
        'title': 'Movement notes',
        'notes_markdown': 'Muscles contract and move joints.',
        'flashcards': [
            {'front': 'What is a muscle?', 'back': 'Original explanation', 'image_ids': ['muscle-image']},
            {'front': 'What is a joint?', 'back': 'Original joint explanation', 'image_ids': ['joint-image']},
        ],
        'test_questions': [
            {'question': 'Original question?', 'options': ['A', 'B', 'C', 'D'], 'answer': 'A', 'explanation': 'Original reason'},
        ],
        'flashcards_count': 2,
        'test_questions_count': 1,
        'study_features': 'both',
        'flashcard_selection': '30',
        'question_selection': '15',
        'updated_at': 10.0,
    }
    state = {
        'pack': pack,
        'updates': [],
        'refunds': [],
        'logs': [],
        'job': {
            'user_id': 'synthetic-owner',
            'status': 'queued',
            'study_pack_id': 'synthetic-pack',
            'study_features': 'both',
            'flashcard_selection': '20',
            'question_selection': '10',
            'study_tools_credit_cost': 1,
            'extra_slides_refunded': 0,
            'credit_refunded': False,
            'billing_receipt': {'charged': {'slides_credits': 1}, 'refunded': {}},
        },
    }

    runtime, credit_store = make_credit_runtime(
        users={'synthetic-owner': {'uid': 'synthetic-owner', 'account_status': 'active', 'slides_credits': 0}},
        unified_enabled=False,
    )
    runtime.__dict__.update(
        study_repo=study_repo, runtime_jobs_repo=runtime_jobs_repo,
        RUNTIME_JOBS_COLLECTION='runtime_jobs', RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS,
        job_state_service=job_state_service, jobs={}, JOBS_LOCK=RLock(),
        time=SimpleNamespace(time=lambda: 100.0),
        logger=SimpleNamespace(exception=lambda *_, **__: None, warning=lambda *_, **__: None),
        MODEL_STUDY='synthetic-study-model',
        PROMPT_STUDY_TEMPLATE='{source_text} {flashcard_amount} {question_amount} {output_language}',
        PROCESSING_PUBLIC_ERROR_MESSAGE='Processing could not finish. Please try again.',
        save_job_log=lambda *args, **_kwargs: state['logs'].append(deepcopy(args)),
    )

    def observe_commit(operations):
        for _operation, ref, fields, _merge in operations:
            if ref.path == ('study_packs', 'synthetic-pack'):
                state['updates'].append(deepcopy(fields))

    credit_store.after_commit = observe_commit

    refund_component = pipelines.job_charges.refund_component

    def refund(job, component_id, target_units, refund_ref, **kwargs):
        result = refund_component(job, component_id, target_units, refund_ref, **kwargs)
        if result:
            state['refunds'].append((job['user_id'], target_units, refund_ref, target_units))
        return result

    monkeypatch.setattr(pipelines.job_charges, 'refund_component', refund)

    def run(response, *, features='both'):
        state['job']['study_features'] = features
        credit_store.documents[('study_packs', 'synthetic-pack')] = deepcopy(state['pack'])
        runtime_jobs_store.set_job('synthetic-job', state['job'], runtime=runtime)

        def generate(*_args, **_kwargs):
            if isinstance(response, Exception):
                raise response
            return GenerationResult(response, None, Usage(12, 8, 20), 'gemini', runtime.MODEL_STUDY)

        monkeypatch.setattr(pipelines.study_generation.factory, 'open_provider_session',
                            lambda _runtime: SimpleNamespace(generate=generate, close=lambda: None))
        pipelines.regenerate_study_tools_for_pack('synthetic-job', 'synthetic-pack', runtime=runtime)
        state['pack'] = credit_store.docs('study_packs')['synthetic-pack']
        state['job'] = credit_store.docs('runtime_jobs')['synthetic-job']
        assert credit_store.docs('users')['synthetic-owner']['slides_credits'] == sum(item[1] for item in state['refunds'])

    return state, run
