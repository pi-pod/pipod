#!/usr/bin/env python3
"""Values-free classifier for SessionLifecycleTests pod-open evidence.

Reads a private xcodebuild log from stdin into process memory only. It emits
only fixed marker counts and closed categories: never a source line, pod name,
accessibility label, pod id or suffix, transcript, URL, length or credential.
Unrecognized content is discarded and never retained.

Its job is to name the exact stopping point of the shared pod-open path, which
`classify_auth_log.py` cannot do: that classifier is bound to LoginTests and
enumerates only sign-in/username/password/callback assertion sites, so a
lifecycle failure produced names-and-statuses and nothing else.

Usage:
    ... | python3 classify_lifecycle_log.py
    python3 classify_lifecycle_log.py --selftest   # hostile-string proof
"""
import json
import sys

SCHEMA = "ios-lifecycle-diagnostic/v12"

STAGE_PREFIX = "PIPOD_LIFECYCLE_STAGE="
FIXTURE_PREFIX = "PIPOD_LIFECYCLE_FIXTURE="
PHASE_PREFIX = "PIPOD_LIFECYCLE_PHASE="
FILES_PREFIX = "PIPOD_FILES_STAGE="
FILES_NAV_PREFIX = "PIPOD_FILES_NAV="
SETTLE_PREFIX = "PIPOD_SETTLE="
SHEET_PREFIX = "PIPOD_FILES_SHEET="
CANCEL_PREFIX = "PIPOD_CANCEL_STAGE="

STAGES = (
    "pod-open-started",
    "pods-surface-shown",
    "pods-surface-absent",
    "refresh-error-shown",
    "refresh-error-absent",
    "show-hidden-offered",
    "show-hidden-absent",
    "list-snapshot-taken",
    "fixture-row-present",
    "fixture-row-absent",
    "fixture-row-unique",
    "fixture-row-nonunique",
    "row-tap-performed",
    "open-session-action-shown",
    "open-session-action-absent",
    "open-session-tapped",
    "pod-detail-shown",
    "pod-detail-absent",
    "session-surface-shown",
    "session-surface-absent",
    "session-banner-shown",
    "session-banner-absent",
    "wake-action-shown",
    "wake-action-absent",
    "wake-tap-action-cleared",
    "wake-tap-action-persisted",
    "wake-backend-starting-seen",
    "wake-backend-connected",
    "wake-backend-not-connected",
    "composer-shown",
    "composer-absent",
)

FIXTURES = ("awake", "sleeping")
PHASES = ("before-wait", "after-wait")
FILES_STAGES = (
    # The document-browser attach path: durable baseline, file button, its
    # tap, then either the picker's own failure or the picked row, then the
    # same staged/sent/persisted proof the photo path carried. A run that
    # stops anywhere in the browser names the rung; the sheet census beside
    # it says whether the browser presented at all.
    "baseline-read",
    "attach-file-shown",
    "attach-file-tapped",
    "file-picker-failed",
    "file-row-tapped",
    "attachment-staged",
    "send-performed",
    "image-prompt-persisted",
)

# How the seeded file was reached inside the browser. Counted, never a
# ladder: reaching it by search, by the app folder or by the location row
# are all the same progress.
FILES_NAV = (
    "search-used",
    "folder-opened",
    "location-opened",
    "browse-opened",
    "back-out-used",
    "search-cancelled",
)

# Ordered checkpoints for the live-stream cancel/retry path. A pass that never
# saw a running turn cancelled nothing, which the previous pass/fail pair could
# not distinguish from a cancel that worked.
CANCEL_STAGES = (
    "live-round-trip-shown",
    "live-round-trip-absent",
    "long-turn-sent",
    "long-turn-send-missed",
    "interrupt-control-shown",
    "interrupt-control-absent",
    "interrupt-control-vanished",
    "interrupt-tapped",
    "halt-shown",
    "halt-absent",
    "turn-ended",
    "turn-still-running",
    "retry-prompt-sent",
    "retry-assistant-replied",
    "retry-assistant-missing",
)

CANCEL_PROGRESS = (
    "live-round-trip-shown",
    "long-turn-sent",
    "interrupt-control-shown",
    "interrupt-tapped",
    "halt-shown",
    "turn-ended",
    "retry-prompt-sent",
    "retry-assistant-replied",
)

