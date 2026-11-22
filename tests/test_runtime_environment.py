from lecture_processor.runtime import environment


def test_render_detection_overrides_dev_environment():
    environ = {
        'RENDER': 'true',
        'APP_ENV': 'development',
        'FLASK_DEBUG': '1',
    }

    assert environment.is_render_environment(environ=environ) is True
    assert environment.is_dev_environment(environ=environ) is False


def test_get_public_base_url_prefers_valid_configured_value():
    environ = {'PUBLIC_BASE_URL': 'https://lectureprocessor.com/path?ignored=yes'}

    assert environment.get_public_base_url(environ=environ) == 'https://lectureprocessor.com'


def test_get_public_base_url_uses_dev_default_when_runtime_is_local():
    assert environment.get_public_base_url(environ={}) == 'http://127.0.0.1:5000'


def test_should_use_minified_js_assets_defaults_to_true_outside_dev():
    assert environment.should_use_minified_js_assets(environ={'APP_ENV': 'production'}) is True
    assert environment.should_use_minified_js_assets(environ={'APP_ENV': 'development'}) is False
    assert environment.should_use_minified_js_assets(environ={'USE_MINIFIED_JS_ASSETS': 'true'}) is True


def test_resolve_js_asset_prefers_minified_file_when_available(tmp_path):
    static_dir = tmp_path / 'static' / 'js'
    static_dir.mkdir(parents=True)
    (static_dir / 'index-app.min.js').write_text('// minified', encoding='utf-8')

    asset_name = environment.resolve_js_asset(
        'js/index-app.js',
        project_root_dir=str(tmp_path),
        environ={'APP_ENV': 'production'},
    )

    assert asset_name == 'js/index-app.min.js'


def test_build_admin_deployment_info_reports_host_status():
    info = environment.build_admin_deployment_info(
        'lectureprocessor.com',
        environ={
            'RENDER': 'true',
            'RENDER_EXTERNAL_HOSTNAME': 'lecture-processor.onrender.com',
            'RENDER_SERVICE_NAME': 'lecture-processor',
        },
        public_base_url='https://lectureprocessor.com',
        app_boot_ts=100.0,
        now_ts=160.0,
    )

    assert info['runtime'] == 'render'
    assert info['host_status'] == 'custom-domain'
    assert info['service_name'] == 'lecture-processor'
    assert info['app_uptime_seconds'] == 60.0


def test_injected_public_url_fallback_uses_the_supplied_environment(monkeypatch):
    monkeypatch.setenv('APP_ENV', 'development')
    assert environment.get_public_base_url(environ={'APP_ENV': 'production'}) == ''
    assert environment.get_public_base_url(environ={'RENDER': 'true', 'APP_ENV': 'test'}) == ''


def test_legacy_environment_names_retain_their_distinct_precedence():
    local = {'ENV': 'staging', 'FLASK_ENV': 'development'}
    assert environment.resolve_sentry_environment(environ=local) == 'staging'
    assert environment.resolve_runtime_environment(environ=local) == 'development'
    assert environment.resolve_sentry_environment(environ={}) == 'production'
    assert environment.resolve_runtime_environment(environ={}) == 'development'
    on_render = {**local, 'RENDER': '1', 'SENTRY_ENVIRONMENT': 'test'}
    assert environment.resolve_runtime_environment(environ=on_render) == 'production'
    assert environment.resolve_sentry_environment(environ=on_render) == 'production'


def test_enabled_by_default_flags_keep_their_legacy_blank_behavior():
    assert environment.env_truthy('SMTP_USE_TLS', '1', environ={'SMTP_USE_TLS': ''})
    assert not environment.env_truthy(
        'ENABLE_BATCH_JOB_RECOVERY', '1', environ={'ENABLE_BATCH_JOB_RECOVERY': ''}, blank_uses_default=False,
    )
