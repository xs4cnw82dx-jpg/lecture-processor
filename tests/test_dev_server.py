from lecture_processor.runtime.dev_server import should_enable_debug


def test_should_enable_debug_defaults_to_false():
    assert should_enable_debug(env={}) is False


def test_should_enable_debug_accepts_truthy_values():
    for value in ('1', 'true', 'TRUE', 'yes', 'on'):
        assert should_enable_debug(env={'FLASK_DEBUG': value}) is True


def test_should_enable_debug_rejects_falsey_values():
    for value in ('0', 'false', 'no', 'off', '', '  '):
        assert should_enable_debug(env={'FLASK_DEBUG': value}) is False