# Whether the sleeping fixture settled to the app's own asleep rule before
# an open, and which column refused when it did not. Counted, never a
# ladder: the verdict lives in the test's own assertion, these say what the
# backend showed.
SETTLE_STAGES = (
    "settled",
    "unsettled",
    "conn-asleep",
    "conn-other",
    "conn-missing",
    "sandbox-stopped",
    "sandbox-other",
)

# Closed count buckets. A raw count is never emitted by the test side, so a pod
# census can never be reconstructed from this diagnostic.
TRIPLE_BUCKETS = ("count-0", "count-1", "count-2", "count-3plus")
PAIR_BUCKETS = ("count-0", "count-1", "count-2plus")

BUCKET_MARKERS = (
    ("cell_count", "PIPOD_LIFECYCLE_CELL_COUNT=", TRIPLE_BUCKETS),
    ("row_identifier_count", "PIPOD_LIFECYCLE_ROW_ID_COUNT=", TRIPLE_BUCKETS),
    ("suffix_containing_count", "PIPOD_LIFECYCLE_SUFFIX_CONTAINING_COUNT=", PAIR_BUCKETS),
    ("suffix_matching_count", "PIPOD_LIFECYCLE_SUFFIX_MATCHING_COUNT=", PAIR_BUCKETS),
    ("suffix_button_count", "PIPOD_LIFECYCLE_SUFFIX_BUTTON_COUNT=", PAIR_BUCKETS),
    # How many sheets the app had up shortly after the attach tap. Zero
    # means the press presented nothing; one or more with no readable grid
    # is a different defect. A closed bucket, never content.
    ("sheet_count", "PIPOD_FILES_SHEET=", TRIPLE_BUCKETS),
)

# Ordered furthest-progress ladder. The last stage seen names where the shared
# pod-open path stopped, so a failure reads as a point rather than a guess.
PROGRESS = (
    "pod-open-started",
    "pods-surface-shown",
    "list-snapshot-taken",
    # Identity is the stable pod.row.<full uuid> accessibility identifier.
    # Suffix-label counts remain a side diagnostic because the pod's display
    # name auto-renames after its first prompt and is not an identity contract.
    "fixture-row-present",
    "row-tap-performed",
    # A row tap lands on PodDetailView; the session is one further, explicit
    # step behind pod.openSession. Everything the lifecycle suite waits for
    # (composer, asleep banner's Wake, workstation wait card) is a SessionView
    # surface, so a run that never taps this action can never reach them.
    "open-session-action-shown",
    "open-session-tapped",
    # The SESSION surface, not the pod detail surface a row tap lands on.
    # pod-detail-shown is deliberately not a rung: it reports where we are,
    # not how far we got, and treating it as progress is what made a stall on
    # the detail screen read as "a detail surface appeared".
    "session-surface-shown",
    "composer-shown",
)


def exact_marker_counts(lines, prefix, names):
    """Count complete marker lines after splitlines removes XCTest CR/CRLF."""
    return {name: lines.count(prefix + name) for name in names}


def closed_category(counts):
    chosen = [name for name, count in counts.items() if count > 0]
    return chosen[0] if len(chosen) == 1 else (
        "absent" if not chosen else "multiple")


def furthest_stage(stage_counts):
    """The deepest rung of the ladder that was actually reached."""
    reached = [name for name in PROGRESS if stage_counts.get(name, 0) > 0]
    return reached[-1] if reached else "absent"


def stopping_point(stage_counts):
    """The first ladder rung that was NOT reached, i.e. where it stopped.
    'complete' when every rung was reached at least once."""
    return stopping_point_for(stage_counts, PROGRESS)


def furthest_stage_for(counts, ordered):
    reached = [name for name in ordered if counts.get(name, 0) > 0]
    return reached[-1] if reached else "absent"


def stopping_point_for(counts, ordered):
    for name in ordered:
        if counts.get(name, 0) == 0:
            return name
    return "complete"


