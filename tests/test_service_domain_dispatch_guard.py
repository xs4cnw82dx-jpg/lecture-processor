from pathlib import Path


DISPATCH_METHODS = [
    'build_admin_deployment_info',
    'build_admin_funnel_daily_rows',
    'build_admin_funnel_steps',
    'build_admin_runtime_checks',
    'build_study_pack_pdf',
    'build_time_buckets',
    'check_daily_upload_quota',
    'classify_provider_error_code',
    'compute_study_progress_summary',
    'deduct_credit',
    'deduct_interview_credit',
    'deduct_slides_credits',
    'extract_token_usage',
    'generate_with_policy',
    'get_admin_data_warnings',
    'get_admin_window',
    'get_audio_storage_key_from_pack',
    'get_bucket_key',
    'get_model_pricing_config',
    'get_timestamp',
    'initialize_billing_receipt',
    'merge_card_state_maps',
    'merge_streak_data',
    'merge_timezone_value',
    'normalize_exam_date',
    'parse_audio_markers_from_notes',
    'process_interview_transcription',
    'process_lecture_notes',
    'process_slides_only',
    'refund_credit',
    'refund_slides_credits',
    'remove_pack_audio_file',
    'resolve_audio_storage_path_from_key',
    'run_with_provider_retry',
    'safe_count_collection',
    'safe_count_window',
    'safe_query_docs_in_window',
    'sanitize_card_state_map',
    'sanitize_daily_goal_value',
    'sanitize_pack_id',
    'sanitize_streak_data',
    'sanitize_timezone_name',
]


def test_services_do_not_call_domainized_helpers_directly_on_runtime():
    service_paths = sorted(Path('lecture_processor/services').glob('*_api_service.py'))
    for path in service_paths:
        text = path.read_text(encoding='utf-8')
        for method in DISPATCH_METHODS:
            assert f'app_ctx.{method}(' not in text, f'{path} still calls app_ctx.{method} directly'
