#!/usr/bin/env python3
"""Closed, values-free pre-XCTest readiness gate for the awake fixture.

Runtime output is exactly one fixed outcome. Live response bodies, fixture ids,
model names, providers, origins, credentials and errors are never printed.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

READY = "assistant-fixture-ready"
MODEL_MISSING = "assistant-fixture-model-missing"
CREDENTIAL_MISSING = "assistant-fixture-credential-missing"
RECONNECT_REQUIRED = "assistant-fixture-reconnect-required"
OUTCOMES = (READY, MODEL_MISSING, CREDENTIAL_MISSING, RECONNECT_REQUIRED)


def _rows(value: Any, key: str) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or not isinstance(value.get(key), list):
        return []
    return [row for row in value[key] if isinstance(row, dict)]


def _fixture(pods: Any, short_id: str) -> dict[str, Any] | None:
    tail = short_id.split("-")[-1].replace("-", "")
    if not tail:
        return None
    matches = [
        row for row in _rows(pods, "pods")
        if str(row.get("id", "")).replace("-", "").endswith(tail)
    ]
    return matches[0] if len(matches) == 1 else None


def classify(pods: Any, credentials: Any, short_id: str) -> str:
    pod = _fixture(pods, short_id)
    if pod is None:
        return MODEL_MISSING
    report = pod.get("report") if isinstance(pod.get("report"), dict) else {}
    config = report.get("config") if isinstance(report.get("config"), dict) else {}
    pi = config.get("pi") if isinstance(config.get("pi"), dict) else {}
    model = pi.get("model")
    if not isinstance(model, str) or model.strip() != model or "/" not in model:
        return MODEL_MISSING
    provider, model_id = model.split("/", 1)
    if not provider or not model_id:
        return MODEL_MISSING

    matching = [
        row for row in _rows(credentials, "credentials")
        if row.get("providerId") == provider
    ]
    if any(row.get("state") == "reconnect_required" for row in matching):
        return RECONNECT_REQUIRED
    if len(matching) != 1 or matching[0].get("state") != "ready":
        return CREDENTIAL_MISSING

    resolved = pod.get("resolvedConfig") if isinstance(pod.get("resolvedConfig"), dict) else {}
    ready_providers = resolved.get("piAuthProviders")
    if not isinstance(ready_providers, list) or provider not in ready_providers:
        return CREDENTIAL_MISSING
    return READY


def _request(origin: str, path: str, bearer: str) -> Any | None:
    request = urllib.request.Request(
        origin.rstrip("/") + path,
        headers={"authorization": "Bearer " + bearer, "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                return None
            return json.loads(response.read())
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return None


def selftest() -> int:
    def pod(model: Any = "openrouter/vendor/model", providers: Any = None) -> dict[str, Any]:
        return {
            "pods": [{
                "id": "00000000-0000-0000-0000-00000000abcd",
                "report": {"config": {"pi": {"model": model}}},
                "resolvedConfig": {"piAuthProviders": ["openrouter"] if providers is None else providers},
            }]
        }

    def credentials(state: str = "ready") -> dict[str, Any]:
        return {"credentials": [{"providerId": "openrouter", "state": state}]}

    assert classify(pod(), credentials(), "p-000000abcd") == READY
    assert classify(pod(model=None), credentials(), "p-000000abcd") == MODEL_MISSING
    assert classify(pod(), {"credentials": []}, "p-000000abcd") == CREDENTIAL_MISSING
    assert classify(pod(), credentials("reconnect_required"), "p-000000abcd") == RECONNECT_REQUIRED
    assert classify(pod(providers=[]), credentials(), "p-000000abcd") == CREDENTIAL_MISSING
    assert classify(pod(), credentials(), "p-wrong") == MODEL_MISSING

    hostile = {
        "pods": [{
            "id": "00000000-0000-0000-0000-00000000abcd",
            "name": "Bearer SUPERSECRET",
            "report": {"config": {"pi": {"model": "openrouter/vendor/model"}}},
            "resolvedConfig": {"piAuthProviders": ["openrouter", "hunter2"]},
        }]
    }
    outcome = classify(hostile, credentials(), "p-000000abcd")
    assert outcome == READY and outcome in OUTCOMES
    assert all(trap not in outcome for trap in ("SUPERSECRET", "Bearer", "hunter2", "vendor"))
    assert {classify(pod(), credentials(state), "p-000000abcd") for state in
            ("ready", "reconnect_required", "temporarily_unavailable")} <= set(OUTCOMES)
    print("selftest: assistant fixture preflight is closed and values-free")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--selftest"]:
        return selftest()
    if sys.argv[1:]:
        return 2

    origin = os.environ.get("SERVER_URL_IN") or os.environ.get("UITEST_SERVER_URL", "")
    short_id = os.environ.get("FIXTURE_POD_IN") or os.environ.get("UITEST_FIXTURE_POD_ID", "")
    bearer = os.environ.get("UITEST_COMPANION_BEARER", "")
    parsed = urllib.parse.urlsplit(origin)
    if not origin or not short_id or not bearer or parsed.scheme not in ("http", "https") or not parsed.netloc:
        outcome = CREDENTIAL_MISSING
    else:
        pods = _request(origin, "/v1/pods", bearer)
        credentials = _request(origin, "/v1/model-credentials", bearer)
        outcome = classify(pods, credentials, short_id)
    print(outcome)
    return 0 if outcome == READY else 1


if __name__ == "__main__":
    raise SystemExit(main())