def classify(text):
    lines = text.splitlines()
    stage_counts = exact_marker_counts(lines, STAGE_PREFIX, STAGES)
    fixture_counts = exact_marker_counts(lines, FIXTURE_PREFIX, FIXTURES)
    phase_counts = exact_marker_counts(lines, PHASE_PREFIX, PHASES)
    files_counts = exact_marker_counts(lines, FILES_PREFIX, FILES_STAGES)
    nav_counts = exact_marker_counts(lines, FILES_NAV_PREFIX, FILES_NAV)
    settle_counts = exact_marker_counts(lines, SETTLE_PREFIX, SETTLE_STAGES)
    cancel_counts = exact_marker_counts(lines, CANCEL_PREFIX, CANCEL_STAGES)
    buckets = {
        field: exact_marker_counts(lines, prefix, names)
        for field, prefix, names in BUCKET_MARKERS
    }
    out = {
        "schema": SCHEMA,
        "pod_open_attempts": stage_counts["pod-open-started"],
        "furthest_stage": furthest_stage(stage_counts),
        "stopped_before": stopping_point(stage_counts),
        "stage_counts": stage_counts,
        "fixture_counts": fixture_counts,
        "phase_counts": phase_counts,
        "files_furthest_stage": furthest_stage_for(files_counts, FILES_STAGES),
        "files_stopped_before": stopping_point_for(files_counts, FILES_STAGES),
        "files_stage_counts": files_counts,
        # How the file was reached: fixed names only, counted but never a
        # ladder. Present alongside files_stopped_before, never instead of it.
        "files_nav_counts": nav_counts,
        # Whether the sleeping fixture settled to the app's asleep rule
        # before an open, and which column refused. Counted only; the
        # verdict lives in the test's own assertion.
        "settle_counts": settle_counts,
        "cancel_furthest_stage": furthest_stage_for(cancel_counts, CANCEL_PROGRESS),
        "cancel_stopped_before": stopping_point_for(cancel_counts, CANCEL_PROGRESS),
        "cancel_stage_counts": cancel_counts,
    }
    for field, _prefix, _names in BUCKET_MARKERS:
        out[field] = closed_category(buckets[field])
        out[field + "_counts"] = buckets[field]
    return out


