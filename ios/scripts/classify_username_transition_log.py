#!/usr/bin/env python3
"""Values-free classifier for username-to-Pods auth transition evidence.

Reads a private xcodebuild log from stdin and emits only fixed marker counts,
closed categories, and known error-category counts. It never emits source lines,
element values, lengths, page text, URLs, or credentials.
"""
import json
import sys

SCHEMA = "ios-username-transition-diagnostic/v13"
STAGES = (
    "idp-page-load-started",
    "idp-page-load-completed",
    "username-field-exists-started",
    "username-field-exists-completed",
    "username-field-enabled-started",
    "username-field-enabled-completed",
    "username-field-hittable-started",
    "username-field-hittable-completed",
    "username-field-visible-ready",
    "username-focus-started",
    "username-focus-completed",
    "username-typing-started",
    "username-typing-completed",
    "exact-control-ready",
    "username-value-check-started",
    "username-value-check-completed",
    "username-value-matched",
    "username-exact-control-started",
    "username-exact-control-completed",
    "exact-control-revalidated",
    "exact-control-tapped",
    "tap-effect-check-started",
    "tap-effect-webview-gap-seen",
    "tap-effect-check-completed",
    "tap-effect-check-no-effect",
    "tap-effect-username-field-gone",
    "tap-effect-password-field-present",
    "tap-effect-webview-reload-observed",
    "tap-effect-retry-required",
    "tap-effect-retry-control-revalidated",
    "tap-effect-retry-tapped",
    "username-tap-effect-started",
    "username-tap-effect-completed",
    "password-wait-started",
    "password-username-advance-still-ready",
    "password-username-advance-no-longer-ready",
    "password-webview-gap-seen",
    "password-webview-present",
    "password-webview-reacquired",
    "password-nonsecure-form-seen",
    "password-nonsecure-form-exact-control-seen",
    "password-interstitial-seen",
    "password-interstitial-control-revalidated",
    "password-interstitial-advanced",
    "password-field-visible-ready",
    "password-field-revalidated",
    "password-entry-started",
    "password-entry-field-unique",
    "password-entry-field-ready",
    "password-entry-prestate-accepted",
    "password-entry-focus-started",
    "password-entry-focus-completed",
    "password-entry-typing-started",
    "password-entry-typing-completed",
    "password-entry-commit-check-started",
    "password-entry-commit-check-completed",
    "password-entry-live-field-revalidated",
    "password-entry-plaintext-equality",
    "password-entry-masked-occupancy-delivery",
    "password-entry-completed",
    "password-enter-precheck-started",
    "password-enter-precheck-webview-owned",
    "password-enter-precheck-field-unique",
    "password-enter-precheck-field-ready",
    "password-enter-precheck-boundary-unchanged",
    "password-enter-precheck-completed",
    "password-enter-focus-started",
    "password-enter-focus-completed",
    "password-enter-postfocus-started",
    "password-enter-postfocus-webview-owned",
    "password-enter-postfocus-field-unique",
    "password-enter-postfocus-field-ready",
    "password-enter-postfocus-boundary-unchanged",
    "password-enter-postfocus-completed",
    "password-enter-action-started",
    "password-enter-action-completed",
    "password-enter-effect-check-started",
    "password-enter-effect-check-completed",
    "password-enter-effect-wait-failed",
    "password-enter-effect-unobserved",
    "password-enter-effect-password-field-gone",
    "password-enter-effect-callback-boundary",
    "callback-wait-started",
    "callback-browser-disappeared",
    "callback-pods-authoritative",
    "callback-received",
    "callback-wait-completed",
    "pods-wait-started",
    "pods-visible-ready",
)
CONTROLS = ("next", "continue", "sign-in")
OWNED_WEBVIEW_COUNTS = (
    "webview-count-1", "webview-count-2", "webview-count-3+",
)
USERNAME_VALUE_CHECK_RESULTS = (
    "matched", "timeout-mismatch", "webview-missing", "webview-nonunique",
    "field-missing", "field-nonunique", "field-not-ready",
    "value-unobservable",
)
PASSWORD_INTERSTITIAL_CONTROLS = CONTROLS
PASSWORD_ENTRY_RESULTS = (
    "plaintext-equality", "changed-masked-occupancy-delivery",
    "mismatch", "unobservable", "placeholder", "no-change", "prefilled",
    "nonunique", "not-ready", "wait-failed",
)
PASSWORD_ENTER_ACTIONS = ("return",)
CALLBACK_OBSERVATIONS = (
    "pods-direct", "browser-disappeared-then-pods",
    "timeout-browser-present", "timeout-after-browser-disappeared",
    "wait-failed",
)
PODS_ASSERTION_RESULTS = ("success", "failure")
ERRORS = (
    "idp-page-load-timeout",
    "idp-page-load-wait-failed",
    "username-field-exists-timeout",
    "username-field-exists-wait-failed",
    "username-field-enabled-timeout",
    "username-field-enabled-wait-failed",
    "username-field-hittable-timeout",
    "username-field-hittable-wait-failed",
    "username-focus-timeout",
    "username-typing-timeout",
    "username-value-check-timeout",
    "username-value-check-webview-missing",
    "username-value-check-webview-nonunique",
    "username-value-check-field-missing",
    "username-value-check-field-nonunique",
    "username-value-check-field-not-ready",
    "username-value-check-value-unobservable",
    "username-exact-control-timeout",
    "username-tap-effect-timeout",
    "username-tap-effect-failed",
    "username-field-missing",
    "username-field-not-ready",
    "username-value-mismatch",
    "username-value-wait-failed",
    "control-missing",
    "control-disabled",
    "control-not-hittable",
    "tap-effect-wait-failed",
    "tap-effect-retry-control-missing",
    "tap-effect-retry-control-disabled",
    "tap-effect-retry-control-not-hittable",
    "tap-no-effect",
    "password-username-advance-stalled",
    "password-webview-missing",
    "password-interstitial-control-not-ready",
    "password-interstitial-control-missing",
    "password-interstitial-control-disabled",
    "password-interstitial-control-not-hittable",
    "password-interstitial-stalled",
    "password-field-missing",
    "password-field-not-ready",
    "password-entry-mismatch",
    "password-entry-unobservable",
    "password-entry-placeholder",
    "password-entry-no-change",
    "password-entry-prefilled",
    "password-entry-field-nonunique",
    "password-entry-field-not-ready",
    "password-entry-wait-failed",
    "password-entry-commit-timeout",
    "password-enter-webview-nonunique",
    "password-enter-webview-not-ready",
    "password-enter-field-nonunique",
    "password-enter-field-not-ready",
    "password-enter-boundary-unobservable",
    "password-enter-boundary-changed",
    "callback-wait-timeout",
    "callback-wait-failed",
    "pods-wait-timeout",
    "pods-wait-failed",
)


