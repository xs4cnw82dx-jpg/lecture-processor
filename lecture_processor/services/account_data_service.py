"""Account export and deletion flows extracted from auth API service."""

from datetime import datetime, timezone
import io
import json
import tempfile
import zipfile

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import export as study_export
from lecture_processor.services import access_service


def _export_warning_entry(pack, doc_id, reason, formats):
    payload = pack if isinstance(pack, dict) else {}
    safe_pack_id = str(payload.get('study_pack_id', '') or doc_id or '').strip() or str(doc_id or '')
    return {
        'pack_id': safe_pack_id,
        'title': str(payload.get('title', '') or '').strip(),
        'reason': str(reason or '').strip(),
        'formats': [str(item or '').strip() for item in (formats or []) if str(item or '').strip()],
    }


def export_account_data(app_ctx, request):
    decoded_token, error_response, status = access_service.require_allowed_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    try:
        payload = account_lifecycle.collect_user_export_payload(uid, email, runtime=app_ctx)
        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        filename = f"lecture-processor-account-export-{date_str}.json"
        data_bytes = json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode('utf-8')
        file_obj = io.BytesIO(data_bytes)
        file_obj.seek(0)
        return app_ctx.send_file(
            file_obj,
            mimetype='application/json',
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        app_ctx.logger.error(f"Error exporting account data for {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not export account data'}), 500


def export_account_bundle(app_ctx, request):
    decoded_token, error_response, status = access_service.require_allowed_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    payload = request.get_json(silent=True) or {}
    scope = str(payload.get('scope', 'account') or 'account').strip().lower()
    if scope != 'account':
        return app_ctx.jsonify({'error': 'Only account scope is supported.'}), 400

    include = account_lifecycle.normalize_export_bundle_include(payload.get('include', {}), runtime=app_ctx)
    if not account_lifecycle.has_export_bundle_selection(include, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Select at least one export option.'}), 400

    packs = []
    collection_truncated = False
    if any(
        include.get(key)
        for key in (
            'flashcards_csv',
            'practice_tests_csv',
            'lecture_notes_docx',
            'lecture_notes_pdf_marked',
            'lecture_notes_pdf_unmarked',
        )
    ):
        docs = app_ctx.study_repo.list_study_packs_by_uid(
            app_ctx.db,
            uid,
            app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION + 1,
        )
        packs = docs[: app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION]
        collection_truncated = len(docs) > app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION

    folder_map = {
        'flashcards_csv': 'flashcards_csv',
        'practice_tests_csv': 'practice_tests_csv',
        'lecture_notes_docx': 'lecture_notes_docx',
        'lecture_notes_pdf_marked': 'lecture_notes_pdf_marked',
        'lecture_notes_pdf_unmarked': 'lecture_notes_pdf_unmarked',
        'account_json': 'account_json',
    }

    format_limits = {
        'csv': max(1, int(app_ctx.ACCOUNT_EXPORT_MAX_CSV_PACKS or 250)),
        'docx': max(1, int(app_ctx.ACCOUNT_EXPORT_MAX_DOCX_PACKS or 40)),
        'pdf': max(1, int(app_ctx.ACCOUNT_EXPORT_MAX_PDF_PACKS or 20)),
    }

    archive_bytes = tempfile.SpooledTemporaryFile(
        max_size=max(1024 * 1024, int(app_ctx.ACCOUNT_EXPORT_ZIP_SPOOL_BYTES or 5 * 1024 * 1024)),
        mode='w+b',
    )
    try:
        with zipfile.ZipFile(archive_bytes, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
            warnings_payload = {
                'generated_at': app_ctx.time.time(),
                'limits': {
                    'max_docs_per_collection': int(app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION or 0),
                    'csv_packs': format_limits['csv'],
                    'docx_packs': format_limits['docx'],
                    'pdf_packs': format_limits['pdf'],
                },
                'omitted_exports': [],
            }
            for key, folder in folder_map.items():
                if include.get(key):
                    archive.writestr(folder + '/', '')

            for index, doc in enumerate(packs):
                pack = doc.to_dict() or {}
                pack_id = str(pack.get('study_pack_id', '') or doc.id or '').strip() or str(doc.id)
                safe_title = study_export.sanitize_export_filename(
                    pack.get('title', '') or pack_id,
                    fallback=pack_id,
                )
                include_csv_formats = []
                if include.get('flashcards_csv'):
                    include_csv_formats.append('flashcards_csv')
                if include.get('practice_tests_csv'):
                    include_csv_formats.append('practice_tests_csv')
                if include_csv_formats and index >= format_limits['csv']:
                    warnings_payload['omitted_exports'].append(
                        _export_warning_entry(pack, pack_id, 'csv_pack_limit_exceeded', include_csv_formats)
                    )
                else:
                    if include.get('flashcards_csv'):
                        csv_bytes = study_export.build_flashcards_csv_bytes(pack, runtime=app_ctx)
                        if csv_bytes:
                            archive.writestr(f'flashcards_csv/{safe_title}-{pack_id}.csv', csv_bytes)

                    if include.get('practice_tests_csv'):
                        test_bytes = study_export.build_practice_test_csv_bytes(pack, runtime=app_ctx)
                        if test_bytes:
                            archive.writestr(f'practice_tests_csv/{safe_title}-{pack_id}.csv', test_bytes)

                if include.get('lecture_notes_docx'):
                    if index >= format_limits['docx']:
                        warnings_payload['omitted_exports'].append(
                            _export_warning_entry(pack, pack_id, 'docx_pack_limit_exceeded', ['lecture_notes_docx'])
                        )
                    else:
                        docx_bytes = study_export.build_notes_docx_bytes(pack, runtime=app_ctx)
                        if docx_bytes:
                            archive.writestr(f'lecture_notes_docx/{safe_title}-{pack_id}.docx', docx_bytes)

                include_pdf_formats = []
                if include.get('lecture_notes_pdf_marked'):
                    include_pdf_formats.append('lecture_notes_pdf_marked')
                if include.get('lecture_notes_pdf_unmarked'):
                    include_pdf_formats.append('lecture_notes_pdf_unmarked')
                if include_pdf_formats:
                    if index >= format_limits['pdf']:
                        warnings_payload['omitted_exports'].append(
                            _export_warning_entry(pack, pack_id, 'pdf_pack_limit_exceeded', include_pdf_formats)
                        )
                    else:
                        if include.get('lecture_notes_pdf_marked'):
                            pdf_marked = study_export.build_notes_pdf_bytes(pack, include_answers=True, runtime=app_ctx)
                            if pdf_marked:
                                archive.writestr(f'lecture_notes_pdf_marked/{safe_title}-{pack_id}-marked.pdf', pdf_marked)

                        if include.get('lecture_notes_pdf_unmarked'):
                            pdf_unmarked = study_export.build_notes_pdf_bytes(pack, include_answers=False, runtime=app_ctx)
                            if pdf_unmarked:
                                archive.writestr(f'lecture_notes_pdf_unmarked/{safe_title}-{pack_id}-unmarked.pdf', pdf_unmarked)

            if include.get('account_json'):
                account_payload = account_lifecycle.collect_user_export_payload(uid, email, runtime=app_ctx)
                account_bytes = json.dumps(account_payload, ensure_ascii=False, indent=2, default=str).encode('utf-8')
                archive.writestr('account_json/account-export.json', account_bytes)
            if collection_truncated:
                warnings_payload['collection_truncated'] = {
                    'study_packs': {
                        'reason': 'max_docs_per_collection_reached',
                        'limit': int(app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION or 0),
                    }
                }
            if warnings_payload['omitted_exports'] or warnings_payload.get('collection_truncated'):
                archive.writestr(
                    'export_warnings.json',
                    json.dumps(warnings_payload, ensure_ascii=False, indent=2).encode('utf-8'),
                )
    except RuntimeError as error:
        archive_bytes.close()
        return app_ctx.jsonify({'error': str(error)}), 500
    except Exception as error:
        archive_bytes.close()
        app_ctx.logger.error(f"Error building export bundle for {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not build export bundle'}), 500

    archive_bytes.seek(0)
    filename = f"lecture-processor-export-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.zip"
    return app_ctx.send_file(
        archive_bytes,
        mimetype='application/zip',
        as_attachment=True,
        download_name=filename,
    )


def delete_account_data(app_ctx, request):
    decoded_token, error_response, status = access_service.require_allowed_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    email = str(decoded_token.get('email', '') or '').strip().lower()
    payload = request.get_json(silent=True) or {}

    confirm_text = str(payload.get('confirm_text', '') or '').strip().upper()
    if confirm_text != 'DELETE MY ACCOUNT':
        return app_ctx.jsonify({'error': 'Invalid confirmation text. Type DELETE MY ACCOUNT exactly.'}), 400

    confirm_email = str(payload.get('confirm_email', '') or '').strip().lower()
    if email and confirm_email != email:
        return app_ctx.jsonify({'error': 'Confirmation email does not match your account email.'}), 400

    active_jobs = account_lifecycle.count_active_jobs_for_user(uid, runtime=app_ctx)
    if active_jobs > 0:
        return app_ctx.jsonify({
            'error': f'Cannot delete account while {active_jobs} queued or processing job(s) are still active. Please wait until all work finishes.'
        }), 409

    deletion_started = False
    original_user_state = account_lifecycle.get_user_account_state(uid, runtime=app_ctx)

    try:
        page_size = max(100, int(app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION or 1000))
        deleted = {}
        warnings_list = []
        job_ids = set()
        batch_row_prefixes = set()
        batch_ids_seen = set()

        deletion_started = bool(account_lifecycle.mark_account_deletion_requested(uid, email=email, runtime=app_ctx))
        if not deletion_started:
            raise RuntimeError('Could not mark account deletion as started.')

        def _delete_field_collection(collection_name, field_name, field_value, deleted_key=None):
            deleted_count = 0
            while True:
                docs = account_lifecycle.query_docs_by_field(
                    collection_name,
                    field_name,
                    field_value,
                    page_size,
                    runtime=app_ctx,
                )
                if not docs:
                    break
                for doc in docs:
                    if collection_name == 'job_logs':
                        data = doc.to_dict() or {}
                        job_id = str(data.get('job_id', '') or doc.id or '').strip()
                        if job_id:
                            job_ids.add(job_id)
                    try:
                        doc.reference.delete()
                        deleted_count += 1
                    except Exception as error:
                        warnings_list.append(f"Could not delete {collection_name}/{doc.id}: {error}")
                if len(docs) < page_size:
                    break
            deleted[deleted_key or collection_name] = deleted_count

        def _delete_uid_collection(collection_name):
            _delete_field_collection(collection_name, 'uid', uid)

        def _anonymize_purchases():
            anonymized = 0
            while True:
                docs = account_lifecycle.query_docs_by_field(
                    'purchases',
                    'uid',
                    uid,
                    page_size,
                    runtime=app_ctx,
                )
                if not docs:
                    break
                for doc in docs:
                    try:
                        doc.reference.set(
                            {
                                'uid': '',
                                'user_erased': True,
                                'erased_at': app_ctx.time.time(),
                            },
                            merge=True,
                        )
                        anonymized += 1
                    except Exception as error:
                        warnings_list.append(f"Could not anonymize purchase {doc.id}: {error}")
                if len(docs) < page_size:
                    break
            deleted['purchases_anonymized'] = anonymized

        def _delete_study_packs():
            deleted_packs = 0
            deleted_audio = 0
            deleted_progress = 0
            deleted_sources = 0
            while True:
                docs = account_lifecycle.query_docs_by_field(
                    'study_packs',
                    'uid',
                    uid,
                    page_size,
                    runtime=app_ctx,
                )
                if not docs:
                    break
                for doc in docs:
                    pack = doc.to_dict() or {}
                    pack_id = doc.id
                    source_job_id = str(pack.get('source_job_id', '') or '').strip()
                    if source_job_id:
                        job_ids.add(source_job_id)
                    if study_audio.remove_pack_audio_file(pack, runtime=app_ctx):
                        deleted_audio += 1
                    try:
                        app_ctx.get_study_card_state_doc(uid, pack_id).delete()
                        deleted_progress += 1
                    except Exception:
                        pass
                    try:
                        source_ref = app_ctx.study_repo.study_pack_source_doc_ref(app_ctx.db, pack_id)
                        if getattr(source_ref.get(), 'exists', False):
                            source_ref.delete()
                            deleted_sources += 1
                    except Exception as error:
                        warnings_list.append(f"Could not delete study pack source {pack_id}: {error}")
                    try:
                        doc.reference.delete()
                        deleted_packs += 1
                    except Exception as error:
                        warnings_list.append(f"Could not delete study pack {pack_id}: {error}")
                if len(docs) < page_size:
                    break
            deleted['study_packs'] = deleted_packs
            deleted['study_pack_audio_files'] = deleted_audio
            deleted['study_pack_progress_states'] = deleted_progress
            deleted['study_pack_sources'] = deleted_sources

        def _delete_runtime_job_docs():
            deleted_count = 0
            while True:
                docs = account_lifecycle.query_docs_by_field(
                    app_ctx.RUNTIME_JOBS_COLLECTION,
                    'user_id',
                    uid,
                    page_size,
                    runtime=app_ctx,
                )
                if not docs:
                    break
                for doc in docs:
                    job_ids.add(doc.id)
                    try:
                        doc.reference.delete()
                        deleted_count += 1
                    except Exception as error:
                        warnings_list.append(f"Could not delete runtime job {doc.id}: {error}")
                if len(docs) < page_size:
                    break
            deleted['runtime_jobs'] = deleted_count

        def _delete_batch_jobs():
            deleted_batches = 0
            deleted_rows = 0
            while True:
                docs = app_ctx.batch_repo.list_batch_jobs_by_uid(app_ctx.db, uid, page_size)
                if not docs:
                    break
                for doc in docs:
                    batch_id = doc.id
                    batch_ids_seen.add(batch_id)
                    try:
                        row_docs = app_ctx.batch_repo.list_batch_rows(app_ctx.db, batch_id)
                    except Exception as error:
                        warnings_list.append(f"Could not list rows for batch {batch_id}: {error}")
                        row_docs = []
                    for row_doc in row_docs:
                        batch_row_prefixes.add(f"{batch_id}_{row_doc.id}")
                        try:
                            row_doc.reference.delete()
                            deleted_rows += 1
                        except Exception as error:
                            warnings_list.append(f"Could not delete batch row {batch_id}/{row_doc.id}: {error}")
                    try:
                        doc.reference.delete()
                        deleted_batches += 1
                    except Exception as error:
                        warnings_list.append(f"Could not delete batch {batch_id}: {error}")
                if len(docs) < page_size:
                    break
            deleted['batch_jobs'] = deleted_batches
            deleted['batch_rows'] = deleted_rows

        _delete_uid_collection('job_logs')
        _anonymize_purchases()
        _delete_uid_collection('analytics_events')
        _delete_uid_collection('study_folders')
        _delete_uid_collection('study_card_states')
        _delete_field_collection('study_shares', 'owner_uid', uid, deleted_key='study_shares')
        _delete_uid_collection('planner_sessions')
        _delete_uid_collection('planner_settings')
        _delete_uid_collection('physio_case_sessions')
        _delete_uid_collection('physio_cases')
        _delete_study_packs()
        deleted_sources_from_packs = int(deleted.get('study_pack_sources', 0) or 0)
        _delete_uid_collection('study_pack_sources')
        deleted['study_pack_sources'] = deleted_sources_from_packs + int(deleted.get('study_pack_sources', 0) or 0)
        _delete_runtime_job_docs()
        _delete_batch_jobs()

        try:
            progress_ref = app_ctx.get_study_progress_doc(uid)
            progress_snapshot = progress_ref.get()
            if getattr(progress_snapshot, 'exists', False):
                progress_ref.delete()
                deleted['study_progress_doc'] = 1
            else:
                deleted['study_progress_doc'] = 0
        except Exception as error:
            warnings_list.append(f"Could not delete study progress document: {error}")
            deleted['study_progress_doc'] = 0

        remaining = []
        verification_targets = [
            ('job_logs', 'uid', uid, 'job_logs'),
            ('analytics_events', 'uid', uid, 'analytics_events'),
            ('study_folders', 'uid', uid, 'study_folders'),
            ('study_card_states', 'uid', uid, 'study_card_states'),
            ('study_shares', 'owner_uid', uid, 'study_shares'),
            ('study_packs', 'uid', uid, 'study_packs'),
            ('study_pack_sources', 'uid', uid, 'study_pack_sources'),
            ('planner_sessions', 'uid', uid, 'planner_sessions'),
            ('planner_settings', 'uid', uid, 'planner_settings'),
            ('physio_cases', 'uid', uid, 'physio_cases'),
            ('physio_case_sessions', 'uid', uid, 'physio_case_sessions'),
            ('purchases', 'uid', uid, 'purchases'),
            (app_ctx.RUNTIME_JOBS_COLLECTION, 'user_id', uid, 'runtime_jobs'),
            ('batch_jobs', 'uid', uid, 'batch_jobs'),
        ]
        for collection_name, field_name, value, label in verification_targets:
            if account_lifecycle.has_docs_by_field(collection_name, field_name, value, runtime=app_ctx):
                remaining.append(label)
        for batch_id in sorted(batch_ids_seen):
            try:
                if app_ctx.batch_repo.list_batch_rows(app_ctx.db, batch_id):
                    remaining.append(f'batch_rows:{batch_id}')
            except Exception as error:
                warnings_list.append(f"Could not verify batch rows for {batch_id}: {error}")
                remaining.append(f'batch_rows:{batch_id}')
        try:
            if getattr(app_ctx.get_study_progress_doc(uid).get(), 'exists', False):
                remaining.append('study_progress')
        except Exception as error:
            warnings_list.append(f"Could not verify study progress deletion: {error}")
            remaining.append('study_progress')
        if remaining:
            raise RuntimeError('Account data deletion incomplete: ' + ', '.join(sorted(set(remaining))))

        removed_in_memory_jobs = 0
        with app_ctx.JOBS_LOCK:
            for jid, job_data in list(app_ctx.jobs.items()):
                if str(job_data.get('user_id', '') or '') != uid:
                    continue
                job_ids.add(jid)
                try:
                    del app_ctx.jobs[jid]
                    removed_in_memory_jobs += 1
                except Exception:
                    pass
        deleted['in_memory_jobs'] = removed_in_memory_jobs

        upload_prefixes = set(job_ids) | batch_row_prefixes
        deleted['upload_artifacts'] = account_lifecycle.remove_upload_artifacts_for_job_ids(upload_prefixes, runtime=app_ctx)

        try:
            app_ctx.users_repo.delete_doc(app_ctx.db, uid)
            deleted['user_profile_doc'] = 1
        except Exception as error:
            raise RuntimeError(f"Could not delete user profile document: {error}")

        app_ctx.auth.delete_user(uid)

        return app_ctx.jsonify({
            'ok': True,
            'auth_user_deleted': True,
            'deleted': deleted,
            'warnings': warnings_list,
        })
    except Exception as e:
        app_ctx.logger.error(f"Error deleting account data for {uid}: {e}")
        if deletion_started:
            try:
                account_lifecycle.restore_account_after_failed_deletion(
                    uid,
                    email=email,
                    reason=str(e),
                    runtime=app_ctx,
                    existing_state=original_user_state,
                )
            except Exception:
                app_ctx.logger.error("Could not restore account state after failed deletion for %s", uid, exc_info=True)
        return app_ctx.jsonify({
            'error': 'Could not completely delete account data',
            'details': str(e),
        }), 500
