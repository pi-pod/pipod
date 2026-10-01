#!/usr/bin/env python3
"""Values-free stage classifier for the private public-boundary xcodebuild log."""
import json
import sys

SCHEMA = "ios-auth-system-boundary-stages/v1"
STAGES = (
    "probe-armed",
    "app-signin-tapped",
    "system-consent-accepted",
    "system-browser-visible",
    "idp-username-field-visible",
)
PREFIX = "PIPOD_AUTH_BOUNDARY_STAGE="


def classify(text):
    counts = {stage: text.count(PREFIX + stage) for stage in STAGES}
    reached = "none"
    previous = -1
    for stage in STAGES:
        position = text.find(PREFIX + stage)
        if counts[stage] == 1 and position > previous:
            reached = stage
            previous = position
        else:
            break
    return {"schema": SCHEMA, "reached": reached, "counts": counts}


def selftest() -> int:
    hostile = "\n".join([
        "password=do-not-print https://example.invalid/?code=secret",
        PREFIX + "probe-armed",
        PREFIX + "app-signin-tapped",
        PREFIX + "system-consent-accepted",
        "Bearer private-value",
    ])
    out = classify(hostile)
    blob = json.dumps(out)
    if any(trap in blob for trap in ("do-not-print", "example.invalid", "secret", "Bearer")):
        print("selftest: boundary stage value escaped", file=sys.stderr)
        return 1
    if out["reached"] != "system-consent-accepted":
        print("selftest: boundary stage ordering failed", file=sys.stderr)
        return 1
    print("selftest: boundary stage classifier is values-free and closed")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    print(json.dumps(classify(sys.stdin.read()), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
