from threading import Event

import pytest
from flask import Flask, request

from lecture_processor.runtime.job_dispatcher import BoundedJobDispatcher, JobQueueFullError
from lecture_processor.runtime.proxy import apply_proxy_fix, client_ip_from_request


def test_bounded_job_dispatcher_rejects_when_capacity_is_full_and_recovers():
    dispatcher = BoundedJobDispatcher(max_workers=1, max_pending=0)
    started = Event()
    release = Event()

    def _blocking_job():
        started.set()
        release.wait(1)
        return "done"

    first = dispatcher.submit(_blocking_job)
    assert started.wait(1) is True

    with pytest.raises(JobQueueFullError):
        dispatcher.submit(lambda: "should-not-run")

    release.set()
    assert first.result(timeout=1) == "done"
    assert dispatcher.submit(lambda: "ok").result(timeout=1) == "ok"
    stats = dispatcher.stats()
    assert stats["queued"] == 0
    assert stats["running"] == 0


def test_client_ip_helper_prefers_proxy_fixed_remote_addr_over_spoofable_access_route():
    app = Flask(__name__)
    apply_proxy_fix(app, trusted_proxy_hops=1)

    @app.route("/ip")
    def _ip():
        return {
            "remote_addr": request.remote_addr,
            "access_route": list(request.access_route),
            "client_ip": client_ip_from_request(request),
        }

    with app.test_client() as client:
        response = client.get(
            "/ip",
            headers={"X-Forwarded-For": "198.51.100.9, 203.0.113.17"},
            environ_base={"REMOTE_ADDR": "127.0.0.1"},
        )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["access_route"][0] == "198.51.100.9"
    assert payload["remote_addr"] == "203.0.113.17"
    assert payload["client_ip"] == "203.0.113.17"
