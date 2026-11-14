"""Exercise deployment credit settings through a fresh, isolated app boot."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BOOT_SCRIPT = r'''
import json
from html.parser import HTMLParser
from types import SimpleNamespace
from unittest.mock import patch

with patch('socket.socket.connect', side_effect=AssertionError('External network is disabled')) as network:
    from lecture_processor.runtime.bootstrap import FirebaseInitResult
    with patch('lecture_processor.runtime.bootstrap.load_local_environment'), \
         patch('lecture_processor.runtime.bootstrap.initialize_firebase', return_value=FirebaseInitResult(db=None, init_error='Synthetic boot')), \
         patch('lecture_processor.runtime.bootstrap.initialize_gemini_client', return_value=None):
        from lecture_processor.runtime import core
        core._cleanup_thread = None
        core.RATE_LIMIT_FIRESTORE_ENABLED = False
        from lecture_processor import create_app
        from lecture_processor.runtime.container import get_runtime
        from lecture_processor.domains.billing import policy

        class PricingButtons(HTMLParser):
            def __init__(self, html):
                super().__init__()
                self.bundles = []
                self.feed(html)
            def handle_starttag(self, tag, attributes):
                attributes = dict(attributes)
                if tag == 'button' and attributes.get('data-bundle-id'):
                    self.bundles.append(attributes['data-bundle-id'])

        app = create_app()
        app.config['TESTING'] = True
        runtime = get_runtime(app)
        with app.test_client() as client:
            config_response = client.get('/api/config')
            config = config_response.get_json()
            pricing_response = client.get('/buy_credits')
            pricing = PricingButtons(pricing_response.get_data(as_text=True))
        default_user = core.build_default_user_data('synthetic-user', 'synthetic@example.test')
        observed = {
            'core_enabled': core.UNIFIED_CREDITS_ENABLED,
            'runtime_enabled': policy.is_unified_enabled(runtime),
            'unconfigured_enabled': policy.is_unified_enabled(SimpleNamespace()),
            'converted_uses_unified': policy.uses_unified_credits({'credits_version': 2}, runtime),
            'config_status': config_response.status_code,
            'config_scheme': config.get('credit_scheme'),
            'config_bundles': sorted(config['bundles']),
            'signup_credits': config.get('free_signup_credits'),
            'pricing_status': pricing_response.status_code,
            'pricing_bundles': sorted(pricing.bundles),
            'new_user_version': default_user.get('credits_version'),
            'new_user_credits': default_user.get('credits'),
        }
    network.assert_not_called()
print('CREDIT_ACTIVATION_RESULT=' + json.dumps(observed))
'''


@pytest.mark.parametrize(('setting', 'enabled'), [(None, True), ('0', False), ('1', True)], ids=['deployment-default', 'explicit-off', 'explicit-on'])
def test_fresh_runtime_boot_propagates_credit_activation_to_public_endpoints(tmp_path, setting, enabled):
    # An allowlist excludes local credentials and deployment service settings.
    # cwd is temporary before any application import; local dotenv loading and
    # all external clients are also disabled inside the isolated child process.
    environment = {
        'PATH': os.environ.get('PATH', ''),
        'PYTHONPATH': str(PROJECT_ROOT),
        'APP_ENV': 'test', 'SENTRY_ENVIRONMENT': 'test',
        'FLASK_SECRET_KEY': 'synthetic-activation-test-only',
        'PUBLIC_BASE_URL': 'http://localhost',
        'ENABLE_RUNTIME_JOB_RECOVERY': '0', 'ENABLE_BATCH_JOB_RECOVERY': '0',
        'PYTHONDONTWRITEBYTECODE': '1',
    }
    if setting is not None:
        environment['UNIFIED_CREDITS_ENABLED'] = setting
    result = subprocess.run(
        [sys.executable, '-c', BOOT_SCRIPT], cwd=tmp_path, env=environment,
        capture_output=True, text=True, timeout=40, check=False,
    )
    assert result.returncode == 0, result.stderr
    output = next(line.removeprefix('CREDIT_ACTIVATION_RESULT=') for line in result.stdout.splitlines() if line.startswith('CREDIT_ACTIVATION_RESULT='))
    observed = json.loads(output)
    assert observed['core_enabled'] is enabled
    assert observed['runtime_enabled'] is enabled
    assert observed['unconfigured_enabled'] is False
    assert observed['converted_uses_unified'] is True
    assert observed['config_status'] == observed['pricing_status'] == 200
    expected_bundles = ['credits_200', 'credits_40', 'credits_80'] if enabled else ['interview_3', 'interview_8', 'lecture_10', 'lecture_5', 'slides_10', 'slides_25']
    assert observed['config_bundles'] == expected_bundles
    assert observed['pricing_bundles'] == expected_bundles
    assert observed['config_scheme'] == (2 if enabled else None)
    assert observed['signup_credits'] == (12 if enabled else None)
    assert observed['new_user_version'] == (2 if enabled else None)
    assert observed['new_user_credits'] == (12 if enabled else None)
