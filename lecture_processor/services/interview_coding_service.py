"""Interview qualitative coding API handlers."""

import math
from urllib.parse import quote

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import job_charges, ledger, policy
from lecture_processor.domains.study import interview_coding
from lecture_processor.domains.study import interview_coding_runs as coding_runs
from lecture_processor.domains.study import export as study_export
from lecture_processor.services import study_api_support


def _require_interview_pack(app_ctx, uid, pack_id):
    pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return None, '', error_response, status
    _doc, pack = pack_result
    if str(pack.get('mode', '') or '').strip() != 'interview':
        return None, '', app_ctx.jsonify({'error': 'Interview coding is only available for interview packs'}), 400
    source_payload = study_api_support.get_study_pack_source_payload(app_ctx, pack_id)
    transcript = str(source_payload.get('transcript', '') or pack.get('source_transcript', '') or pack.get('transcript', '') or pack.get('notes_markdown', '') or '')
    return pack, transcript, None, None


def _serialize_code_doc(doc):
    payload = doc.to_dict() or {}
    return {
        'code_id': doc.id,
        'name': str(payload.get('name', '') or ''),
        'description': str(payload.get('description', '') or ''),
        'color': interview_coding.sanitize_code_color(payload.get('color', 'teal')),
        'parent_code_id': str(payload.get('parent_code_id', '') or ''),
        'created_at': float(payload.get('created_at', 0) or 0),
        'updated_at': float(payload.get('updated_at', 0) or 0),
    }


def _serialize_quotation_doc(doc):
    payload = doc.to_dict() or {}
    return {
        'quotation_id': doc.id,
        'pack_id': str(payload.get('pack_id', '') or ''),
        'transcript_base_key': str(payload.get('transcript_base_key', '') or ''),
        'start_offset': int(payload.get('start_offset', 0) or 0),
        'end_offset': int(payload.get('end_offset', 0) or 0),
        'text': str(payload.get('text', '') or ''),
        'speaker': str(payload.get('speaker', '') or ''),
        'timestamp': str(payload.get('timestamp', '') or ''),
        'code_ids': payload.get('code_ids', []) if isinstance(payload.get('code_ids', []), list) else [],
        'comment': str(payload.get('comment', '') or ''),
        'source': str(payload.get('source', '') or ''),
        'created_at': float(payload.get('created_at', 0) or 0),
        'updated_at': float(payload.get('updated_at', 0) or 0),
    }


def _serialize_run_doc(doc):
    payload = doc.to_dict() or {}
    return {
        'run_id': doc.id,
        'pack_id': str(payload.get('pack_id', '') or ''),
        'status': str(payload.get('status', '') or ''),
        'model': str(payload.get('model', '') or ''),
        'thinking_level': str(payload.get('thinking_level', '') or ''),
        'prompt_version': str(payload.get('prompt_version', '') or ''),
        'proposed_codes': payload.get('proposed_codes', []) if isinstance(payload.get('proposed_codes', []), list) else [],
        'proposed_quotations': payload.get('proposed_quotations', []) if isinstance(payload.get('proposed_quotations', []), list) else [],
        'error': coding_runs.ERROR_MESSAGE if payload.get('error') else '',
        'error_code': coding_runs.ERROR_CODE if payload.get('error') else '',
        'credit_refunded': bool(payload.get('credit_refunded', False)),
        'warning': str(payload.get('warning', '') or ''),
        'credit_cost': int(payload.get('credit_cost', 0) or 0),
        'token_usage_by_stage': payload.get('token_usage_by_stage', {}) if isinstance(payload.get('token_usage_by_stage', {}), dict) else {},
        'created_at': float(payload.get('created_at', 0) or 0),
        'updated_at': float(payload.get('updated_at', 0) or 0),
    }


def _load_codes(app_ctx, uid):
    docs = app_ctx.repositories.study.list_interview_codes_by_uid(app_ctx.db, uid)
    codes = [_serialize_code_doc(doc) for doc in docs if getattr(doc, 'exists', False)]
    codes.sort(key=lambda item: (str(item.get('parent_code_id', '') or ''), str(item.get('name', '') or '').lower()))
    return codes


