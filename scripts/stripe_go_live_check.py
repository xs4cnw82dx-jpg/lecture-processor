#!/usr/bin/env python3
"""Stripe go-live verification checks.

Usage examples:
  ./venv/bin/python scripts/stripe_go_live_check.py \
    --base-url https://lecture-processor-1.onrender.com \
    --bearer-token "$FIREBASE_TEST_BEARER" \
    --expect-mode live

  ./venv/bin/python scripts/stripe_go_live_check.py \
    --base-url https://lecture-processor-1.onrender.com \
    --expect-mode test \
    --skip-admin-check
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
    timeout: float = 12.0,
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


def infer_key_mode(key_value: str) -> str:
    key = str(key_value or "").strip()
    if not key:
        return "missing"
    if key.startswith("pk_live_") or key.startswith("sk_live_"):
        return "live"
    if key.startswith("pk_test_") or key.startswith("sk_test_"):
        return "test"
    return "unknown"


class StripeGoLiveChecker:
    def __init__(
        self,
        *,
        base_url: str,
        timeout: float,
        bearer_token: str,
        expect_mode: str,
        skip_admin_check: bool,
        allow_host_mismatch: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.bearer_token = bearer_token.strip()
        self.expect_mode = expect_mode
        self.skip_admin_check = skip_admin_check
        self.allow_host_mismatch = allow_host_mismatch
        self.total = 0
        self.failures = 0

    def _result(self, ok: bool, label: str, detail: str = "") -> None:
        prefix = "PASS" if ok else "FAIL"
        print(f"[{prefix}] {label}")
        if detail:
            print(f"       {detail}")
        if not ok:
            self.failures += 1

    def _check(self, label: str, condition: bool, detail: str = "") -> None:
        self.total += 1
        self._result(bool(condition), label, detail)

    def _request_status(self, label: str, method: str, path: str, expected_status: int, **kwargs: Any) -> Tuple[int, str, Dict[str, str]]:
        self.total += 1
        url = f"{self.base_url}{path}"
        started = time.time()
        try:
            status, body, headers = _request(method, url, timeout=self.timeout, **kwargs)
        except Exception as exc:  # pragma: no cover
            self._result(False, label, f"request error: {exc}")
            return 0, "", {}
        elapsed_ms = int((time.time() - started) * 1000)
        body_preview = body.strip().replace("\n", " ")[:180]
        ok = status == expected_status
        detail = f"expected {expected_status}, got {status} ({elapsed_ms}ms)"
        if body_preview:
            detail += f" | body: {body_preview}"
        self._result(ok, label, detail)
        return status, body, headers

    def run(self) -> int:
        print(f"Running Stripe go-live checks against: {self.base_url}")
        print(f"Expected Stripe mode: {self.expect_mode}")
        print("")

        # Health baseline
        self._request_status("Health endpoint reachable", "GET", "/healthz", 200)

        # Public config check (publishable key mode)
        _status, body, _headers = self._request_status("Config endpoint reachable", "GET", "/api/config", 200)
        publishable_mode = "missing"
        publishable_key = ""
        try:
            parsed = json.loads(body or "{}")
            publishable_key = str(parsed.get("stripe_publishable_key", "") or "").strip()
            publishable_mode = infer_key_mode(publishable_key)
        except Exception as exc:
            self._check("Config response parseable JSON", False, f"invalid json: {exc}")
        else:
            self._check(
                "Publishable key mode matches expected",
                publishable_mode == self.expect_mode,
                f"mode={publishable_mode}, key_prefix={publishable_key[:8] if publishable_key else 'missing'}",
            )

        if self.skip_admin_check:
            self._check("Admin check skipped by flag", True, "--skip-admin-check used")
        else:
            if not self.bearer_token:
                self._check(
                    "Admin bearer token provided",
                    False,
                    "missing token: pass --bearer-token or set FIREBASE_TEST_BEARER",
                )
            else:
                headers = {"Authorization": f"Bearer {self.bearer_token}"}
                _status, body, _headers = self._request_status(
                    "Admin overview reachable with bearer",
                    "GET",
                    "/api/admin/overview?window=24h",
                    200,
                    headers=headers,
                )
                runtime_checks = {}
                deployment = {}
                try:
                    parsed = json.loads(body or "{}")
                    runtime_checks = parsed.get("runtime_checks", {}) or {}
                    deployment = parsed.get("deployment", {}) or {}
                except Exception as exc:
                    self._check("Admin overview parseable JSON", False, f"invalid json: {exc}")
                else:
                    secret_mode = str(runtime_checks.get("stripe_secret_mode", "") or "")
                    pub_mode = str(runtime_checks.get("stripe_publishable_mode", "") or "")
                    keys_match = bool(runtime_checks.get("stripe_keys_match", False))
                    webhook_configured = bool(runtime_checks.get("stripe_webhook_configured", False))
                    self._check(
                        "Admin runtime secret key mode matches expected",
                        secret_mode == self.expect_mode,
                        f"secret_mode={secret_mode}",
                    )
                    self._check(
                        "Admin runtime publishable mode matches expected",
                        pub_mode == self.expect_mode,
                        f"publishable_mode={pub_mode}",
                    )
                    self._check("Secret/publishable mode match each other", keys_match, f"stripe_keys_match={keys_match}")
                    self._check("Webhook secret configured", webhook_configured, f"stripe_webhook_configured={webhook_configured}")

                    host_matches = deployment.get("host_matches_render")
                    if host_matches is False and not self.allow_host_mismatch:
                        self._check(
                            "Deployment host matches Render hostname",
                            False,
                            "host mismatch; use --allow-host-mismatch only for intentional alternate host checks",
                        )
                    else:
                        self._check(
                            "Deployment host check",
                            True,
                            f"host_matches_render={host_matches}",
                        )

        print("")
        passed = self.total - self.failures
        print(f"Summary: {passed}/{self.total} checks passed.")
        if self.failures:
            print("Stripe go-live status: FAILED")
            return 1
        print("Stripe go-live status: PASSED")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Stripe go-live verification checks.")
    parser.add_argument("--base-url", required=True, help="Base URL (example: https://lecture-processor-1.onrender.com)")
    parser.add_argument("--timeout", default=12.0, type=float, help="Request timeout seconds")
    parser.add_argument("--bearer-token", default="", help="Admin Firebase bearer token")
    parser.add_argument("--expect-mode", default="live", choices=["live", "test"], help="Expected Stripe key mode")
    parser.add_argument("--skip-admin-check", action="store_true", help="Skip admin overview checks when no admin token is available")
    parser.add_argument("--allow-host-mismatch", action="store_true", help="Do not fail if deployment host mismatch is reported")
    args = parser.parse_args()

    token = args.bearer_token.strip() or os.getenv("FIREBASE_TEST_BEARER", "").strip()
    checker = StripeGoLiveChecker(
        base_url=args.base_url,
        timeout=args.timeout,
        bearer_token=token,
        expect_mode=args.expect_mode,
        skip_admin_check=args.skip_admin_check,
        allow_host_mismatch=args.allow_host_mismatch,
    )
    return checker.run()


if __name__ == "__main__":
    raise SystemExit(main())