def exact_marker_counts(lines, prefix, names):
    """Count complete marker lines after splitlines removes XCTest CR/CRLF."""
    return {name: lines.count(prefix + name) for name in names}


def closed_category(counts):
    chosen = [name for name, count in counts.items() if count > 0]
    return chosen[0] if len(chosen) == 1 else (
        "absent" if not chosen else "multiple")


def classify(text):
    lines = text.splitlines()
    stage_counts = exact_marker_counts(
        lines, "PIPOD_USERNAME_TRANSITION_STAGE=", STAGES)
    control_counts = exact_marker_counts(
        lines, "PIPOD_USERNAME_TRANSITION_CONTROL=", CONTROLS)
    webview_count_counts = exact_marker_counts(
        lines, "PIPOD_OWNED_WEBVIEW_COUNT=", OWNED_WEBVIEW_COUNTS)
    username_value_counts = exact_marker_counts(
        lines, "PIPOD_USERNAME_VALUE_CHECK_RESULT=",
        USERNAME_VALUE_CHECK_RESULTS)
    interstitial_counts = exact_marker_counts(
        lines, "PIPOD_PASSWORD_INTERSTITIAL_CONTROL=",
        PASSWORD_INTERSTITIAL_CONTROLS)
    entry_counts = exact_marker_counts(
        lines, "PIPOD_PASSWORD_ENTRY_RESULT=", PASSWORD_ENTRY_RESULTS)
    enter_action_counts = exact_marker_counts(
        lines, "PIPOD_PASSWORD_ENTER_ACTION=", PASSWORD_ENTER_ACTIONS)
    callback_observation_counts = exact_marker_counts(
        lines, "PIPOD_CALLBACK_OBSERVATION=", CALLBACK_OBSERVATIONS)
    pods_counts = exact_marker_counts(
        lines, "PIPOD_PODS_ASSERTION_RESULT=", PODS_ASSERTION_RESULTS)
    error_counts = exact_marker_counts(
        lines, "PIPOD_USERNAME_TRANSITION_ERROR=", ERRORS)
    return {
        "schema": SCHEMA,
        "stage_counts": stage_counts,
        "stage_seen": {name: count > 0 for name, count in stage_counts.items()},
        "control": closed_category(control_counts),
        "control_counts": control_counts,
        "owned_webview_count": closed_category(webview_count_counts),
        "owned_webview_count_counts": webview_count_counts,
        "username_value_check_result": closed_category(username_value_counts),
        "username_value_check_result_counts": username_value_counts,
        "password_interstitial_control": closed_category(interstitial_counts),
        "password_interstitial_control_counts": interstitial_counts,
        "password_entry_result": closed_category(entry_counts),
        "password_entry_result_counts": entry_counts,
        "password_enter_action": closed_category(enter_action_counts),
        "password_enter_action_counts": enter_action_counts,
        "callback_observation": closed_category(callback_observation_counts),
        "callback_observation_counts": callback_observation_counts,
        "pods_assertion_result": closed_category(pods_counts),
        "pods_assertion_result_counts": pods_counts,
        "error_counts": error_counts,
        "has_known_error": any(error_counts.values()),
    }