def _load_quotations(app_ctx, uid, pack_id):
    docs = app_ctx.repositories.study.list_interview_quotations_by_uid_and_pack(app_ctx.db, uid, pack_id)
    quotations = [_serialize_quotation_doc(doc) for doc in docs if getattr(doc, 'exists', False)]
    quotations.sort(key=lambda item: (int(item.get('start_offset', 0) or 0), int(item.get('end_offset', 0) or 0)))
    return quotations


def _load_latest_runs(app_ctx, uid, pack_id, *, limit=20):
    docs = app_ctx.repositories.study.list_interview_ai_coding_runs_by_uid_and_pack(app_ctx.db, uid, pack_id, limit=limit)
    runs = [_serialize_run_doc(doc) for doc in docs if getattr(doc, 'exists', False)]
    runs.sort(key=lambda item: float(item.get('created_at', 0) or 0), reverse=True)
    return runs


def _owned_code_doc(app_ctx, uid, code_id):
    doc = app_ctx.repositories.study.get_interview_code_doc(app_ctx.db, code_id)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'Code not found'}), 404
    payload = doc.to_dict() or {}
    if str(payload.get('uid', '') or '').strip() != uid:
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return doc, None, None


def _owned_quotation_doc(app_ctx, uid, pack_id, quotation_id):
    doc = app_ctx.repositories.study.get_interview_quotation_doc(app_ctx.db, quotation_id)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'Quotation not found'}), 404
    payload = doc.to_dict() or {}
    if str(payload.get('uid', '') or '').strip() != uid or str(payload.get('pack_id', '') or '').strip() != pack_id:
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return doc, None, None


def _validate_code_parent(app_ctx, uid, parent_code_id, *, current_code_id=''):
    parent_id = str(parent_code_id or '').strip()
    current_id = str(current_code_id or '').strip()
    if not parent_id:
        return '', None, None
    parent_doc, error_response, status = _owned_code_doc(app_ctx, uid, parent_id)
    if error_response is not None:
        return '', error_response, status
    if current_id:
        codes = _load_codes(app_ctx, uid)
        children_by_parent = {}
        for code in codes:
            children_by_parent.setdefault(str(code.get('parent_code_id', '') or ''), []).append(code.get('code_id'))
        descendants = set()
        stack = list(children_by_parent.get(current_id, []))
        while stack:
            code_id = stack.pop()
            if code_id in descendants:
                continue
            descendants.add(code_id)
            stack.extend(children_by_parent.get(code_id, []))
        if parent_id == current_id or parent_id in descendants:
            return '', app_ctx.jsonify({'error': 'A code cannot be moved inside itself or one of its subcodes'}), 400
    return parent_doc.id, None, None


def _coding_state_payload(app_ctx, pack_id, pack, transcript, uid):
    segments = interview_coding.parse_transcript_segments(transcript)
    codes = _load_codes(app_ctx, uid)
    quotations = _load_quotations(app_ctx, uid, pack_id)
    current_id = str(pack.get('interview_coding_run_id', '') or '')
    runs = _load_latest_runs(app_ctx, uid, pack_id, limit=20 if current_id else None)
    if current_id:
        current_doc = app_ctx.repositories.study.get_interview_ai_coding_run_doc(app_ctx.db, current_id)
        current = current_doc.to_dict() or {}
        if current_doc.exists and current.get('uid') == uid and current.get('pack_id') == pack_id:
            runs = [_serialize_run_doc(current_doc)] + [run for run in runs if run['run_id'] != current_id]
    credit_cost = max(1, int(math.ceil(max(1, len(transcript)) / 120000.0))) if transcript.strip() else 0
    user_doc = app_ctx.repositories.users.get_doc(app_ctx.db, uid)
    user = user_doc.to_dict() or {} if user_doc.exists else {}
    credit_scheme = 2 if policy.uses_unified_credits(user, runtime=app_ctx) else 1
    if credit_scheme == 2:
        credit_cost = policy.action_cost('interview_coding', units=credit_cost)
    category = policy.ACTION_COSTS['interview_coding']['category']
    charged_credits = 0 if billing_credits.is_unlimited_for_category(user, category, runtime=app_ctx) else credit_cost
    return {
        'pack_id': pack_id,
        'pack_title': str(pack.get('title', '') or ''),
        'transcript': transcript,
        'transcript_base_key': interview_coding.transcript_base_key(pack_id, transcript),
        'segments': segments,
        'codes': codes,
        'quotations': quotations,
        'latest_run': runs[0] if runs else None,
        'runs': runs[:5],
        'palette': interview_coding.CODING_PALETTE,
        'ai_estimate': {
            'credit_cost': credit_cost,
            'credit_scheme': credit_scheme,
            'charged_credits': charged_credits,
            'model': getattr(app_ctx, 'MODEL_INTERVIEW_CODING', 'gemini-3.8-flash'),
            'thinking_level': 'high',
        },
    }