def selftest() -> int:
    """Hostile-string proof: injected secrets, ids and suffix-appended markers
    must never surface, and must never be counted as a marker."""
    hostile = [
        "https://auth.example.com/oauth/v2/authorize?code=SUPERSECRETCODE123",
        "UITEST_PASSWORD=s3cr3t-value-never-print",
        "Bearer hunter2-token-value",
        "pod p-9d289a8341 named hunter2",
        "PIPOD_LIFECYCLE_STAGE=pod-open-started",
        "PIPOD_LIFECYCLE_FIXTURE=awake",
        "PIPOD_LIFECYCLE_PHASE=before-wait",
        "PIPOD_LIFECYCLE_STAGE=pods-surface-shown",
        "PIPOD_LIFECYCLE_CELL_COUNT=count-3plus",
        "PIPOD_LIFECYCLE_ROW_ID_COUNT=count-3plus",
        "PIPOD_LIFECYCLE_SUFFIX_CONTAINING_COUNT=count-0",
        "PIPOD_LIFECYCLE_SUFFIX_MATCHING_COUNT=count-1",
        "PIPOD_LIFECYCLE_SUFFIX_BUTTON_COUNT=count-1",
        "PIPOD_LIFECYCLE_STAGE=list-snapshot-taken",
        "PIPOD_LIFECYCLE_STAGE=fixture-row-absent",
        "PIPOD_FILES_STAGE=baseline-read",
        "PIPOD_FILES_STAGE=attach-file-shown",
        "PIPOD_FILES_STAGE=attach-file-tapped",
        "PIPOD_FILES_STAGE=file-picker-failed",
        "PIPOD_FILES_STAGE=file-row-tapped",
        "PIPOD_FILES_NAV=search-used",
        "PIPOD_FILES_NAV=browse-opened",
        "PIPOD_FILES_NAV=back-out-used",
        "PIPOD_FILES_NAV=search-cancelled",
        "PIPOD_FILES_NAV=folder-opened hunter2",
        "PIPOD_SETTLE=settled",
        "PIPOD_SETTLE=conn-asleep",
        "PIPOD_SETTLE=sandbox-stopped",
        "PIPOD_SETTLE=settled hunter2",
        "PIPOD_FILES_SHEET=count-2",
        "PIPOD_FILES_SHEET=count-1 hunter2",
        "PIPOD_CANCEL_STAGE=live-round-trip-shown",
        "PIPOD_CANCEL_STAGE=long-turn-sent",
        "PIPOD_CANCEL_STAGE=long-turn-send-missed",
        "PIPOD_CANCEL_STAGE=interrupt-control-shown",
        "PIPOD_CANCEL_STAGE=interrupt-tapped",
        "PIPOD_CANCEL_STAGE=halt-absent",
        "PIPOD_CANCEL_STAGE=turn-ended.p-9d289a8341",
        # suffix-appended / smuggling attempts: must NOT be counted
        "PIPOD_LIFECYCLE_STAGE=composer-shown/private-secret",
        "PIPOD_LIFECYCLE_STAGE=composer-shown.p-9d289a8341",
        "PIPOD_LIFECYCLE_FIXTURE=awake hunter2",
        "PIPOD_LIFECYCLE_CELL_COUNT=count-1 hunter2",
        "PIPOD_FILES_STAGE=attachment-staged/private-secret",
        "PIPOD_FILES_STAGE=image-prompt-persisted.p-9d289a8341",
        "prefix PIPOD_LIFECYCLE_STAGE=row-tap-performed trailing",
        "a" * 5000,
        "",
    ]
    out = classify("\n".join(hostile))
    blob = json.dumps(out)
    for trap in ("SUPERSECRETCODE123", "hunter2", "s3cr3t", "Bearer",
                 "9d289a8341", "p-9d2", "private-secret", "aaaa", "oauth"):
        if trap in blob:
            print(f"SELFTEST FAIL: trapped value leaked: {trap[:12]}")
            return 1
    # exact-line matching only: smuggled and embedded markers are not counted
    assert out["stage_counts"]["composer-shown"] == 0, out
    assert out["stage_counts"]["row-tap-performed"] == 0, out
    assert out["fixture_counts"]["awake"] == 1, out
    assert out["cell_count_counts"]["count-1"] == 0, out
    assert out["cell_count_counts"]["count-3plus"] == 1, out
    # the ladder locates the stopping point
    assert out["pod_open_attempts"] == 1, out
    assert out["furthest_stage"] == "list-snapshot-taken", out
    assert out["stopped_before"] == "fixture-row-present", out
    assert out["stage_counts"]["fixture-row-absent"] == 1, out
    assert out["files_furthest_stage"] == "file-row-tapped", out
    assert out["files_stopped_before"] == "attachment-staged", out
    assert out["files_stage_counts"]["image-prompt-persisted"] == 0, out
    # the nav markers count how the file was reached; the smuggled variant
    # is not counted and they never move the ladder
    assert out["files_nav_counts"]["search-used"] == 1, out
    assert out["files_nav_counts"]["browse-opened"] == 1, out
    assert out["files_nav_counts"]["back-out-used"] == 1, out
    assert out["files_nav_counts"]["search-cancelled"] == 1, out
    assert out["files_nav_counts"]["folder-opened"] == 0, out
    assert out["files_furthest_stage"] == "file-row-tapped", out
    # the sheet census is a closed bucket; the smuggled variant is not counted
    assert out["sheet_count"] == "count-2", out
    assert out["sheet_count_counts"]["count-1"] == 0, out
    # the settle markers are counted, never a ladder; the smuggled variant
    # is not counted
    assert out["settle_counts"]["settled"] == 1, out
    assert out["settle_counts"]["unsettled"] == 0, out
    assert out["settle_counts"]["conn-asleep"] == 1, out
    assert out["settle_counts"]["sandbox-stopped"] == 1, out
    assert out["settle_counts"]["conn-other"] == 0, out
    # An exhausted gate names the refusing column and never settles.
    gate_gave_up = classify("\n".join(SETTLE_PREFIX + name for name in (
        "unsettled", "conn-other", "sandbox-stopped")))
    assert gate_gave_up["settle_counts"]["unsettled"] == 1, gate_gave_up
    assert gate_gave_up["settle_counts"]["settled"] == 0, gate_gave_up
    assert gate_gave_up["settle_counts"]["conn-other"] == 1, gate_gave_up
    # the cancel ladder stops at the first rung it never reached; a smuggled
    # suffix does not carry it past one
    assert out["cancel_furthest_stage"] == "interrupt-tapped", out
    assert out["cancel_stopped_before"] == "halt-shown", out
    assert out["cancel_stage_counts"]["halt-absent"] == 1, out
    assert out["cancel_stage_counts"]["turn-ended"] == 0, out
    # A press that never happened is counted where it happened, never on
    # the ladder: the missed send must not read as a turn that ran.
    assert out["cancel_stage_counts"]["long-turn-send-missed"] == 1, out
    assert out["cancel_stage_counts"]["long-turn-sent"] == 1, out
    # The picker-failure branch is terminal but ordered: a run that reaches
    # it stopped before picking any row, not before tapping the button.
    failed_pick = classify("\n".join(FILES_PREFIX + name for name in (
        "baseline-read", "attach-file-shown", "attach-file-tapped",
        "file-picker-failed")))
    assert failed_pick["files_furthest_stage"] == "file-picker-failed", failed_pick
    assert failed_pick["files_stopped_before"] == "file-row-tapped", failed_pick
    # The live round trip gates the long turn: proven first, or the ladder
    # never starts.
    live_first = classify("\n".join(CANCEL_PREFIX + name for name in (
        "live-round-trip-shown", "long-turn-sent")))
    assert live_first["cancel_furthest_stage"] == "long-turn-sent", live_first
    assert live_first["cancel_stopped_before"] == "interrupt-control-shown", live_first
    dead_socket = classify(CANCEL_PREFIX + "live-round-trip-absent")
    assert dead_socket["cancel_furthest_stage"] == "absent", dead_socket
    assert dead_socket["cancel_stopped_before"] == "live-round-trip-shown", dead_socket
    # the decisive discrimination survives: containing 0 vs matching 1
    assert out["suffix_containing_count"] == "count-0", out
    assert out["suffix_matching_count"] == "count-1", out

    # Regression guard for the defect this ladder was extended to name: a run
    # that finds and taps the row but never taps Open session stops exactly
    # there, and must not be reported as having reached a session surface.
    stalled = classify("\n".join(STAGE_PREFIX + name for name in (
        "pod-open-started", "pods-surface-shown", "list-snapshot-taken",
        "fixture-row-present", "fixture-row-unique", "row-tap-performed",
        "open-session-action-absent", "pod-detail-shown",
        "session-surface-absent", "composer-absent")))
    assert stalled["stopped_before"] == "open-session-action-shown", stalled
    assert stalled["furthest_stage"] == "row-tap-performed", stalled
    assert stalled["stage_counts"]["open-session-tapped"] == 0, stalled
    # sitting on the pod detail screen must never read as a session surface
    assert stalled["stage_counts"]["pod-detail-shown"] == 1, stalled
    assert stalled["stage_counts"]["session-surface-shown"] == 0, stalled

    # The wake question this schema was extended to answer, as three distinct
    # readings that must never collapse into one another.
    never_asked = classify("\n".join(STAGE_PREFIX + name for name in (
        "wake-action-shown", "wake-tap-action-persisted",
        "wake-backend-not-connected")))
    assert never_asked["stage_counts"]["wake-backend-starting-seen"] == 0, never_asked
    assert never_asked["stage_counts"]["wake-tap-action-cleared"] == 0, never_asked
    slow_start = classify("\n".join(STAGE_PREFIX + name for name in (
        "wake-action-shown", "wake-tap-action-cleared",
        "wake-backend-starting-seen", "wake-backend-not-connected")))
    assert slow_start["stage_counts"]["wake-backend-starting-seen"] == 1, slow_start
    woken = classify("\n".join(STAGE_PREFIX + name for name in (
        "wake-action-shown", "wake-tap-action-cleared",
        "wake-backend-starting-seen", "wake-backend-connected")))
    assert woken["stage_counts"]["wake-backend-connected"] == 1, woken
    assert woken["stage_counts"]["wake-backend-not-connected"] == 0, woken

    # a fully successful path reports complete
    good = classify("\n".join(
        STAGE_PREFIX + name for name in PROGRESS))
    assert good["stopped_before"] == "complete", good
    assert good["furthest_stage"] == "composer-shown", good
    assert good["stage_counts"]["session-surface-shown"] == 1, good

    files_good = classify("\n".join(FILES_PREFIX + name for name in FILES_STAGES))
    assert files_good["files_furthest_stage"] == "image-prompt-persisted", files_good
    assert files_good["files_stopped_before"] == "complete", files_good

    # A run that read the baseline but never found the file button stops
    # exactly there, and must not read as a browser that failed to show its
    # file.
    files_early = classify("\n".join(FILES_PREFIX + name for name in (
        "baseline-read",)))
    assert files_early["files_stopped_before"] == "attach-file-shown", files_early
    assert files_early["files_furthest_stage"] == "baseline-read", files_early
    files_browsed = classify("\n".join(FILES_PREFIX + name for name in (
        "baseline-read", "attach-file-shown", "attach-file-tapped")))
    assert files_browsed["files_stopped_before"] == "file-picker-failed", files_browsed

    cancel_good = classify("\n".join(
        CANCEL_PREFIX + name for name in CANCEL_PROGRESS))
    assert cancel_good["cancel_stopped_before"] == "complete", cancel_good
    assert cancel_good["cancel_furthest_stage"] == "retry-assistant-replied", cancel_good
    # A turn that ended before it could be pressed cancelled nothing, and that
    # is a different reading from a press that the stream ignored.
    cancel_missed = classify("\n".join(CANCEL_PREFIX + name for name in (
        "live-round-trip-shown", "long-turn-sent", "interrupt-control-shown",
        "interrupt-control-vanished")))
    assert cancel_missed["cancel_stopped_before"] == "interrupt-tapped", cancel_missed
    assert cancel_missed["cancel_stage_counts"]["interrupt-control-vanished"] == 1

    # empty input: all zeros, closed shape, no invented categories
    empty = classify("")
    assert empty["pod_open_attempts"] == 0
    assert empty["furthest_stage"] == "absent"
    assert empty["stopped_before"] == "pod-open-started"
    assert all(v == 0 for v in empty["stage_counts"].values())
    assert set(empty["stage_counts"]) == set(STAGES)
    assert set(empty["fixture_counts"]) == set(FIXTURES)
    assert set(empty["phase_counts"]) == set(PHASES)
    assert empty["files_furthest_stage"] == "absent"
    assert empty["files_stopped_before"] == "baseline-read"
    assert set(empty["files_stage_counts"]) == set(FILES_STAGES)
    assert all(v == 0 for v in empty["files_stage_counts"].values())
    assert set(empty["files_nav_counts"]) == set(FILES_NAV)
    assert all(v == 0 for v in empty["files_nav_counts"].values())
    assert empty["cancel_furthest_stage"] == "absent"
    assert empty["cancel_stopped_before"] == "live-round-trip-shown"
    assert set(empty["cancel_stage_counts"]) == set(CANCEL_STAGES)
    assert all(v == 0 for v in empty["cancel_stage_counts"].values())
    assert set(empty["settle_counts"]) == set(SETTLE_STAGES)
    assert all(v == 0 for v in empty["settle_counts"].values())
    expected_keys = {"schema", "pod_open_attempts", "furthest_stage",
                     "stopped_before", "stage_counts", "fixture_counts",
                     "phase_counts", "files_furthest_stage",
                     "files_stopped_before", "files_stage_counts",
                     "files_nav_counts", "settle_counts",
                     "cancel_furthest_stage", "cancel_stopped_before",
                     "cancel_stage_counts"}
    for field, _prefix, _names in BUCKET_MARKERS:
        expected_keys.add(field)
        expected_keys.add(field + "_counts")
    assert set(empty) == expected_keys, sorted(set(empty) ^ expected_keys)
    for field, _prefix, names in BUCKET_MARKERS:
        assert empty[field] == "absent"
        assert set(empty[field + "_counts"]) == set(names)
    print("selftest: lifecycle diagnostic is values-free and closed")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    print(json.dumps(classify(sys.stdin.read()), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
