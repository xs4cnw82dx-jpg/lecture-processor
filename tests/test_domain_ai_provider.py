from lecture_processor.domains.ai import provider
from lecture_processor.runtime.container import get_runtime


def test_ai_provider_dispatch_uses_explicit_runtime():
    class _Accumulator:
        def __init__(self, label):
            self.label = label

    class _Runtime:
        TokenAccumulator = _Accumulator

        def classify_provider_error_code(self, error):
            return f"code:{error}"

        def run_with_provider_retry(self, name, fn, retry_tracker=None):
            return {"name": name, "value": fn(), "retry_tracker": retry_tracker}

        def generate_with_policy(self, model, contents, **kwargs):
            return {"model": model, "contents": contents, "kwargs": kwargs}

    runtime = _Runtime()
    accumulator = provider.TokenAccumulator("tok", runtime=runtime)
    assert isinstance(accumulator, _Accumulator)
    assert accumulator.label == "tok"
    assert provider.classify_provider_error_code("bad", runtime=runtime) == "code:bad"
    assert provider.run_with_provider_retry("op", lambda: 7, retry_tracker={"a": 1}, runtime=runtime) == {
        "name": "op",
        "value": 7,
        "retry_tracker": {"a": 1},
    }
    assert provider.generate_with_policy("m1", ["x"], temperature=0.2, runtime=runtime) == {
        "model": "m1",
        "contents": ["x"],
        "kwargs": {"temperature": 0.2},
    }


def test_ai_provider_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "classify_provider_error_code", lambda error: f"runtime:{error}")

    with app.app_context():
        assert provider.classify_provider_error_code("x") == "runtime:x"
