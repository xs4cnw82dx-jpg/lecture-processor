EXPECTED_ROUTES = [
    ('GET', '/', 'pages.index'),
    ('GET', '/admin', 'pages.admin_dashboard'),
    ('POST', '/api/account/delete', 'account_api.delete_account_data'),
    ('GET', '/api/account/export', 'account_api.export_account_data'),
    ('POST', '/api/account/export-bundle', 'account_api.export_account_bundle'),
    ('GET', '/api/admin/batch-jobs', 'admin_api.admin_batch_jobs'),
    ('POST', '/api/admin/cost-analysis', 'admin_api.admin_cost_analysis'),
    ('POST', '/api/admin/cost-analysis/export', 'admin_api.admin_cost_analysis_export'),
    ('GET', '/api/admin/export', 'admin_api.admin_export'),
    ('GET', '/api/admin/model-pricing', 'admin_api.admin_model_pricing'),
    ('GET', '/api/admin/overview', 'admin_api.admin_overview'),
    ('GET', '/api/admin/prompts', 'admin_api.admin_prompts'),
    ('POST', '/api/analytics/event', 'auth_api.ingest_analytics_event'),
    ('GET', '/api/batch/jobs', 'upload_api.list_batch_jobs'),
    ('GET', '/api/batch/jobs/<batch_id>', 'upload_api.get_batch_job_status'),
    ('GET', '/api/batch/jobs/<batch_id>/download.zip', 'upload_api.download_batch_zip'),
    ('GET', '/api/batch/jobs/<batch_id>/rows/<row_id>/download-docx', 'upload_api.download_batch_row_docx'),
    ('GET', '/api/batch/jobs/<batch_id>/rows/<row_id>/download-flashcards-csv', 'upload_api.download_batch_row_flashcards_csv'),
    ('GET', '/api/auth/user', 'auth_api.get_user'),
    ('POST', '/api/batch/jobs', 'upload_api.create_batch_job'),
    ('GET', '/api/config', 'payments_api.get_config'),
    ('GET', '/api/confirm-checkout-session', 'payments_api.confirm_checkout_session'),
    ('POST', '/api/create-checkout-session', 'payments_api.create_checkout_session'),
    ('POST', '/api/dev/sentry-test', 'auth_api.dev_sentry_test'),
    ('POST', '/api/import-audio-url', 'upload_api.import_audio_url'),
    ('POST', '/api/import-audio-url/release', 'upload_api.release_audio_import'),
    ('POST', '/api/lp-event', 'auth_api.ingest_analytics_event'),
    ('GET', '/api/processing-averages', 'upload_api.processing_averages'),
    ('GET', '/api/processing-estimate', 'upload_api.processing_estimate'),
    ('GET', '/api/physio/cases', 'physio_api.list_physio_cases'),
    ('POST', '/api/physio/cases', 'physio_api.create_physio_case'),
    ('PATCH', '/api/physio/cases/<case_id>', 'physio_api.update_physio_case'),
    ('GET', '/api/physio/cases/<case_id>/sessions', 'physio_api.list_physio_case_sessions'),
    ('POST', '/api/physio/cases/<case_id>/sessions', 'physio_api.create_physio_case_session'),
    ('PATCH', '/api/physio/cases/<case_id>/sessions', 'physio_api.update_physio_case_session'),
    ('POST', '/api/physio/export', 'physio_api.export_physio_payload'),
    ('POST', '/api/physio/knowledge/query', 'physio_api.query_physio_knowledge'),
    ('GET', '/api/physio/knowledge/status', 'physio_api.get_physio_knowledge_status'),
    ('POST', '/api/physio/reasoning', 'physio_api.generate_physio_reasoning'),
    ('POST', '/api/physio/rps', 'physio_api.generate_physio_rps'),
    ('POST', '/api/physio/soap', 'physio_api.generate_physio_soap'),
    ('POST', '/api/physio/transcriptions', 'physio_api.create_physio_transcription'),
    ('GET', '/api/purchase-history', 'payments_api.purchase_history'),
    ('GET', '/api/runtime-jobs/active', 'upload_api.get_active_runtime_jobs'),
    ('DELETE', '/api/planner/sessions/<session_id>', 'study_api.delete_planner_session'),
    ('GET', '/api/planner/sessions', 'study_api.list_planner_sessions'),
    ('PUT', '/api/planner/sessions/<session_id>', 'study_api.upsert_planner_session'),
    ('GET', '/api/planner/settings', 'study_api.get_planner_settings'),
    ('PUT', '/api/planner/settings', 'study_api.update_planner_settings'),
    ('POST', '/api/session/login', 'auth_api.create_admin_session'),
    ('POST', '/api/session/logout', 'auth_api.clear_admin_session'),
    ('POST', '/api/stripe-webhook', 'payments_api.stripe_webhook'),
    ('GET', '/api/study-folders', 'study_api.get_study_folders'),
    ('POST', '/api/study-folders', 'study_api.create_study_folder'),
    ('DELETE', '/api/study-folders/<folder_id>', 'study_api.delete_study_folder'),
    ('PATCH', '/api/study-folders/<folder_id>', 'study_api.update_study_folder'),
    ('GET', '/api/study-folders/<folder_id>/share', 'study_api.get_study_folder_share'),
    ('PUT', '/api/study-folders/<folder_id>/share', 'study_api.update_study_folder_share'),
    ('GET', '/api/study-packs', 'study_api.get_study_packs'),
    ('POST', '/api/study-packs', 'study_api.create_study_pack'),
    ('DELETE', '/api/study-packs/<pack_id>', 'study_api.delete_study_pack'),
    ('GET', '/api/study-packs/<pack_id>', 'study_api.get_study_pack'),
    ('PATCH', '/api/study-packs/<pack_id>', 'study_api.update_study_pack'),
    ('GET', '/api/study-packs/<pack_id>/audio', 'study_api.stream_study_pack_audio'),
    ('POST', '/api/study-packs/<pack_id>/export-annotated-pdf', 'study_api.export_study_pack_annotated_pdf'),
    ('GET', '/api/study-packs/<pack_id>/export-flashcards-csv', 'study_api.export_study_pack_flashcards_csv'),
    ('GET', '/api/study-packs/<pack_id>/export-notes', 'study_api.export_study_pack_notes'),
    ('GET', '/api/study-packs/<pack_id>/export-pdf', 'study_api.export_study_pack_pdf'),
    ('GET', '/api/study-packs/<pack_id>/export-source', 'study_api.export_study_pack_source'),
    ('GET', '/api/study-packs/<pack_id>/share', 'study_api.get_study_pack_share'),
    ('PUT', '/api/study-packs/<pack_id>/share', 'study_api.update_study_pack_share'),
    ('GET', '/api/study-progress', 'study_api.get_study_progress'),
    ('PUT', '/api/study-progress', 'study_api.update_study_progress'),
    ('GET', '/api/study-progress/summary', 'study_api.get_study_progress_summary'),
    ('GET', '/api/shared/<share_token>', 'study_api.get_public_study_share'),
    ('GET', '/api/shared/<share_token>/packs/<pack_id>', 'study_api.get_public_shared_folder_pack'),
    ('POST', '/api/tools/export', 'upload_api.tools_export'),
    ('POST', '/api/tools/extract', 'upload_api.tools_extract'),
    ('GET', '/api/user-preferences', 'auth_api.get_user_preferences'),
    ('PUT', '/api/user-preferences', 'auth_api.update_user_preferences'),
    ('POST', '/api/verify-email', 'auth_api.verify_email'),
    ('GET', '/buy_credits', 'pages.buy_credits_page'),
    ('GET', '/batch_status', 'pages.batch_status_page'),
    ('GET', '/batch_dashboard', 'pages.batch_dashboard_page'),
    ('GET', '/batch_mode', 'pages.batch_mode_page'),
    ('GET', '/batch_mode_interview_transcription', 'pages.batch_mode_interview_page'),
    ('GET', '/batch_mode_slides_extraction', 'pages.batch_mode_slides_page'),
    ('GET', '/calendar', 'pages.calendar_dashboard'),
    ('GET', '/dashboard', 'pages.dashboard'),
    ('GET', '/download-docx/<job_id>', 'upload_api.download_docx'),
    ('GET', '/download-flashcards-csv/<job_id>', 'upload_api.download_flashcards_csv'),
    ('GET', '/document-reader', 'pages.document_reader_page'),
    ('GET', '/features', 'pages.features_page'),
    ('GET', '/FAQ', 'pages.faq_page'),
    ('GET', '/healthz', 'health.healthz'),
    ('GET', '/helpcenter', 'pages.help_center_page'),
    ('GET', '/image-reader', 'pages.image_reader_page'),
    ('GET', '/interview-transcription', 'pages.interview_transcription_page'),
    ('GET', '/lecture-notes', 'pages.lecture_notes_page'),
    ('GET', '/plan', 'pages.plan_dashboard'),
    ('GET', '/privacy', 'pages.privacy_policy'),
    ('GET', '/faq', 'pages.faq_page_lowercase'),
    ('GET', '/physio/cases', 'pages.physio_cases_page'),
    ('GET', '/physio/knowledge', 'pages.physio_knowledge_page'),
    ('GET', '/physio/reasoning', 'pages.physio_reasoning_page'),
    ('GET', '/physio/rps', 'pages.physio_rps_page'),
    ('GET', '/physio/soap', 'pages.physio_soap_page'),
    ('GET', '/slides-extraction', 'pages.slides_extraction_page'),
    ('GET', '/stats', 'pages.plan_dashboard'),
    ('GET', '/status/<job_id>', 'upload_api.get_status'),
    ('GET', '/study', 'pages.study_dashboard'),
    ('GET', '/shared/<share_token>', 'pages.shared_study_page'),
    ('GET', '/terms', 'pages.terms_of_service'),
    ('GET', '/tools', 'pages.tools_page'),
    ('GET', '/url-reader', 'pages.url_reader_page'),
    ('POST', '/upload', 'upload_api.upload_file'),
]