def selftest() -> int:
    hostile_lines = [
        "password=do-not-print https://example.invalid/?code=secret",
        "Bearer private-value",
        "PIPOD_OWNED_WEBVIEW_COUNT=webview-count-2/private-secret",
        "PIPOD_USERNAME_VALUE_CHECK_RESULT=matched/private-secret",
        "PIPOD_PASSWORD_ENTRY_RESULT=plaintext-equality/private-secret",
        "PIPOD_PASSWORD_ENTER_ACTION=return/private-secret",
        "PIPOD_CALLBACK_OBSERVATION=pods-direct/private-secret",
        "PIPOD_USERNAME_TRANSITION_STAGE=password-enter-action-completed/private-secret",
        "PIPOD_USERNAME_TRANSITION_CONTROL=next private-secret",
        "PIPOD_USERNAME_TRANSITION_ERROR=pods-wait-timeout.private-secret",
        "PIPOD_PODS_ASSERTION_RESULT=private-value",
    ]
    hostile_lines.extend(
        "PIPOD_USERNAME_TRANSITION_STAGE=" + name + "\r" for name in STAGES)
    hostile_lines.append("PIPOD_USERNAME_TRANSITION_CONTROL=next\r")
    hostile_lines.extend(
        "PIPOD_OWNED_WEBVIEW_COUNT=" + name + "\r"
        for name in OWNED_WEBVIEW_COUNTS)
    hostile_lines.extend(
        "PIPOD_USERNAME_VALUE_CHECK_RESULT=" + name + "\r"
        for name in USERNAME_VALUE_CHECK_RESULTS)
    hostile_lines.append("PIPOD_PASSWORD_INTERSTITIAL_CONTROL=continue\r")
    hostile_lines.extend(
        "PIPOD_PASSWORD_ENTRY_RESULT=" + name + "\r"
        for name in PASSWORD_ENTRY_RESULTS)
    hostile_lines.append("PIPOD_PASSWORD_ENTER_ACTION=return\r")
    hostile_lines.extend(
        "PIPOD_CALLBACK_OBSERVATION=" + name + "\r"
        for name in CALLBACK_OBSERVATIONS)
    hostile_lines.append("PIPOD_PODS_ASSERTION_RESULT=success\r")
    hostile_lines.extend(
        "PIPOD_USERNAME_TRANSITION_ERROR=" + name + "\r" for name in ERRORS)
    out = classify("\n".join(hostile_lines))
    blob = json.dumps(out)
    if any(value in blob for value in (
            "do-not-print", "example.invalid", "secret", "Bearer",
            "private-value")):
        print("selftest: transition diagnostic leaked a value", file=sys.stderr)
        return 1
    expected_keys = {
        "schema", "stage_counts", "stage_seen", "control", "control_counts",
        "owned_webview_count", "owned_webview_count_counts",
        "username_value_check_result", "username_value_check_result_counts",
        "password_interstitial_control",
        "password_interstitial_control_counts", "password_entry_result",
        "password_entry_result_counts", "password_enter_action",
        "password_enter_action_counts", "callback_observation",
        "callback_observation_counts", "pods_assertion_result",
        "pods_assertion_result_counts", "error_counts", "has_known_error",
    }
    if (set(out) != expected_keys
            or set(out["stage_counts"]) != set(STAGES)
            or set(out["stage_seen"]) != set(STAGES)
            or set(out["control_counts"]) != set(CONTROLS)
            or set(out["owned_webview_count_counts"])
                != set(OWNED_WEBVIEW_COUNTS)
            or set(out["username_value_check_result_counts"])
                != set(USERNAME_VALUE_CHECK_RESULTS)
            or set(out["password_interstitial_control_counts"])
                != set(PASSWORD_INTERSTITIAL_CONTROLS)
            or set(out["password_entry_result_counts"])
                != set(PASSWORD_ENTRY_RESULTS)
            or set(out["password_enter_action_counts"])
                != set(PASSWORD_ENTER_ACTIONS)
            or set(out["callback_observation_counts"])
                != set(CALLBACK_OBSERVATIONS)
            or set(out["pods_assertion_result_counts"])
                != set(PODS_ASSERTION_RESULTS)
            or set(out["error_counts"]) != set(ERRORS)):
        print("selftest: transition closed shape failed", file=sys.stderr)
        return 1
    if (out["control"] != "next"
            or out["owned_webview_count"] != "multiple"
            or out["username_value_check_result"] != "multiple"
            or out["password_interstitial_control"] != "continue"
            or out["password_entry_result"] != "multiple"
            or out["password_enter_action"] != "return"
            or out["callback_observation"] != "multiple"
            or out["pods_assertion_result"] != "success"
            or any(count != 1 for count in out["stage_counts"].values())
            or out["control_counts"]
                != {"next": 1, "continue": 0, "sign-in": 0}
            or any(count != 1
                   for count in out[
                       "owned_webview_count_counts"].values())
            or any(count != 1
                   for count in out[
                       "username_value_check_result_counts"].values())
            or out["password_interstitial_control_counts"]
                != {"next": 0, "continue": 1, "sign-in": 0}
            or any(count != 1
                   for count in out["password_entry_result_counts"].values())
            or out["password_enter_action_counts"] != {"return": 1}
            or any(count != 1
                   for count in out["callback_observation_counts"].values())
            or out["pods_assertion_result_counts"]
                != {"success": 1, "failure": 0}
            or any(count != 1 for count in out["error_counts"].values())
            or not all(out["stage_seen"].values())
            or not out["has_known_error"]):
        print("selftest: transition closed counts failed", file=sys.stderr)
        return 1

    trailing = classify("\n".join([
        "PIPOD_OWNED_WEBVIEW_COUNT=webview-count-2/private-secret",
        "PIPOD_USERNAME_VALUE_CHECK_RESULT=matched/private-secret",
        "PIPOD_PASSWORD_ENTRY_RESULT=plaintext-equality/private-secret",
        "PIPOD_PASSWORD_ENTER_ACTION=return private-secret",
        "PIPOD_CALLBACK_OBSERVATION=pods-direct/private-secret",
        "PIPOD_USERNAME_TRANSITION_STAGE=password-enter-action-completed.private-secret",
    ]))
    if (trailing["owned_webview_count"] != "absent"
            or any(trailing["owned_webview_count_counts"].values())
            or trailing["username_value_check_result"] != "absent"
            or any(trailing[
                "username_value_check_result_counts"].values())
            or trailing["password_entry_result"] != "absent"
            or any(trailing["password_entry_result_counts"].values())
            or trailing["password_enter_action"] != "absent"
            or any(trailing["password_enter_action_counts"].values())
            or trailing["callback_observation"] != "absent"
            or any(trailing["callback_observation_counts"].values())
            or any(trailing["stage_counts"].values())):
        print("selftest: trailing payload boundary failed", file=sys.stderr)
        return 1

    carriage = classify(
        "PIPOD_OWNED_WEBVIEW_COUNT=webview-count-2\r\n"
        "PIPOD_USERNAME_VALUE_CHECK_RESULT=matched\r\n"
        "PIPOD_PASSWORD_ENTRY_RESULT=plaintext-equality\r\n"
        "PIPOD_PASSWORD_ENTER_ACTION=return\r\n"
        "PIPOD_CALLBACK_OBSERVATION=pods-direct\r\n"
        "PIPOD_USERNAME_TRANSITION_STAGE=password-enter-action-completed\r\n")
    if (carriage["owned_webview_count"] != "webview-count-2"
            or carriage["username_value_check_result"] != "matched"
            or carriage["password_entry_result"] != "plaintext-equality"
            or carriage["password_enter_action"] != "return"
            or carriage["callback_observation"] != "pods-direct"
            or carriage["stage_counts"][
                "password-enter-action-completed"] != 1):
        print("selftest: authentic marker carriage failed", file=sys.stderr)
        return 1

    multiple = classify("\n".join([
        "PIPOD_PASSWORD_INTERSTITIAL_CONTROL=next",
        "PIPOD_PASSWORD_INTERSTITIAL_CONTROL=continue",
        "PIPOD_PODS_ASSERTION_RESULT=success",
        "PIPOD_PODS_ASSERTION_RESULT=failure",
        "PIPOD_PASSWORD_ENTER_ACTION=return",
        "PIPOD_PASSWORD_ENTER_ACTION=return",
    ]))
    if (multiple["password_interstitial_control"] != "multiple"
            or multiple["pods_assertion_result"] != "multiple"
            or multiple["password_enter_action"] != "return"
            or multiple["password_enter_action_counts"]["return"] != 2):
        print("selftest: transition closed category failed", file=sys.stderr)
        return 1
    print("selftest: username transition diagnostic is values-free and closed")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    print(json.dumps(classify(sys.stdin.read()), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
