"""Study export routes extracted from study API service."""

from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.study import export as study_export

from lecture_processor.services import study_api_support


def export_study_pack_flashcards_csv(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        export_type = request.args.get('type', 'flashcards').strip().lower()
        output = app_ctx.io.StringIO()
        writer = app_ctx.csv.writer(output)
        if export_type == 'test':
            test_questions = pack.get('test_questions', [])
            if not test_questions:
                return app_ctx.jsonify({'error': 'No practice questions available'}), 400
            writer.writerow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation'])
            for question in test_questions:
                options = question.get('options', [])
                padded = (options + ['', '', '', ''])[:4]
                writer.writerow(sanitize_csv_row([
                    question.get('question', ''),
                    padded[0],
                    padded[1],
                    padded[2],
                    padded[3],
                    question.get('answer', ''),
                    question.get('explanation', ''),
                ]))
            filename = f'study-pack-{pack_id}-practice-test.csv'
        else:
            flashcards = pack.get('flashcards', [])
            if not flashcards:
                return app_ctx.jsonify({'error': 'No flashcards available'}), 400
            writer.writerow(['question', 'answer'])
            for card in flashcards:
                writer.writerow(sanitize_csv_row([card.get('front', ''), card.get('back', '')]))
            filename = f'study-pack-{pack_id}-flashcards.csv'
        csv_bytes = app_ctx.io.BytesIO(output.getvalue().encode('utf-8'))
        csv_bytes.seek(0)
        return app_ctx.send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)
    except Exception as error:
        app_ctx.logger.error(f"Error exporting study pack flashcards CSV {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not export CSV'}), 500


def export_study_pack_notes(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        notes_markdown = str(pack.get('notes_markdown', '') or '').strip()
        if not notes_markdown:
            return app_ctx.jsonify({'error': 'No integrated notes available'}), 400

        export_format = request.args.get('format', 'docx').strip().lower()
        base_name = f"study-pack-{pack_id}-notes"
        pack_title = str(pack.get('title', 'Lecture Notes') or 'Lecture Notes').strip()

        if export_format == 'md':
            md_bytes = app_ctx.io.BytesIO(notes_markdown.encode('utf-8'))
            md_bytes.seek(0)
            return app_ctx.send_file(
                md_bytes,
                mimetype='text/markdown',
                as_attachment=True,
                download_name=f"{base_name}.md"
            )

        if export_format == 'docx':
            docx = study_export.markdown_to_docx(notes_markdown, pack_title, runtime=app_ctx)
            docx_bytes = app_ctx.io.BytesIO()
            docx.save(docx_bytes)
            docx_bytes.seek(0)
            return app_ctx.send_file(
                docx_bytes,
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                as_attachment=True,
                download_name=f"{base_name}.docx"
            )

        return app_ctx.jsonify({'error': 'Invalid format'}), 400
    except Exception as error:
        app_ctx.logger.error(f"Error exporting study pack notes {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not export notes'}), 500


def export_study_pack_source(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
        if error_response is not None:
            return error_response, status
        _doc, pack = pack_result

        export_type = str(request.args.get('type', 'slides') or '').strip().lower()
        if export_type not in {'slides', 'transcript'}:
            return app_ctx.jsonify({'error': 'Invalid source export type'}), 400

        export_format = str(request.args.get('format', 'md') or '').strip().lower()
        if export_format not in {'md', 'docx'}:
            return app_ctx.jsonify({'error': 'Invalid format'}), 400

        source_payload = study_api_support.get_study_pack_source_payload(app_ctx, pack_id)
        if not source_payload:
            return app_ctx.jsonify({'error': 'No source export is available for this study pack'}), 404

        if export_type == 'slides':
            content = str(source_payload.get('slide_text', '') or '').strip()
            label = 'Slide Extract'
            suffix = 'slide-extract'
        else:
            content = str(source_payload.get('transcript', '') or '').strip()
            if str(pack.get('mode', '') or '').strip() == 'interview':
                label = 'Interview Transcript'
                suffix = 'interview-transcript'
            else:
                label = 'Lecture Transcript'
                suffix = 'lecture-transcript'

        if not content:
            return app_ctx.jsonify({'error': f'No {export_type} source export is available for this study pack'}), 404

        pack_title = str(pack.get('title', '') or '').strip() or 'Study Pack'
        safe_title = study_export.sanitize_export_filename(pack_title, fallback=f'study-pack-{pack_id}')
        base_name = f'{safe_title}-{suffix}'

        if export_format == 'md':
            md_bytes = app_ctx.io.BytesIO(content.encode('utf-8'))
            md_bytes.seek(0)
            return app_ctx.send_file(
                md_bytes,
                mimetype='text/markdown',
                as_attachment=True,
                download_name=f'{base_name}.md',
            )

        docx = study_export.markdown_to_docx(content, f'{pack_title} - {label}', runtime=app_ctx)
        docx_bytes = app_ctx.io.BytesIO()
        docx.save(docx_bytes)
        docx_bytes.seek(0)
        return app_ctx.send_file(
            docx_bytes,
            mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            as_attachment=True,
            download_name=f'{base_name}.docx',
        )
    except Exception as error:
        app_ctx.logger.error(f"Error exporting study pack source {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not export source output'}), 500


def export_study_pack_pdf(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    if not study_export.REPORTLAB_AVAILABLE:
        return app_ctx.jsonify({
            'error': "PDF export is currently unavailable on this server. Install dependency: pip install reportlab==4.2.5"
        }), 503

    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404

        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        include_answers_raw = str(request.args.get('include_answers', '1')).strip().lower()
        include_answers = include_answers_raw in {'1', 'true', 'yes', 'on'}
        pdf_io = study_export.build_study_pack_pdf(pack, include_answers=include_answers, runtime=app_ctx)
        filename_suffix = '' if include_answers else '-no-answers'
        return app_ctx.send_file(
            pdf_io,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f"study-pack-{pack_id}{filename_suffix}.pdf"
        )
    except Exception as error:
        app_ctx.logger.error(f"Error exporting study pack PDF {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not export PDF'}), 500


def export_study_pack_annotated_pdf(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    if not study_export.REPORTLAB_AVAILABLE:
        return app_ctx.jsonify({
            'error': "Annotated PDF export is currently unavailable on this server. Install dependency: pip install reportlab==4.2.5"
        }), 503

    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404

        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        payload = request.get_json(silent=True) or {}
        annotated_html = str(payload.get('annotated_html', '') or '').strip()
        if not annotated_html:
            return app_ctx.jsonify({'error': 'Annotated notes HTML is required'}), 400

        if len(annotated_html) > 500000:
            return app_ctx.jsonify({'error': 'Annotated notes export is too large'}), 400

        pack_title = str(payload.get('title', '') or pack.get('title', 'Lecture Notes') or 'Lecture Notes').strip()
        pdf_io = study_export.build_annotated_notes_pdf(pack_title, annotated_html, runtime=app_ctx)
        safe_title = study_export.sanitize_export_filename(pack_title, fallback=f'study-pack-{pack_id}')
        return app_ctx.send_file(
            pdf_io,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f'{safe_title}-annotated.pdf'
        )
    except Exception as error:
        app_ctx.logger.error(f"Error exporting annotated study pack PDF {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not export annotated PDF'}), 500
