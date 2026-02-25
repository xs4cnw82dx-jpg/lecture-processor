#!/usr/bin/env python3
"""Lightweight smoke tests for launch-critical HTTP routes.

Usage:
  ./venv/bin/python scripts/smoke_test.py
  ./venv/bin/python scripts/smoke_test.py --base-url https://your-domain.com
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple


def _request(
    method: str,
    url: str,
    *,
    json_body: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 10.0,
) -> Tuple[int, str, Dict[str, str]]:
    payload = None
    request_headers: Dict[str, str] = dict(headers or {})
    if json_body is not None:
        payload = json.dumps(json_body).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url=url, data=payload, method=method.upper(), headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = int(response.getcode())
            response_headers = {k: v for k, v in response.getheaders()}
            return status, body, response_headers
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        response_headers = {k: v for k, v in exc.headers.items()}
        return int(exc.code), body, response_headers


class SmokeRunner:
    def __init__(self, base_url: str, timeout: float, bearer_token: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.bearer_token = bearer_token.strip()
        self.failures = 0
        self.total = 0

    def _print_result(self, ok: bool, label: str, detail: str = "") -> None:
        prefix = "PASS" if ok else "FAIL"
        print(f"[{prefix}] {label}")
        if detail:
            print(f"       {detail}")
        if not ok:
            self.failures += 1

    def _expect_status(self, label: str, method: str, path: str, expected_status: int, **kwargs: Any) -> Tuple[int, str, Dict[str, str]]:
        self.total += 1
        url = f"{self.base_url}{path}"
        started = time.time()
        try:
            status, body, headers = _request(method, url, timeout=self.timeout, **kwargs)
        except Exception as exc:
            self._print_result(False, label, f"request error: {exc}")
            return 0, "", {}
        elapsed_ms = int((time.time() - started) * 1000)
        ok = status == expected_status
        body_preview = body.strip().replace("\n", " ")[:140]
        detail = f"expected {expected_status}, got {status} ({elapsed_ms}ms)"
        if body_preview:
            detail += f" | body: {body_preview}"
        self._print_result(ok, label, detail)
        return status, body, headers

    def run(self) -> int:
        print(f"Running smoke tests against: {self.base_url}")
        print(f"Timeout per request: {self.timeout:.1f}s")
        print("")

        # Public pages
        self._expect_status("Home page reachable", "GET", "/", 200)
        self._expect_status("Dashboard page reachable", "GET", "/dashboard", 200)
        self._expect_status("Privacy page reachable", "GET", "/privacy", 200)
        self._expect_status("Terms page reachable", "GET", "/terms", 200)

        # Public API sanity
        _status, body, _headers = self._expect_status(
            "Verify-email allows student domain",
            "POST",
            "/api/verify-email",
            200,
            json_body={"email": "student@st.hanze.nl"},
        )
        self.total += 1
        try:
            parsed = json.loads(body or "{}")
            self._print_result(parsed.get("allowed") is True, "Verify-email allowed=true for st.hanze.nl")
        except Exception as exc:
            self._print_result(False, "Verify-email allowed=true for st.hanze.nl", f"invalid json: {exc}")

        _status, body, _headers = self._expect_status(
            "Verify-email blocks unknown domain",
            "POST",
            "/api/verify-email",
            200,
            json_body={"email": "user@unknown-domain.invalid"},
        )
        self.total += 1
        try:
            parsed = json.loads(body or "{}")
            self._print_result(parsed.get("allowed") is False, "Verify-email allowed=false for unknown domain")
        except Exception as exc:
            self._print_result(False, "Verify-email allowed=false for unknown domain", f"invalid json: {exc}")

        self._expect_status("Stripe config endpoint reachable", "GET", "/api/config", 200)

        # Unauthorized guardrails
        self._expect_status("Account export requires auth", "GET", "/api/account/export", 401)
        self._expect_status("Account delete requires auth", "POST", "/api/account/delete", 401, json_body={})
        self._expect_status(
            "Checkout create requires auth",
            "POST",
            "/api/create-checkout-session",
            401,
            json_body={"bundle_id": "lecture_5"},
        )
        self._expect_status(
            "Upload requires auth",
            "POST",
            "/upload",
            401,
            json_body={"mode": "slides-only"},
        )

        # Analytics endpoint validation (no auth)
        self._expect_status(
            "Analytics endpoint rejects invalid event name",
            "POST",
            "/api/lp-event",
            400,
            json_body={"event": "INVALID-EVENT", "session_id": "manualtest123"},
        )

        if self.bearer_token:
            auth_headers = {"Authorization": f"Bearer {self.bearer_token}"}
            self._expect_status("Authenticated /api/auth/user", "GET", "/api/auth/user", 200, headers=auth_headers)
            self._expect_status("Authenticated account export", "GET", "/api/account/export", 200, headers=auth_headers)
        else:
            print("")
            print("Note: Skipped authenticated smoke checks (set FIREBASE_TEST_BEARER to enable).")

        print("")
        passed = self.total - self.failures
        print(f"Summary: {passed}/{self.total} checks passed.")
        if self.failures:
            print("Smoke test status: FAILED")
            return 1
        print("Smoke test status: PASSED")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run launch smoke tests.")
    parser.add_argument("--base-url", default="http://127.0.0.1:5000", help="Base URL for the app (default: http://127.0.0.1:5000)")
    parser.add_argument("--timeout", default=10.0, type=float, help="Request timeout in seconds")
    parser.add_argument("--bearer-token", default="", help="Optional Firebase bearer token for authenticated checks")
    args = parser.parse_args()

    token = args.bearer_token.strip() or os.getenv("FIREBASE_TEST_BEARER", "").strip()

    runner = SmokeRunner(base_url=args.base_url, timeout=args.timeout, bearer_token=token)
    return runner.run()


if __name__ == "__main__":
    raise SystemExit(main())
