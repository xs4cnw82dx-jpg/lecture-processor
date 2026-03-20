from types import SimpleNamespace

from lecture_processor.domains.study import progress as study_progress
from lecture_processor.runtime import media_runtime
from lecture_processor.runtime import core


def test_core_study_progress_wrappers_match_domain_logic():
    runtime = core._self_runtime()
    server = {
        "last_study_date": "2026-02-26",
        "current_streak": 4,
        "daily_progress_date": "2026-02-26",
        "daily_progress_count": 7,
    }
    incoming = {
        "last_study_date": "2026-02-25",
        "current_streak": 1,
        "daily_progress_date": "2026-02-25",
        "daily_progress_count": 2,
    }
    progress_data = {
        "daily_goal": 20,
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 2,
        },
    }
    card_state_maps = [
        {
            "fc_1": {
                "seen": 1,
                "correct": 1,
                "wrong": 0,
                "interval_days": 1,
                "next_review_date": "2026-02-26",
            }
        }
    ]

    assert core.merge_streak_data(server, incoming) == study_progress.merge_streak_data(
        server,
        incoming,
        runtime=runtime,
    )
    assert core.compute_study_progress_summary(
        progress_data,
        card_state_maps,
        base_now=core.datetime(2026, 2, 25, 23, 30, tzinfo=core.timezone.utc),
    ) == study_progress.compute_study_progress_summary(
        progress_data,
        card_state_maps,
        base_now=core.datetime(2026, 2, 25, 23, 30, tzinfo=core.timezone.utc),
        runtime=runtime,
    )


def test_media_runtime_wait_for_file_processing_retries_transient_errors():
    class _FilesClient:
        def __init__(self):
            self.calls = 0

        def get(self, name):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("temporary timeout")
            return SimpleNamespace(state=SimpleNamespace(name="ACTIVE"))

    messages = []
    client = SimpleNamespace(files=_FilesClient())
    logger = SimpleNamespace(warning=lambda *args: messages.append(args))
    uploaded_file = SimpleNamespace(name="files/abc123")

    result = media_runtime.wait_for_file_processing(
        uploaded_file,
        client=client,
        logger=logger,
        time_module=SimpleNamespace(sleep=lambda _seconds: None),
        is_transient_provider_error_fn=lambda _error: True,
        classify_provider_error_code_fn=lambda _error: "timeout",
        max_wait_time=5,
        wait_interval=1,
    )

    assert result is True
    assert messages