def test_route_contract_snapshot_stable(app):
    actual = []
    for rule in app.url_map.iter_rules():
        if rule.endpoint == 'static':
            continue
        methods = sorted(rule.methods - {'HEAD', 'OPTIONS'})
        for method in methods:
            actual.append((method, str(rule.rule), str(rule.endpoint)))
    assert sorted(actual) == sorted(EXPECTED_ROUTES)


def test_support_pages_and_shell_footer_render_consistent_links(client):
    for path in ['/', '/features', '/helpcenter', '/FAQ', '/privacy', '/terms', '/dashboard']:
        response = client.get(path)
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert 'Help Center' in html
        assert 'FAQ' in html
        assert 'mailto:email@lectureprocessor.com' in html
        assert 'Support' in html


def test_public_pages_share_branding_and_primary_cta(client):
    for path in ['/', '/features', '/helpcenter', '/FAQ']:
        response = client.get(path)
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert 'public-header-brand-text">Lecture Processor<' in html
        assert 'Public navigation' in html

    for path in ['/', '/features']:
        response = client.get(path)
        html = response.get_data(as_text=True)
        assert 'Start Studying' in html
        assert 'Start for Free' not in html


def test_lowercase_faq_redirects_to_canonical_route(client):
    response = client.get('/faq')

    assert response.status_code == 302
    assert response.headers['Location'].endswith('/FAQ')


