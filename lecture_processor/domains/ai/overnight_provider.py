"""Normal provider requests for selected document stages of an overnight batch."""
from functools import partial

from . import provider as ai_provider
from .providers import factory
from .providers.contracts import TextPart


MODE_STAGES = {
    'lecture-notes': ('slides_extraction', 'notes_merge', 'study_tools'),
    'slides-only': ('slides_extraction', 'study_tools'),
    'text-combine': ('text_combine',),
    'interview': ('interview_summary', 'interview_sections'),
}
STAGE_ROUTES = {
    'slide_extraction': 'slides_extraction',
    'notes_merge': 'notes_merge',
    'study_materials_generation': 'study_tools',
    'interview_summary_generation': 'interview_summary',
    'interview_sections_generation': 'interview_sections',
}


def enabled(runtime, stage):
    snapshot = getattr(runtime, 'AI_ROUTING_SNAPSHOT', None)
    route = snapshot.routes.get(stage) if snapshot is not None else None
    return route is not None and route.provider == 'openrouter'


def uses_private_stages(runtime, mode):
    return any(enabled(runtime, stage) for stage in MODE_STAGES.get(mode, ()))


def _write(batch_id, worker_id, payload, runtime, *, claim=False, row_id=None):
    """Atomically fence every private write, including the claim before the first request."""
    from . import batch_orchestrator as batch

    def allowed(parent, row):
        if not parent:
            return False
        if claim:
            return (parent.get('status') == 'queued' and not parent.get('overnight_worker_id')
                    and not parent.get('overnight_recovery_started_at')
                    and parent.get('credit_admission_state') != 'pending'
                    and not batch._batch_is_stale(parent, runtime=runtime))
        if (parent.get('overnight_worker_id') != worker_id or parent.get('overnight_recovery_started_at')
                or parent.get('status') not in batch.ACTIVE_BATCH_STATUSES):
            return False
        return row_id is None or (bool(row) and row.get('status') in batch.ACTIVE_ROW_STATUSES
                                  and row.get('uid', parent.get('uid')) == parent.get('uid'))

    if getattr(runtime, 'db', None) is None:
        with batch._BATCH_ACTIVITY_LOCK:
            parent = batch._get_batch(batch_id, runtime=runtime)
            row = batch._get_row(batch_id, row_id, runtime=runtime) if row_id is not None else None
            if not allowed(parent, row):
                return False
            if payload is None:
                return True
            if row_id is None:
                batch._upsert_batch(batch_id, payload, runtime=runtime)
            else:
                batch._upsert_row(batch_id, row_id, payload, runtime=runtime)
            return True

    parent_ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)
    row_ref = runtime.batch_repo.batch_row_doc_ref(runtime.db, batch_id, row_id) if row_id is not None else None

    @runtime.firestore.transactional
    def write(transaction):
        parent = parent_ref.get(transaction=transaction)
        row = row_ref.get(transaction=transaction) if row_ref is not None else None
        if not allowed(parent.to_dict() if parent.exists else None, row.to_dict() if row and row.exists else None):
            return False
        if payload is not None:
            sanitize = batch._sanitize_row_payload if row_ref is not None else batch._sanitize_batch_payload
            fields = sanitize(payload)
            if fields:
                transaction.update(row_ref if row_ref is not None else parent_ref, fields)
        return True

    return write(runtime.db.transaction())


def claim_worker(batch_id, worker_id, runtime):
    # A stopped worker's claim stays on the parent. Stale recovery handles its
    # refund without dispatching an ambiguous paid request a second time.
    return _write(batch_id, worker_id, {'overnight_worker_id': worker_id,
                                        'last_heartbeat_at': runtime.time.time()}, runtime, claim=True)