def get_coding_state(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    return app_ctx.jsonify(_coding_state_payload(app_ctx, pack_id, pack, transcript, uid))


def create_code(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    payload = request.get_json(silent=True) or {}
    code_payload = interview_coding.sanitize_code_payload(payload)
    if code_payload is None:
        return app_ctx.jsonify({'error': 'Code name is required'}), 400
    parent_code_id, parent_error, parent_status = _validate_code_parent(app_ctx, uid, code_payload.get('parent_code_id', ''))
    if parent_error is not None:
        return parent_error, parent_status
    now_ts = app_ctx.time.time()
    doc_ref = app_ctx.repositories.study.create_interview_code_doc_ref(app_ctx.db)
    doc_ref.set({
        'code_id': doc_ref.id,
        'uid': uid,
        'name': code_payload['name'],
        'description': code_payload['description'],
        'color': code_payload['color'],
        'parent_code_id': parent_code_id,
        'created_at': now_ts,
        'updated_at': now_ts,
    })
    return app_ctx.jsonify({'ok': True, 'code': _serialize_code_doc(doc_ref.get())})


def update_code(app_ctx, request, pack_id, code_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    doc, error_response, status = _owned_code_doc(app_ctx, uid, code_id)
    if error_response is not None:
        return error_response, status
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400
    updates = {'updated_at': app_ctx.time.time()}
    if 'name' in payload:
        name = str(payload.get('name', '') or '').strip()[:80]
        if not name:
            return app_ctx.jsonify({'error': 'Code name is required'}), 400
        updates['name'] = name
    if 'description' in payload:
        updates['description'] = str(payload.get('description', '') or '').strip()[:500]
    if 'color' in payload:
        updates['color'] = interview_coding.sanitize_code_color(payload.get('color', 'teal'))
    if 'parent_code_id' in payload:
        parent_code_id, parent_error, parent_status = _validate_code_parent(app_ctx, uid, payload.get('parent_code_id', ''), current_code_id=code_id)
        if parent_error is not None:
            return parent_error, parent_status
        updates['parent_code_id'] = parent_code_id
    doc.reference.update(updates)
    return app_ctx.jsonify({'ok': True, 'code': _serialize_code_doc(doc.reference.get())})


def delete_code(app_ctx, request, pack_id, code_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    doc, error_response, status = _owned_code_doc(app_ctx, uid, code_id)
    if error_response is not None:
        return error_response, status
    now_ts = app_ctx.time.time()
    for quotation_doc in app_ctx.repositories.study.list_interview_quotations_by_uid_and_pack(app_ctx.db, uid, pack_id):
        quotation = quotation_doc.to_dict() or {}
        code_ids = [str(item or '').strip() for item in quotation.get('code_ids', []) if str(item or '').strip() and str(item or '').strip() != code_id]
        if code_ids:
            quotation_doc.reference.update({'code_ids': code_ids, 'updated_at': now_ts})
        else:
            quotation_doc.reference.delete()
    for child in app_ctx.repositories.study.list_interview_codes_by_uid(app_ctx.db, uid):
        child_payload = child.to_dict() or {}
        if str(child_payload.get('parent_code_id', '') or '').strip() == code_id:
            child.reference.update({'parent_code_id': '', 'updated_at': now_ts})
    doc.reference.delete()
    return app_ctx.jsonify({'ok': True})


def merge_code(app_ctx, request, pack_id, source_code_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    payload = request.get_json(silent=True) or {}
    target_code_id = str(payload.get('target_code_id', '') or '').strip()
    if not target_code_id or target_code_id == source_code_id:
        return app_ctx.jsonify({'error': 'A different target_code_id is required'}), 400
    source_doc, error_response, status = _owned_code_doc(app_ctx, uid, source_code_id)
    if error_response is not None:
        return error_response, status
    _target_doc, error_response, status = _owned_code_doc(app_ctx, uid, target_code_id)
    if error_response is not None:
        return error_response, status
    now_ts = app_ctx.time.time()
    for quotation_doc in app_ctx.repositories.study.list_interview_quotations_by_uid_and_pack(app_ctx.db, uid, pack_id):
        quotation = quotation_doc.to_dict() or {}
        code_ids = []
        changed = False
        for code_id in quotation.get('code_ids', []) or []:
            safe_id = str(code_id or '').strip()
            if safe_id == source_code_id:
                safe_id = target_code_id
                changed = True
            if safe_id and safe_id not in code_ids:
                code_ids.append(safe_id)
        if changed:
            quotation_doc.reference.update({'code_ids': code_ids, 'updated_at': now_ts})
    for child in app_ctx.repositories.study.list_interview_codes_by_uid(app_ctx.db, uid):
        child_payload = child.to_dict() or {}
        if str(child_payload.get('parent_code_id', '') or '').strip() == source_code_id:
            child.reference.update({'parent_code_id': target_code_id, 'updated_at': now_ts})
    source_doc.reference.delete()
    return app_ctx.jsonify({'ok': True})


def create_quotation(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    code_ids = {code.get('code_id') for code in _load_codes(app_ctx, uid)}
    quote_payload = interview_coding.sanitize_quotation_payload(
        request.get_json(silent=True) or {},
        transcript,
        code_ids,
        pack_id=pack_id,
        transcript_key=interview_coding.transcript_base_key(pack_id, transcript),
    )
    if quote_payload is None:
        return app_ctx.jsonify({'error': 'Quotation must include a valid text range and at least one code'}), 400
    now_ts = app_ctx.time.time()
    doc_ref = app_ctx.repositories.study.create_interview_quotation_doc_ref(app_ctx.db)
    doc_ref.set({
        'quotation_id': doc_ref.id,
        'uid': uid,
        **quote_payload,
        'created_at': now_ts,
        'updated_at': now_ts,
    })
    return app_ctx.jsonify({'ok': True, 'quotation': _serialize_quotation_doc(doc_ref.get())})


def update_quotation(app_ctx, request, pack_id, quotation_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    doc, error_response, status = _owned_quotation_doc(app_ctx, uid, pack_id, quotation_id)
    if error_response is not None:
        return error_response, status
    existing = doc.to_dict() or {}
    payload = request.get_json(silent=True) or {}
    merged = dict(existing)
    for field in ('start_offset', 'end_offset', 'text', 'code_ids', 'comment', 'source'):
        if field in payload:
            merged[field] = payload.get(field)
    code_ids = {code.get('code_id') for code in _load_codes(app_ctx, uid)}
    quote_payload = interview_coding.sanitize_quotation_payload(
        merged,
        transcript,
        code_ids,
        pack_id=pack_id,
        transcript_key=interview_coding.transcript_base_key(pack_id, transcript),
    )
    if quote_payload is None:
        return app_ctx.jsonify({'error': 'Quotation must include a valid text range and at least one code'}), 400
    doc.reference.update({**quote_payload, 'updated_at': app_ctx.time.time()})
    return app_ctx.jsonify({'ok': True, 'quotation': _serialize_quotation_doc(doc.reference.get())})


def delete_quotation(app_ctx, request, pack_id, quotation_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    doc, error_response, status = _owned_quotation_doc(app_ctx, uid, pack_id, quotation_id)
    if error_response is not None:
        return error_response, status
    doc.reference.delete()
    return app_ctx.jsonify({'ok': True})


def _credit_cost_for_transcript(transcript):
    if not str(transcript or '').strip():
        return 0
    return max(1, int(math.ceil(len(str(transcript or '')) / 120000.0)))


def start_ai_coding_run(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    if not transcript.strip():
        return app_ctx.jsonify({'error': 'No transcript is available for coding'}), 400
    credit_cost = _credit_cost_for_transcript(transcript)
    try:
        app_ctx.get_or_create_user(uid, email)
        run_id, created = coding_runs.claim_run(app_ctx, uid, pack_id, credit_cost, email=email)
    except coding_runs.RunError as error:
        return app_ctx.jsonify({'error': str(error), 'error_code': error.code}), error.status
    except (ledger.InsufficientCredits, ledger.LedgerConflict, ledger.LedgerUnavailable) as error:
        payload, status = job_charges.public_charge_error(error)
        return app_ctx.jsonify(payload), status
    except Exception:
        app_ctx.logger.exception('Could not start interview coding for pack %s', pack_id)
        return app_ctx.jsonify({'error': 'AI coding is currently unavailable. Please try again.', 'error_code': 'interview_coding_unavailable'}), 503
    if created:
        try:
            coding_runs.cache_job(app_ctx, run_id)
            app_ctx.submit_background_job(_run_ai_coding_job, job_id=run_id, transcript=transcript, runtime=app_ctx)
        except Exception:
            app_ctx.logger.exception('Could not dispatch interview coding run %s', run_id)
            try:
                coding_runs.fail_run(app_ctx, run_id)
            except Exception:
                app_ctx.logger.exception('Could not finalize interview coding run %s', run_id)
    response = _run_response(app_ctx, pack_id, run_id, reused=not created)
    return app_ctx.jsonify(response), 202 if response['run']['status'] in coding_runs.ACTIVE_STATUSES else 200


def _run_response(app_ctx, pack_id, run_id, *, reused=False):
    return {
        'ok': True,
        'run': _serialize_run_doc(coding_runs.run_ref(app_ctx, run_id).get()),
        'status_url': f'/api/interview-coding/packs/{quote(pack_id, safe="")}/ai-runs/{quote(run_id, safe="")}',
        'reused': reused,
    }


def get_ai_coding_run(app_ctx, request, pack_id, run_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    _pack, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    doc, error_response, status = _owned_run_doc(app_ctx, uid, pack_id, run_id)
    if error_response is not None:
        return error_response, status
    if (doc.to_dict() or {}).get('status') in coding_runs.ACTIVE_STATUSES:
        from lecture_processor.domains.runtime_jobs import recovery
        if getattr(app_ctx, 'RUNTIME_JOB_RECOVERY_ENABLED', False) and not (doc.to_dict() or {}).get('runtime_job_id'):
            try:
                coding_runs.adopt_legacy_active_run(app_ctx, uid, pack_id, run_id)
            except coding_runs.RunError as error:
                return app_ctx.jsonify({'error': str(error), 'error_code': error.code}), error.status
            except Exception:
                app_ctx.logger.exception('Could not recover legacy interview coding run %s', run_id)
                return app_ctx.jsonify({'error': 'Could not check AI coding status. Please try again.', 'error_code': 'interview_coding_unavailable'}), 503
        recovery.recover_runtime_job_if_stale(run_id, runtime=app_ctx)
    return app_ctx.jsonify(_run_response(app_ctx, pack_id, run_id))


def _run_ai_coding_job(job_id, transcript, runtime):
    app_ctx = runtime
    run = coding_runs.run_ref(app_ctx, job_id).get().to_dict() or {}
    uid, pack_id = run.get('uid', ''), run.get('pack_id', '')
    retry_tracker = {}
    try:
        if not coding_runs.start_processing(app_ctx, job_id):
            return
        all_segments = interview_coding.parse_transcript_segments(transcript)
        chunks = interview_coding.split_segments_for_ai(all_segments)
        existing_codes = _load_codes(app_ctx, uid)
        existing_code_ids = {code.get('code_id') for code in existing_codes}
        proposed_codes = []
        proposed_quotations = []
        usage_by_stage = {}
        for index, chunk in enumerate(chunks):
            if index and not coding_runs.can_continue(app_ctx, job_id):
                return
            prompt = interview_coding.build_ai_prompt(
                getattr(app_ctx, 'PROMPT_INTERVIEW_CODING'),
                chunk,
                existing_codes + proposed_codes,
            )
            response = ai_provider.generate_with_policy(
                getattr(app_ctx, 'MODEL_INTERVIEW_CODING', 'gemini-3.8-flash'),
                [prompt],
                max_output_tokens=32768,
                retry_tracker=retry_tracker,
                operation_name=f'interview_ai_coding_{index + 1}',
                runtime=app_ctx,
            )
            usage = ai_provider.extract_token_usage(response, runtime=app_ctx)
            usage_by_stage[f'interview_ai_coding_{index + 1}'] = {
                **usage,
                'model': getattr(app_ctx, 'MODEL_INTERVIEW_CODING', 'gemini-3.8-flash'),
                'billing_mode': 'standard',
                'input_modality': 'text',
            }
            parsed = interview_coding.sanitize_ai_coding_payload(
                getattr(response, 'text', '') or '',
                transcript,
                chunk,
                existing_code_ids=existing_code_ids,
            )
            if parsed.get('error') and not parsed.get('codes') and not parsed.get('quotations'):
                continue
            existing_temp_ids = {code.get('temp_id') for code in proposed_codes}
            for code in parsed.get('codes', []):
                temp_id = code.get('temp_id')
                if temp_id in existing_temp_ids:
                    continue
                proposed_codes.append(code)
                existing_temp_ids.add(temp_id)
            proposed_quotations.extend(parsed.get('quotations', []))
        deduped_quotes = []
        seen_quotes = set()
        for quote in proposed_quotations:
            key = (quote.get('start_offset'), quote.get('end_offset'), tuple(sorted(quote.get('code_refs', []))))
            if key in seen_quotes:
                continue
            seen_quotes.add(key)
            deduped_quotes.append(quote)
        if not proposed_codes and not deduped_quotes:
            raise RuntimeError('AI coding returned no usable codes or quotations.')
        coding_runs.complete_run(app_ctx, job_id, {
            'proposed_codes': proposed_codes,
            'proposed_quotations': deduped_quotes,
            'token_usage_by_stage': usage_by_stage,
        }, transcript=transcript, existing_codes=existing_codes)
    except Exception:
        app_ctx.logger.exception('AI interview coding failed for pack %s', pack_id)
        try:
            coding_runs.fail_run(app_ctx, job_id)
        except Exception:
            app_ctx.logger.exception('Could not finalize interview coding run %s', job_id)


def _owned_run_doc(app_ctx, uid, pack_id, run_id):
    doc = app_ctx.repositories.study.get_interview_ai_coding_run_doc(app_ctx.db, run_id)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'AI coding run not found'}), 404
    payload = doc.to_dict() or {}
    if str(payload.get('uid', '') or '').strip() != uid or str(payload.get('pack_id', '') or '').strip() != pack_id:
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return doc, None, None


def accept_ai_coding_run(app_ctx, request, pack_id, run_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    run_doc, error_response, status = _owned_run_doc(app_ctx, uid, pack_id, run_id)
    if error_response is not None:
        return error_response, status
    from lecture_processor.domains.study import interview_coding_acceptance

    try:
        interview_coding_acceptance.accept_run(
            app_ctx, run_doc.reference, uid, pack_id, transcript, _load_codes(app_ctx, uid),
        )
    except interview_coding_acceptance.AcceptanceError as error:
        return app_ctx.jsonify({'error': str(error)}), error.status
    except Exception:
        app_ctx.logger.exception('Could not finish accepting interview coding run %s', run_id)
        return app_ctx.jsonify({'error': 'Could not finish applying the draft. Please try again.'}), 503
    return app_ctx.jsonify({'ok': True, 'state': _coding_state_payload(app_ctx, pack_id, pack, transcript, uid)})


def reject_ai_coding_run(app_ctx, request, pack_id, run_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    _pack, _transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    run_doc, error_response, status = _owned_run_doc(app_ctx, uid, pack_id, run_id)
    if error_response is not None:
        return error_response, status
    from lecture_processor.domains.study import interview_coding_acceptance

    try:
        interview_coding_acceptance.reject_run(app_ctx, run_doc.reference, uid, pack_id)
    except interview_coding_acceptance.AcceptanceError as error:
        return app_ctx.jsonify({'error': str(error)}), error.status
    return app_ctx.jsonify({'ok': True, 'run': _serialize_run_doc(run_doc.reference.get())})


def export_coding_pdf(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    if not study_export.REPORTLAB_AVAILABLE:
        return app_ctx.jsonify({'error': 'PDF export is currently unavailable on this server'}), 503
    pack, transcript, error_response, status = _require_interview_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return error_response, status
    codes = _load_codes(app_ctx, uid)
    quotations = _load_quotations(app_ctx, uid, pack_id)
    pdf_io = interview_coding.build_interview_coding_pdf(
        str(pack.get('title', '') or 'Interview Coding'),
        transcript,
        codes,
        quotations,
    )
    safe_title = study_export.sanitize_export_filename(str(pack.get('title', '') or 'interview-coding'), fallback='interview-coding')
    return app_ctx.send_file(
        pdf_io,
        mimetype='application/pdf',
        as_attachment=True,
        download_name=f'{safe_title}-coding.pdf',
    )