def test_shared_study_page_renders_public_shell(client):
    response = client.get('/shared/demo-token')

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'SharedStudyConfig' in html
    assert 'demo-token' in html


def test_pricing_pages_render_runtime_bundle_catalog(client, runtime, monkeypatch):
    monkeypatch.setattr(runtime, 'CREDIT_BUNDLES', {
        'lecture_5': {
            'name': 'Lecture Notes - 5 Pack',
            'description': '5 audit lecture credits',
            'credits': {'lecture_credits_standard': 5},
            'price_cents': 1234,
            'currency': 'eur',
        },
        'lecture_10': {
            'name': 'Lecture Notes - 10 Pack',
            'description': '10 audit lecture credits (best value)',
            'credits': {'lecture_credits_standard': 10},
            'price_cents': 1999,
            'currency': 'eur',
        },
        'slides_10': {
            'name': 'Slides - 10 Pack',
            'description': '10 audit slides credits',
            'credits': {'slides_credits': 10},
            'price_cents': 555,
            'currency': 'eur',
        },
        'slides_25': {
            'name': 'Slides - 25 Pack',
            'description': '25 audit slides credits (best value)',
            'credits': {'slides_credits': 25},
            'price_cents': 999,
            'currency': 'eur',
        },
        'interview_3': {
            'name': 'Interview - 3 Pack',
            'description': '3 audit interview credits',
            'credits': {'interview_credits_short': 3},
            'price_cents': 789,
            'currency': 'eur',
        },
        'interview_8': {
            'name': 'Interview - 8 Pack',
            'description': '8 audit interview credits (best value)',
            'credits': {'interview_credits_short': 8},
            'price_cents': 1799,
            'currency': 'eur',
        },
    })

    for path in ['/buy_credits', '/lecture-notes']:
        response = client.get(path)
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert 'data-bundle-id="lecture_5"' in html
        assert 'data-bundle-id="slides_10"' in html
        assert 'data-bundle-id="interview_8"' in html
        assert '5 audit lecture credits' in html
        assert '10 audit slides credits' in html
        assert '3 audit interview credits' in html
        assert 'data-price-cents="1234"' in html
        assert 'data-currency="EUR"' in html
        assert 'best value' in html.lower()


def test_processing_pages_render_updated_shell_labels(client):
    lecture_response = client.get('/lecture-notes')
    assert lecture_response.status_code == 200
    lecture_html = lecture_response.get_data(as_text=True)
    assert '>Lecture Notes<' in lecture_html
    assert '>New Lecture<' not in lecture_html

    batch_response = client.get('/batch_mode')
    assert batch_response.status_code == 200
    batch_html = batch_response.get_data(as_text=True)
    assert '>Batch Processing<' in batch_html
    assert 'Batch Mode Lectures' not in batch_html


def test_shell_and_calendar_modal_overlays_start_hidden(client):
    buy_response = client.get('/buy_credits')
    assert buy_response.status_code == 200
    buy_html = buy_response.get_data(as_text=True)
    assert 'id="shell-export-overlay" hidden aria-hidden="true"' in buy_html

    calendar_response = client.get('/calendar')
    assert calendar_response.status_code == 200
    calendar_html = calendar_response.get_data(as_text=True)
    assert 'id="session-modal-overlay" hidden aria-hidden="true"' in calendar_html


def test_physio_pages_render_open_physio_sidebar_group(client):
    response = client.get('/physio/soap')

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'data-physio-page="soap"' in html
    assert '<div class="app-shell-group app-shell-group-secondary is-open" id="shell-physio-group"' in html
    assert 'aria-controls="shell-physio-panel"' in html
    assert '/physio/cases' in html