def fence_stale_worker(batch_id, runtime):
    """Recheck the heartbeat and fence late responses before settling interrupted rows."""
    from . import batch_orchestrator as batch

    now = runtime.time.time()

    def fence(parent, update):
        if not parent or not batch._batch_is_stale(parent, runtime=runtime, now_ts=now):
            return None
        previous = parent.get('overnight_recovery_started_at')
        if previous and now - previous < batch._batch_recovery_stale_seconds(runtime=runtime):
            return None
        payload = {'overnight_recovery_started_at': now}
        update(payload)
        return {**parent, **payload, 'batch_id': batch_id}

    if getattr(runtime, 'db', None) is None:
        with batch._BATCH_ACTIVITY_LOCK:
            return fence(batch._get_batch(batch_id, runtime=runtime),
                         lambda payload: batch._upsert_batch(batch_id, payload, runtime=runtime))

    ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)

    @runtime.firestore.transactional
    def claim(transaction):
        doc = ref.get(transaction=transaction)
        return fence(doc.to_dict() if doc.exists else None, lambda payload: transaction.update(ref, payload))

    return claim(runtime.db.transaction())


def run_stage(batch_id, rows, stage, route_stage, builder, handler, runtime):
    from . import batch_orchestrator as batch

    worker_id = rows[0]['_overnight_worker_id']

    def commit(payload, row_id=None):
        if not _write(batch_id, worker_id, payload, runtime, row_id=row_id):
            raise batch._BatchStopped()

    now = runtime.time.time()
    commit({'current_stage': stage, 'current_stage_state': 'running', 'stage_started_at': now,
            'provider_state': 'DIRECT_API', 'last_heartbeat_at': now, 'updated_at': now})
    for row in rows:
        if row.get('status') == 'error':
            continue
        row_id = row['row_id']
        now = runtime.time.time()
        progress = {'status': 'processing', 'current_stage': stage, 'last_stage_update_at': now, 'updated_at': now}
        commit(progress, row_id)
        row.update(progress)
        previous = dict(row)
        request = builder(row)
        if request is not None:
            try:
                result = _generate(row, stage, route_stage, request, runtime, commit)
                handler(row, result)
            except batch._BatchStopped:
                raise
            except Exception as error:
                code = ai_provider.classify_provider_error_code(error, runtime=runtime)
                runtime.logger.warning('Overnight %s failed for batch %s row %s (%s).', stage, batch_id, row_id, code)
                row.update(status='error', failed_stage=stage, provider_error_code=code,
                           error='Document processing failed for this row.')
        # Persist only fields generated by the handler, validation or accounting.
        changed = {key: value for key, value in row.items() if value != previous.get(key)}
        changed['last_stage_update_at'] = changed['updated_at'] = runtime.time.time()
        commit(changed, row_id)


def _generate(row, stage, route_stage, request, runtime, commit):
    from . import batch_orchestrator as batch

    if route_stage == 'slides_extraction':
        parts = request
    else:
        parts = [TextPart(part['text']) for part in request['contents'][0]['parts']]
    usage = ai_provider.TokenAccumulator(runtime=runtime)
    prior = dict(row.get('token_usage_by_stage') or {})

    def record(label, result):
        usage.record_result(label, result, billing_mode='standard')
        batch._update_stage_usage_totals(row, {**prior, **usage.stages})

    def discard(label, result):
        record(label, result)
        commit({key: row[key] for key in ('token_usage_by_stage', 'token_input_total',
                                          'token_output_total', 'token_total')}, row['row_id'])

    active = partial(commit, None, row['row_id'])
    retries = {}
    try:
        with factory.open_provider_session(runtime, allow_gemini_fallback=False, before_request=active) as session:
            result = session.generate(route_stage, parts, max_output_tokens=65536,
                                      source_slide_text=str(row.get('slide_text') or ''), retry_tracker=retries,
                                      operation_name='overnight_' + stage, record_discarded=discard)
    finally:
        if retries:
            row['retry_attempts'] = int(row.get('retry_attempts') or 0) + sum(retries.values())
    record(stage, result)
    return result
