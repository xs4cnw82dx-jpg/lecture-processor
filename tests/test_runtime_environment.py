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


def test_get_public_base_url_uses_dev_default_when_runtime_is_local(monkeypatch):
    monkeypatch.setattr(environment, 'resolve_runtime_environment', lambda default_local='development': 'development')

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
