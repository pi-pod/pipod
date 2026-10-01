#!/usr/bin/env python3
"""Fail-closed runner for the standalone Release blackbox instrumentation."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "acceptance"))

from hosted_sdk import sdk_root, tool as hosted_tool  # noqa: E402
from instrument_result import classify_crash, parse_instrument  # noqa: E402

SERIAL = "emulator-5554"
RUNNER = "com.pipod.releaseblackbox.runner.test/androidx.test.runner.AndroidJUnitRunner"
EXPECTED_CLASS = "com.pipod.releaseblackbox.ReleaseBlackboxTest"
ALLOWED_EXTRAS = frozenset({"pipodTargetPackage", "pipodLive", "pipodScope"})
# Live PKCE worst-case fixed waits: 30s reset/foreground + 30s Sign in +
# 45s Chrome open + 90s shared boundary readiness + 60s boundary field +
# 30s password field + 90s callback + 60s Pods = 435s. Keep the explicit
# 480s process bound with its 45s overhead margin above that sum; keep it
# explicit unless a test proves it insufficient.
DEFAULT_TIMEOUT_S = 480
LOGCAT_TIMEOUT_S = 15

# Custom Instrumentation.sendStatus key. Status code 0 is the
# AndroidJUnitRunner OK code: additive-safe under `am instrument -r`, adding
# no failure signal to the existing bounded parser.
DIAG_KEY = "pipodDiag"
DIAG_STATUS_CODE = 0
_DIAG_LINE_PREFIX = f"INSTRUMENTATION_STATUS: {DIAG_KEY}="
_DIAG_VALUE = re.compile(r"^[a-z0-9_]+$")

PHASE_APP_SIGN_IN = "phase_app_sign_in"
PHASE_CHROME_OPEN = "phase_chrome_open"
PHASE_CHROME_FIRST_RUN = "phase_chrome_first_run"
PHASE_SIGNIN_REISSUED_AFTER_FRE = "phase_signin_reissued_after_fre"
PHASE_SIGNIN_REISSUED_NO_FRE = "phase_signin_reissued_no_fre"
PHASE_CHROME_FOREGROUND_SETTLED = "phase_chrome_foreground_settled"
PHASE_IDP_USERNAME_READY = "phase_idp_username_ready"
PHASE_IDP_USERNAME_SETTER_RETURNED = "phase_idp_username_setter_returned"
PHASE_IDP_USERNAME_ADVANCE = "phase_idp_username_advance"
PHASE_IDP_PASSWORD_READY = "phase_idp_password_ready"
PHASE_IDP_PASSWORD_SETTER_RETURNED = "phase_idp_password_setter_returned"
PHASE_IDP_PASSWORD_SUBMIT = "phase_idp_password_submit"
PHASE_CALLBACK_APP_RETURN = "phase_callback_app_return"
PHASE_PODS = "phase_pods"

REQUIRED_PHASES = (
    PHASE_APP_SIGN_IN,
    PHASE_CHROME_OPEN,
    PHASE_IDP_USERNAME_READY,
    PHASE_IDP_USERNAME_SETTER_RETURNED,
    PHASE_IDP_USERNAME_ADVANCE,
    PHASE_IDP_PASSWORD_READY,
    PHASE_IDP_PASSWORD_SETTER_RETURNED,
    PHASE_IDP_PASSWORD_SUBMIT,
    PHASE_CALLBACK_APP_RETURN,
    PHASE_PODS,
)
# Declaration order is the enumeration order of the optional window below;
# it is not an ordering constraint. Which orders are legal comes from
# `_optional_phase_valid`, the single rule both the stream parser and the
# strict success check read.
OPTIONAL_PHASE_ORDER = (
    PHASE_CHROME_FIRST_RUN,
    PHASE_SIGNIN_REISSUED_AFTER_FRE,
    PHASE_SIGNIN_REISSUED_NO_FRE,
    PHASE_CHROME_FOREGROUND_SETTLED,
)
# The two reissue phases name the same one-shot, so at most one of them can
# appear in a run.
REISSUE_PHASES = frozenset(
    {PHASE_SIGNIN_REISSUED_AFTER_FRE, PHASE_SIGNIN_REISSUED_NO_FRE}
)
OPTIONAL_PHASES = frozenset(OPTIONAL_PHASE_ORDER)
REQUIRED_PHASE_SET = frozenset(REQUIRED_PHASES)

# Broad assertion categories: the entry marker of a group of checks.
ASSERT_HARNESS = "assert_harness"
ASSERT_SCOPE = "assert_scope"
ASSERT_RELEASE_TARGET = "assert_release_target"
ASSERT_LAUNCH_TARGET = "assert_launch_target"
ASSERT_CREDENTIALS = "assert_credentials"
ASSERT_APP_SIGN_IN = "assert_app_sign_in"
ASSERT_APP_SIGN_IN_ACTION = "assert_app_sign_in_action"
ASSERT_CHROME_OPEN = "assert_chrome_open"
ASSERT_IDP_USERNAME_READY = "assert_idp_username_ready"
ASSERT_IDP_USERNAME_FIELD = "assert_idp_username_field"
ASSERT_IDP_USERNAME_ADVANCE = "assert_idp_username_advance"
ASSERT_IDP_PASSWORD_READY = "assert_idp_password_ready"
ASSERT_IDP_PASSWORD_FIELD = "assert_idp_password_field"
ASSERT_IDP_PASSWORD_SUBMIT = "assert_idp_password_submit"
ASSERT_CALLBACK_APP_RETURN = "assert_callback_app_return"
ASSERT_PODS = "assert_pods"
ASSERT_BROWSER_OWNS_UI = "assert_browser_owns_ui"

# Per-check categories. The harness emits one of these immediately before the
# single check it names, so the projected `diag_assert` is the exact pending
# check rather than the group it belongs to. Pre-phase checks (harness,
# scope, release target, launch, credentials) carry no phase tag at all, so
# these are the only evidence a failure there can leave.
ASSERT_HARNESS_TEST_PACKAGE = "assert_harness_test_package"
ASSERT_HARNESS_HOST_PACKAGE = "assert_harness_host_package"
ASSERT_HARNESS_EXTERNAL_TARGET = "assert_harness_external_target"
ASSERT_HARNESS_REQUESTED_TARGET = "assert_harness_requested_target"
ASSERT_SCOPE_LIVE_OPTIN = "assert_scope_live_optin"
ASSERT_SCOPE_AUTH = "assert_scope_auth"
ASSERT_RELEASE_TARGET_PACKAGE = "assert_release_target_package"
ASSERT_RELEASE_TARGET_NONDEBUGGABLE = "assert_release_target_nondebuggable"
ASSERT_RELEASE_TARGET_LAUNCHER = "assert_release_target_launcher"
ASSERT_LAUNCH_COMPONENT = "assert_launch_component"
ASSERT_LAUNCH_COMPONENT_NO_WHITESPACE = "assert_launch_component_no_whitespace"
ASSERT_LAUNCH_START = "assert_launch_start"
ASSERT_LAUNCH_FOREGROUND = "assert_launch_foreground"
ASSERT_LAUNCH_FOREGROUND_PACKAGE = "assert_launch_foreground_package"
ASSERT_CREDENTIALS_FILE = "assert_credentials_file"
ASSERT_CREDENTIALS_DELETED = "assert_credentials_deleted"
ASSERT_CREDENTIALS_KEYS = "assert_credentials_keys"
ASSERT_CHROME_IDENTITY = "assert_chrome_identity"
ASSERT_IDP_ORIGIN = "assert_idp_origin"
ASSERT_IDP_USERNAME_FIELD_MULTIPLE = "assert_idp_username_field_multiple"
ASSERT_IDP_USERNAME_FIELD_SETTLED = "assert_idp_username_field_settled"
ASSERT_IDP_USERNAME_BOUNDARY_RETURN = "assert_idp_username_boundary_return"
# Post-boundary interaction points. Emitted before each operation so an
# exception from ownership, click, or setter cannot be misattributed to
# cardinality. The exact Next actions already carry their own advance/submit
# tags; these name only the interactions that had none.
ASSERT_IDP_USERNAME_OWNERSHIP = "assert_idp_username_ownership"
ASSERT_IDP_USERNAME_CLICK = "assert_idp_username_click"
ASSERT_IDP_USERNAME_SETTER = "assert_idp_username_setter"
ASSERT_IDP_PASSWORD_CLICK = "assert_idp_password_click"
ASSERT_IDP_PASSWORD_SETTER = "assert_idp_password_setter"
ASSERT_IDP_PASSWORD_FIELD_MULTIPLE = "assert_idp_password_field_multiple"
ASSERT_IDP_PASSWORD_FIELD_SETTLED = "assert_idp_password_field_settled"
ASSERT_CALLBACK_APP_RETURN_FOREGROUND = "assert_callback_app_return_foreground"
ASSERT_CALLBACK_APP_RETURN_PACKAGE = "assert_callback_app_return_package"
ASSERT_PODS_SCREEN = "assert_pods_screen"
ASSERT_PODS_SETTINGS = "assert_pods_settings"
ASSERT_PODS_NO_SIGN_IN = "assert_pods_no_sign_in"

BROAD_ASSERT_TAGS = frozenset(
    {
        ASSERT_HARNESS,
        ASSERT_SCOPE,
        ASSERT_RELEASE_TARGET,
        ASSERT_LAUNCH_TARGET,
        ASSERT_CREDENTIALS,
        ASSERT_APP_SIGN_IN,
        ASSERT_CHROME_OPEN,
        ASSERT_IDP_USERNAME_READY,
        ASSERT_IDP_USERNAME_FIELD,
        ASSERT_IDP_USERNAME_ADVANCE,
        ASSERT_IDP_PASSWORD_READY,
        ASSERT_IDP_PASSWORD_FIELD,
        ASSERT_IDP_PASSWORD_SUBMIT,
        ASSERT_CALLBACK_APP_RETURN,
        ASSERT_PODS,
        ASSERT_BROWSER_OWNS_UI,
    }
)

PER_CHECK_ASSERT_TAGS = frozenset(
    {
        ASSERT_HARNESS_TEST_PACKAGE,
        ASSERT_HARNESS_HOST_PACKAGE,
        ASSERT_HARNESS_EXTERNAL_TARGET,
        ASSERT_HARNESS_REQUESTED_TARGET,
        ASSERT_SCOPE_LIVE_OPTIN,
        ASSERT_SCOPE_AUTH,
        ASSERT_RELEASE_TARGET_PACKAGE,
        ASSERT_RELEASE_TARGET_NONDEBUGGABLE,
        ASSERT_RELEASE_TARGET_LAUNCHER,
        ASSERT_LAUNCH_COMPONENT,
        ASSERT_LAUNCH_COMPONENT_NO_WHITESPACE,
        ASSERT_LAUNCH_START,
        ASSERT_LAUNCH_FOREGROUND,
        ASSERT_LAUNCH_FOREGROUND_PACKAGE,
        ASSERT_CREDENTIALS_FILE,
        ASSERT_CREDENTIALS_DELETED,
        ASSERT_CREDENTIALS_KEYS,
        ASSERT_APP_SIGN_IN_ACTION,
        ASSERT_CHROME_IDENTITY,
        ASSERT_IDP_ORIGIN,
        ASSERT_IDP_USERNAME_FIELD_MULTIPLE,
        ASSERT_IDP_USERNAME_FIELD_SETTLED,
        ASSERT_IDP_USERNAME_BOUNDARY_RETURN,
        ASSERT_IDP_USERNAME_OWNERSHIP,
        ASSERT_IDP_USERNAME_CLICK,
        ASSERT_IDP_USERNAME_SETTER,
        ASSERT_IDP_PASSWORD_CLICK,
        ASSERT_IDP_PASSWORD_SETTER,
        ASSERT_IDP_PASSWORD_FIELD_MULTIPLE,
        ASSERT_IDP_PASSWORD_FIELD_SETTLED,
        ASSERT_CALLBACK_APP_RETURN_FOREGROUND,
        ASSERT_CALLBACK_APP_RETURN_PACKAGE,
        ASSERT_PODS_SCREEN,
        ASSERT_PODS_SETTINGS,
        ASSERT_PODS_NO_SIGN_IN,
    }
)

ASSERT_TAGS = BROAD_ASSERT_TAGS | PER_CHECK_ASSERT_TAGS
_CHROME_OPEN_REQUIRED_COUNT = REQUIRED_PHASES.index(PHASE_CHROME_OPEN) + 1


def _optional_phase_valid(value: str, optional_seen: frozenset, required_count: int) -> bool:
    """The one optional-phase rule: window, cardinality, prerequisites.

    Every optional phase is emitted at most once and only inside the window
    the shared boundary helper owns, which opens once `phase_chrome_open` is
    on the wire and closes at the next required phase. An unlisted optional
    tag is invalid, so the rule fails closed. The stream parser enforces this
    and the strict success check enumerates from it, so an accepted stream
    and a complete sequence can never disagree.
    """
    if value in optional_seen or required_count != _CHROME_OPEN_REQUIRED_COUNT:
        return False
    if value == PHASE_CHROME_FIRST_RUN:
        return True
    if value in REISSUE_PHASES:
        # One reissued click per run, whichever name it travels under, and
        # each name asserts which state it recovered from: after an exact
        # first-run action, or before any had matched.
        if optional_seen & REISSUE_PHASES:
            return False
        expects_first_run = value == PHASE_SIGNIN_REISSUED_AFTER_FRE
        return (PHASE_CHROME_FIRST_RUN in optional_seen) == expects_first_run
    if value == PHASE_CHROME_FOREGROUND_SETTLED:
        # Tolerated non-Chrome foreground that ended with Chrome owning the
        # foreground again. Any handover inside this window can cause it, so
        # it carries no prerequisite and no position within the window.
        return True
    return False


def _optional_windows() -> list[list[str]]:
    """Every optional emission order `_optional_phase_valid` accepts."""
    windows: list[list[str]] = []

    def walk(prefix: list[str], seen: frozenset) -> None:
        windows.append(prefix)
        for phase in OPTIONAL_PHASE_ORDER:
            if _optional_phase_valid(phase, seen, _CHROME_OPEN_REQUIRED_COUNT):
                walk(prefix + [phase], seen | {phase})

    walk([], frozenset())
    return windows

# Shared IdP username boundary inventory. Both allowlisted tests reach the
# boundary through the same Kotlin helper, so both emit the identical nine
# slots in the identical order; it is credential-free boundary evidence, not
# a public-only signal. Categorical counts travel as fixed allowlisted
# pipodDiag tags with pre-enumerated bounded suffixes 0..9/many; Chrome
# identity travels on the same proven pipodDiag channel as strictly
# generated decimal-digit tags (separate Bundle keys were observed not to
# arrive on API34, even as digit strings).
INV_DIM_ONBOARDING = "onboarding_remaining"
INV_DIM_ORIGIN = "origin"
INV_DIM_LOGIN_EXACT_TEXT = "login_exact_text"
INV_DIM_LOGIN_EXACT_DESC = "login_exact_desc"
INV_DIM_LOGIN_CI_TEXT = "login_ci_text"
INV_DIM_LOGIN_CI_DESC = "login_ci_desc"
INV_DIM_FIELD = "field_nonomnibox"
INV_DIM_CHROME_MAJOR = "chrome_major"
INV_DIM_CHROME_VERSION = "chrome_version_code"
INV_ORDER = (
    INV_DIM_ONBOARDING,
    INV_DIM_ORIGIN,
    INV_DIM_LOGIN_EXACT_TEXT,
    INV_DIM_LOGIN_EXACT_DESC,
    INV_DIM_LOGIN_CI_TEXT,
    INV_DIM_LOGIN_CI_DESC,
    INV_DIM_FIELD,
    INV_DIM_CHROME_MAJOR,
    INV_DIM_CHROME_VERSION,
)
INV_ORIGIN_VALUES = ("expected", "browser_error", "other", "unavailable")
INV_COUNT_SUFFIXES = tuple([str(i) for i in range(10)] + ["many"])
INV_COUNT_DIMS = (
    INV_DIM_ONBOARDING,
    INV_DIM_LOGIN_EXACT_TEXT,
    INV_DIM_LOGIN_EXACT_DESC,
    INV_DIM_LOGIN_CI_TEXT,
    INV_DIM_LOGIN_CI_DESC,
    INV_DIM_FIELD,
)


def _inv_count_tags(dim: str) -> set[str]:
    return {f"inv_{dim}_{suffix}" for suffix in INV_COUNT_SUFFIXES}


INVENTORY_TAGS = frozenset(
    set().union(*[_inv_count_tags(dim) for dim in INV_COUNT_DIMS])
    | {f"inv_origin_{value}" for value in INV_ORIGIN_VALUES}
)

# Fixed pre-Chrome diagnostic block. Both allowlisted tests click Sign in and
# then enter the one shared `requireChromeOpen(startedAtMs)` helper, which
# records four fixed slots in this dimension order immediately before
# `assert_chrome_open`. It is its own closed block with its own parser: never a
# phase, never an assertion category, never boundary inventory. Every value is
# a pre-enumerated fixed token, so nothing dynamic can travel in it.
PRECHROME_PREFIX = "prechrome_"
PRECHROME_DIM_FOREGROUND = "fg"
PRECHROME_DIM_ERROR = "error"
PRECHROME_DIM_PROGRESS = "progress"
PRECHROME_DIM_ELAPSED = "elapsed"
PRECHROME_ORDER = (
    PRECHROME_DIM_FOREGROUND,
    PRECHROME_DIM_ERROR,
    PRECHROME_DIM_PROGRESS,
    PRECHROME_DIM_ELAPSED,
)
PRECHROME_VALUES = {
    # Exact current-package mapping at the instant the bounded wait ended.
    PRECHROME_DIM_FOREGROUND: ("own", "chrome", "other"),
    # Exact app error surface, classified against fixed known copy only.
    PRECHROME_DIM_ERROR: ("none", "network", "discovery", "timeout", "unknown_error_dialog"),
    # `present` means observed at least once during the bounded wait.
    PRECHROME_DIM_PROGRESS: ("present", "absent"),
    # Monotonic half-open buckets: [0,5s), [5s,15s), [15s,30s), [30s, inf).
    PRECHROME_DIM_ELAPSED: ("lt5", "5_15", "15_30", "gt30"),
}


def _prechrome_dim_tags(dim: str) -> set[str]:
    return {f"{PRECHROME_PREFIX}{dim}_{value}" for value in PRECHROME_VALUES[dim]}


PRECHROME_TAGS = frozenset(
    set().union(*[_prechrome_dim_tags(dim) for dim in PRECHROME_ORDER])
)

# Fixed browser-ownership failure block. It is emitted once, immediately
# before ASSERT_BROWSER_OWNS_UI, and is absent on success. Every slot is a
# fixed category derived only from exact package equality or an exact
# allowlisted selector; no package/node/text value is transported.
BROWSEROWN_PREFIX = "browserown_"
BROWSEROWN_DIM_FOREGROUND = "fg"
BROWSEROWN_DIM_ONBOARDING = "onboarding"
BROWSEROWN_DIM_SIGNIN = "signin"
BROWSEROWN_DIM_ELAPSED = "elapsed"
BROWSEROWN_ORDER = (
    BROWSEROWN_DIM_FOREGROUND,
    BROWSEROWN_DIM_ONBOARDING,
    BROWSEROWN_DIM_SIGNIN,
    BROWSEROWN_DIM_ELAPSED,
)
BROWSEROWN_VALUES = {
    BROWSEROWN_DIM_FOREGROUND: (
        "own",
        "chrome",
        "system_ui",
        "play_services",
        # Named by exact equality against the package captured during the
        # harness's existing home-screen reset and its fixed host/framework
        # packages, so these owners do not collapse into `other`.
        "harness",
        "android",
        "launcher",
        "other",
    ),
    BROWSEROWN_DIM_ONBOARDING: ("present", "absent"),
    BROWSEROWN_DIM_SIGNIN: ("visible", "absent"),
    # Same original-click, monotonic, half-open buckets as pre-Chrome.
    BROWSEROWN_DIM_ELAPSED: ("lt5", "5_15", "15_30", "gt30"),
}


def _browserown_dim_tags(dim: str) -> set[str]:
    return {
        f"{BROWSEROWN_PREFIX}{dim}_{value}"
        for value in BROWSEROWN_VALUES[dim]
    }


BROWSEROWN_TAGS = frozenset(
    set().union(*[_browserown_dim_tags(dim) for dim in BROWSEROWN_ORDER])
)
# Fixed post-auth Pods-screen failure block. Six slots, emitted once by the
# live method immediately after ASSERT_PODS_SCREEN and immediately before that
# failure, never on a pass. It records what the authenticated screen was
# showing instead of its exact title, from allowlisted selector presence only.
POSTAUTH_PREFIX = "postauth_"
POSTAUTH_DIM_FOREGROUND = "fg"
POSTAUTH_DIM_SHELL = "shell"
POSTAUTH_DIM_PROGRESS = "progress"
POSTAUTH_DIM_ERROR = "error"
POSTAUTH_DIM_SIGNIN = "signin"
POSTAUTH_DIM_ELAPSED = "elapsed"
POSTAUTH_ORDER = (
    POSTAUTH_DIM_FOREGROUND,
    POSTAUTH_DIM_SHELL,
    POSTAUTH_DIM_PROGRESS,
    POSTAUTH_DIM_ERROR,
    POSTAUTH_DIM_SIGNIN,
    POSTAUTH_DIM_ELAPSED,
)
POSTAUTH_VALUES = {
    POSTAUTH_DIM_FOREGROUND: (
        "own",
        "chrome",
        "system_ui",
        "play_services",
        # Named by exact equality against the package captured during the
        # harness's existing home-screen reset and its fixed host/framework
        # packages, so these owners do not collapse into `other`.
        "harness",
        "android",
        "launcher",
        "other",
    ),
    POSTAUTH_DIM_SHELL: ("present", "absent"),
    POSTAUTH_DIM_PROGRESS: ("present", "absent"),
    POSTAUTH_DIM_ERROR: ("present", "absent"),
    POSTAUTH_DIM_SIGNIN: ("visible", "absent"),
    # Monotonic half-open buckets from the callback, scaled to the screen's
    # own 60s wait rather than the pre-Chrome scale.
    POSTAUTH_DIM_ELAPSED: ("lt15", "15_30", "30_60", "gt60"),
}


def _postauth_dim_tags(dim: str) -> set[str]:
    return {
        f"{POSTAUTH_PREFIX}{dim}_{value}"
        for value in POSTAUTH_VALUES[dim]
    }


POSTAUTH_TAGS = frozenset(
    set().union(*[_postauth_dim_tags(dim) for dim in POSTAUTH_ORDER])
)
ALLOWED_TAGS = (
    REQUIRED_PHASE_SET
    | OPTIONAL_PHASES
    | ASSERT_TAGS
    | INVENTORY_TAGS
    | PRECHROME_TAGS
    | BROWSEROWN_TAGS
    | POSTAUTH_TAGS
)

# Projection-only labels for the two numeric slots. The wire form is the
# anchored pipodDiag tag (e.g. inv_chrome_major_131); these labels appear
# solely in inv_num projection lines, never on the wire.
NUMERIC_MAJOR_KEY = "pipodChromeMajor"
NUMERIC_VERSION_KEY = "pipodChromeVersionCode"
CHROME_MAJOR_MIN = 1
CHROME_MAJOR_MAX = 999
CHROME_VERSION_MIN = 1
CHROME_VERSION_MAX = 9223372036854775807
_NUMERIC_STRICT = re.compile(r"^[0-9]+$")
# Anchored numeric-prefix specs: (dimension, tag prefix, min, max). Dynamic
# digit remainders are recognized only here and only for these prefixes.
_INV_NUM_TAG_SPECS = (
    (INV_DIM_CHROME_MAJOR, f"inv_{INV_DIM_CHROME_MAJOR}_", CHROME_MAJOR_MIN, CHROME_MAJOR_MAX),
    (INV_DIM_CHROME_VERSION, f"inv_{INV_DIM_CHROME_VERSION}_", CHROME_VERSION_MIN, CHROME_VERSION_MAX),
)
# Vestigial separate Bundle keys: no longer emitted. Any residue fails closed.
_INV_NUM_CATCHALL = "INSTRUMENTATION_STATUS: pipodChrome"
# Public step bound: above the summed public waits (30s reset/foreground +
# 30s Sign in + 45s browser + 90s shared readiness + 60s shared field =
# 255s) plus overhead, still bounded. The live default below is untouched.
PUBLIC_TIMEOUT_S = 420


def _adb() -> str:
    return str(hosted_tool(sdk_root(), "adb"))


def _run(adb: str, args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [adb, "-s", SERIAL, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def instrumentation_extras(items: list[str]) -> tuple[list[str], list[str]]:
    extras: list[str] = []
    keys: list[str] = []
    for item in items:
        if "=" not in item:
            raise SystemExit("instrument extra must be key=value")
        key, value = item.split("=", 1)
        if key not in ALLOWED_EXTRAS:
            raise SystemExit(f"instrument extra key is not allowlisted: {key}")
        if key == "pipodScope" and value != "auth":
            raise SystemExit("pipodScope must be auth")
        extras.extend(["-e", key, value])
        keys.append(key)
    if len(set(keys)) != len(keys):
        raise SystemExit("duplicate instrument extra key")
    return extras, keys


def _inv_numeric_tag(value: str):
    """Classify an anchored numeric-prefix tag.

    Returns (kind, dim, number) with kind in ok/range/malformed, or None
    when the value carries no numeric prefix. Only strictly generated
    decimal digits within range validate.
    """
    for dim, prefix, lo, hi in _INV_NUM_TAG_SPECS:
        if value.startswith(prefix):
            raw = value[len(prefix):]
            if not _NUMERIC_STRICT.fullmatch(raw):
                return ("malformed", dim, None)
            try:
                number = int(raw, 10)
            except ValueError:
                return ("malformed", dim, None)
            if lo <= number <= hi:
                return ("ok", dim, number)
            return ("range", dim, number)
    return None


def _is_ok_inv_numeric_tag(value: str) -> bool:
    numeric = _inv_numeric_tag(value)
    return numeric is not None and numeric[0] == "ok"


def _diag_values(text: str):
    """Yield validated (kind, value) events for pipodDiag lines in order."""
    blob = text.replace("\r\n", "\n")
    for raw in blob.splitlines():
        line = raw.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX) :]
        if not _DIAG_VALUE.fullmatch(value):
            yield ("malformed", value)
            continue
        numeric = _inv_numeric_tag(value)
        if numeric is not None:
            # Only fully validated numeric tags are accepted (and ignored
            # for phase order downstream); lookalikes are rejected here.
            if numeric[0] == "ok":
                yield ("tag", value)
            else:
                yield ("malformed", value)
            continue
        if value not in ALLOWED_TAGS:
            yield ("unknown", value)
        else:
            yield ("tag", value)


def _ordered_prefix(values) -> tuple[
    list[str], list[str], list[str], list[str], list[str], list[str], str | None
]:
    """Fold validated values; stop at the first violation, if any."""
    phases: list[str] = []
    asserts: list[str] = []
    inventory: list[str] = []
    prechrome: list[str] = []
    browserown: list[str] = []
    postauth: list[str] = []
    required_count = 0
    optional_seen: set[str] = set()
    for kind, value in values:
        if kind == "malformed":
            return phases, asserts, inventory, prechrome, browserown, postauth, "diag malformed tag"
        if kind == "unknown":
            return phases, asserts, inventory, prechrome, browserown, postauth, "diag unknown tag"
        if value in ASSERT_TAGS:
            asserts.append(value)
            continue
        if value in INVENTORY_TAGS or _is_ok_inv_numeric_tag(value):
            # Shared boundary inventory bucket: collected for the inventory
            # parser, never disturbing the phase order enforced here.
            # Only fully validated numeric tags reach this branch;
            # lookalikes were already rejected as malformed above.
            inventory.append(value)
            continue
        if value in PRECHROME_TAGS:
            # Shared pre-Chrome bucket: its own four-slot block, parsed by
            # its own parser and never part of the phase order here.
            prechrome.append(value)
            continue
        if value in BROWSEROWN_TAGS:
            # Failure-only browser ownership bucket. Its order/completeness
            # and conditional assertion relationship are validated by its
            # dedicated parser without disturbing phase order.
            browserown.append(value)
            continue
        if value in POSTAUTH_TAGS:
            # Failure-only post-auth bucket, on the same terms: its own
            # parser validates order, completeness, and the category it must
            # follow, and none of it is part of the phase order here.
            postauth.append(value)
            continue
        if value in OPTIONAL_PHASES:
            if not _optional_phase_valid(value, frozenset(optional_seen), required_count):
                return phases, asserts, inventory, prechrome, browserown, postauth, "diag unexpected phase order"
            optional_seen.add(value)
            phases.append(value)
            continue
        if required_count >= len(REQUIRED_PHASES) or REQUIRED_PHASES[required_count] != value:
            return phases, asserts, inventory, prechrome, browserown, postauth, "diag unexpected phase order"
        required_count += 1
        phases.append(value)
    return phases, asserts, inventory, prechrome, browserown, postauth, None


def _inv_dim(tag: str) -> str:
    """Dimension for an allowlisted inventory tag. Internal only."""
    for dim in INV_ORDER:
        if tag.startswith(f"inv_{dim}_"):
            return dim
    raise AssertionError("inventory tag without dimension")


def _inv_partial(tags: list[str], nums: dict[str, int]) -> dict:
    partial: dict = {"tags": list(tags)}
    if INV_DIM_CHROME_MAJOR in nums:
        partial["major"] = nums[INV_DIM_CHROME_MAJOR]
    if INV_DIM_CHROME_VERSION in nums:
        partial["versionCode"] = nums[INV_DIM_CHROME_VERSION]
    return partial


def _inventory_scan(text: str):
    """Yield inventory events in stream order. Fixed tokens only downstream."""
    blob = text.replace("\r\n", "\n")
    for raw in blob.splitlines():
        line = raw.rstrip("\r")
        if line.startswith(_DIAG_LINE_PREFIX):
            value = line[len(_DIAG_LINE_PREFIX):]
            if _DIAG_VALUE.fullmatch(value):
                numeric = _inv_numeric_tag(value)
                if numeric is not None:
                    kind, dim, number = numeric
                    if kind == "ok":
                        yield ("num", dim, number)
                    elif kind == "range":
                        yield ("num_range", dim, number)
                    else:
                        yield ("num_malformed", dim, value)
                elif value in INVENTORY_TAGS:
                    yield ("inv", value)
                elif value.startswith("inv_"):
                    yield ("inv_unknown", value)
                # Else: phase/assert tag for the diag parser; ignore here.
            elif value.startswith("inv_"):
                yield ("inv_malformed", value)
            # Else: non-inventory diag line; ignore here.
        elif line.startswith(_INV_NUM_CATCHALL):
            # Vestigial separate-key residue: never emitted anymore.
            yield ("num_malformed", "", line)


def parse_diag_status(text: str) -> dict[str, list[str]]:
    """Parse only exact allowlisted pipodDiag tags from raw instrument output."""
    phases, asserts, inventory, prechrome, browserown, postauth, violation = _ordered_prefix(
        _diag_values(text)
    )
    if violation is not None:
        raise SystemExit(violation)
    blob = text.replace("\r\n", "\n")
    if not any(
        line.rstrip("\r").startswith(_DIAG_LINE_PREFIX) for line in blob.splitlines()
    ):
        raise SystemExit("diag missing")
    return {
        "phases": phases,
        "asserts": asserts,
        "inventory": inventory,
        "prechrome": prechrome,
        "browserown": browserown,
        "postauth": postauth,
    }


def extract_diag_prefix(text: str) -> dict[str, list[str]]:
    """Return the valid allowlisted prefix before any violation. Safe to project."""
    phases, asserts, inventory, prechrome, browserown, postauth, _ = _ordered_prefix(
        _diag_values(text)
    )
    return {
        "phases": phases,
        "asserts": asserts,
        "inventory": inventory,
        "prechrome": prechrome,
        "browserown": browserown,
        "postauth": postauth,
    }


def project_diag(parsed: dict[str, list[str]]) -> None:
    """Project only allowlisted phase/assertion identifiers. No raw output."""
    phases = parsed.get("phases") or []
    asserts = parsed.get("asserts") or []
    if phases:
        print("diag_phases", ",".join(phases), flush=True)
        print("diag_phase", phases[-1], flush=True)
    if asserts:
        print("diag_assert", asserts[-1], flush=True)


def try_project_diag(output: str, *, required: bool) -> None:
    try:
        project_diag(parse_diag_status(output))
    except SystemExit as exc:
        # On failure still project the valid allowlisted prefix/assertion
        # collected before the violation, then stay fail-closed.
        prefix = extract_diag_prefix(output)
        if prefix["phases"] or prefix["asserts"]:
            project_diag(prefix)
        print("diag_reject", str(exc), flush=True)
        if required:
            raise


def _fold_inventory(events) -> tuple[dict, str | None]:
    """Fold inventory events; all nine slots in fixed order, numerics last."""
    tags: list[str] = []
    seen_dims: set[str] = set()
    nums: dict[str, int] = {}
    position = 0
    for ev in events:
        kind = ev[0]
        if kind == "inv_malformed":
            return _inv_partial(tags, nums), "inv malformed tag"
        if kind == "inv_unknown":
            return _inv_partial(tags, nums), "inv unknown tag"
        if kind == "num_malformed":
            return _inv_partial(tags, nums), "inv malformed numeric"
        if kind == "num_range":
            return _inv_partial(tags, nums), "inv numeric out of range"
        if kind == "inv":
            dim = _inv_dim(ev[1])
            if dim in seen_dims:
                return _inv_partial(tags, nums), "inv duplicate"
            if INV_ORDER.index(dim) != position:
                return _inv_partial(tags, nums), "inv unexpected order"
            seen_dims.add(dim)
            tags.append(ev[1])
            position += 1
            continue
        if kind == "num":
            _, dim, number = ev
            if dim in seen_dims:
                return _inv_partial(tags, nums), "inv duplicate"
            if INV_ORDER.index(dim) != position:
                return _inv_partial(tags, nums), "inv unexpected order"
            seen_dims.add(dim)
            nums[dim] = number
            position += 1
            continue
    if position != len(INV_ORDER):
        return _inv_partial(tags, nums), "inv missing"
    full = _inv_partial(tags, nums)
    return full, None


def parse_inventory_status(text: str) -> dict:
    """Parse the shared boundary closed inventory. Fixed violation tokens only."""
    parsed, violation = _fold_inventory(_inventory_scan(text))
    if violation is not None:
        raise SystemExit(violation)
    return parsed


def extract_inventory_prefix(text: str) -> dict:
    """Valid safe inventory prefix before any violation. Safe to project."""
    parsed, _ = _fold_inventory(_inventory_scan(text))
    return parsed


def project_inventory(parsed: dict) -> None:
    """Project only allowlisted inventory tags and validated digits."""
    for tag in parsed.get("tags") or []:
        print("inv_tag", tag, flush=True)
    if "major" in parsed:
        print("inv_num", NUMERIC_MAJOR_KEY, parsed["major"], flush=True)
    if "versionCode" in parsed:
        print("inv_num", NUMERIC_VERSION_KEY, parsed["versionCode"], flush=True)


def try_project_inventory(output: str, *, required: bool) -> None:
    try:
        project_inventory(parse_inventory_status(output))
    except SystemExit as exc:
        # On failure still project the valid safe prefix collected before
        # the violation, then stay fail-closed.
        prefix = extract_inventory_prefix(output)
        if prefix.get("tags") or "major" in prefix or "versionCode" in prefix:
            project_inventory(prefix)
        print("inv_reject", str(exc), flush=True)
        if required:
            raise


def require_inventory_complete(output: str) -> dict:
    """Both tests: reject unknown/malformed/duplicate/missing inventory.

    Every allowlisted test crosses the shared boundary helper, so a passing
    run of either test must carry all nine slots exactly once in order.
    """
    try:
        return parse_inventory_status(output)
    except SystemExit:
        raise SystemExit("inv missing or rejected") from None


def _prechrome_dim(tag: str) -> str:
    """Dimension for an allowlisted pre-Chrome tag. Internal only."""
    for dim in PRECHROME_ORDER:
        if tag.startswith(f"{PRECHROME_PREFIX}{dim}_"):
            return dim
    raise AssertionError("pre-Chrome tag without dimension")


def _prechrome_scan(text: str):
    """Yield pre-Chrome events in stream order. Fixed tokens only downstream."""
    blob = text.replace("\r\n", "\n")
    for raw in blob.splitlines():
        line = raw.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX):]
        if _DIAG_VALUE.fullmatch(value):
            if value in PRECHROME_TAGS:
                yield ("prechrome", value)
            elif value.startswith(PRECHROME_PREFIX):
                yield ("prechrome_unknown", value)
            # Else: phase/assert/inventory tag for another parser; ignore here.
        elif value.startswith(PRECHROME_PREFIX):
            yield ("prechrome_malformed", value)
        # Else: non pre-Chrome diag line; ignore here.


def _fold_prechrome(events) -> tuple[dict, str | None]:
    """Fold pre-Chrome events; all four slots exactly once in fixed order."""
    tags: list[str] = []
    seen_dims: set[str] = set()
    position = 0
    for kind, value in events:
        if kind == "prechrome_malformed":
            return {"tags": list(tags)}, "prechrome malformed tag"
        if kind == "prechrome_unknown":
            return {"tags": list(tags)}, "prechrome unknown tag"
        dim = _prechrome_dim(value)
        if dim in seen_dims:
            return {"tags": list(tags)}, "prechrome duplicate"
        if PRECHROME_ORDER.index(dim) != position:
            return {"tags": list(tags)}, "prechrome unexpected order"
        seen_dims.add(dim)
        tags.append(value)
        position += 1
    if position != len(PRECHROME_ORDER):
        return {"tags": list(tags)}, "prechrome missing"
    return {"tags": list(tags)}, None


def parse_prechrome_status(text: str) -> dict:
    """Parse the shared pre-Chrome block. Fixed violation tokens only."""
    parsed, violation = _fold_prechrome(_prechrome_scan(text))
    if violation is not None:
        raise SystemExit(violation)
    return parsed


def extract_prechrome_prefix(text: str) -> dict:
    """Valid safe pre-Chrome prefix before any violation. Safe to project."""
    parsed, _ = _fold_prechrome(_prechrome_scan(text))
    return parsed


def project_prechrome(parsed: dict) -> None:
    """Project only allowlisted fixed pre-Chrome tokens."""
    for tag in parsed.get("tags") or []:
        print("diag_prechrome", tag, flush=True)


def try_project_prechrome(output: str, *, required: bool) -> None:
    try:
        project_prechrome(parse_prechrome_status(output))
    except SystemExit as exc:
        # On failure still project the valid fixed prefix collected before
        # the violation, then stay fail-closed.
        prefix = extract_prechrome_prefix(output)
        if prefix.get("tags"):
            project_prechrome(prefix)
        print("prechrome_reject", str(exc), flush=True)
        if required:
            raise


def require_prechrome_complete(output: str) -> dict:
    """Both tests: reject unknown/malformed/duplicate/out-of-order/missing.

    Every allowlisted test clicks Sign in and enters the same shared
    `requireChromeOpen` helper, so a passing run of either test must carry all
    four slots exactly once in the fixed order.
    """
    try:
        return parse_prechrome_status(output)
    except SystemExit:
        raise SystemExit("prechrome missing or rejected") from None


def _browserown_dim(tag: str) -> str:
    """Dimension for an allowlisted browser-ownership tag. Internal only."""
    for dim in BROWSEROWN_ORDER:
        if tag.startswith(f"{BROWSEROWN_PREFIX}{dim}_"):
            return dim
    raise AssertionError("browser-ownership tag without dimension")


def _browserown_scan(text: str):
    """Yield browser-ownership events in stream order."""
    blob = text.replace("\r\n", "\n")
    for raw in blob.splitlines():
        line = raw.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX):]
        if _DIAG_VALUE.fullmatch(value):
            if value in BROWSEROWN_TAGS:
                yield ("browserown", value)
            elif value.startswith(BROWSEROWN_PREFIX):
                yield ("browserown_unknown", value)
            # Else: another parser's fixed tag; ignore here.
        elif value.startswith(BROWSEROWN_PREFIX):
            yield ("browserown_malformed", value)


def _fold_browserown(events) -> tuple[dict, str | None]:
    """Fold zero or one four-slot ownership block in fixed order."""
    tags: list[str] = []
    seen_dims: set[str] = set()
    position = 0
    for kind, value in events:
        if kind == "browserown_malformed":
            return {"tags": list(tags)}, "browserown malformed tag"
        if kind == "browserown_unknown":
            return {"tags": list(tags)}, "browserown unknown tag"
        dim = _browserown_dim(value)
        if dim in seen_dims:
            return {"tags": list(tags)}, "browserown duplicate"
        if BROWSEROWN_ORDER.index(dim) != position:
            return {"tags": list(tags)}, "browserown unexpected order"
        seen_dims.add(dim)
        tags.append(value)
        position += 1
    if position not in (0, len(BROWSEROWN_ORDER)):
        return {"tags": list(tags)}, "browserown missing"
    return {"tags": list(tags)}, None


def _browserown_related_tags(text: str) -> list[str]:
    """Exact ownership slots/assertion in their wire order."""
    related: list[str] = []
    for line in text.replace("\r\n", "\n").splitlines():
        line = line.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX):]
        if value in BROWSEROWN_TAGS or value == ASSERT_BROWSER_OWNS_UI:
            related.append(value)
    return related


def parse_browserown_status(text: str) -> dict:
    """Parse and enforce the ownership block's exact assertion relationship."""
    parsed, violation = _fold_browserown(_browserown_scan(text))
    if violation is not None:
        raise SystemExit(violation)
    related = _browserown_related_tags(text)
    assertion_count = related.count(ASSERT_BROWSER_OWNS_UI)
    if assertion_count > 1:
        raise SystemExit("browserown duplicate assertion")
    has_block = bool(parsed["tags"])
    has_assertion = assertion_count == 1
    if has_assertion and not has_block:
        raise SystemExit("browserown missing")
    if has_block and not has_assertion:
        raise SystemExit("browserown unexpected without assertion")
    if has_assertion and related != parsed["tags"] + [ASSERT_BROWSER_OWNS_UI]:
        raise SystemExit("browserown unexpected assertion order")
    return parsed


def extract_browserown_prefix(text: str) -> dict:
    """Valid fixed ownership prefix before any violation. Safe to project."""
    parsed, _ = _fold_browserown(_browserown_scan(text))
    return parsed


def project_browserown(parsed: dict) -> None:
    """Project only allowlisted fixed browser-ownership tokens."""
    for tag in parsed.get("tags") or []:
        print("diag_browserown", tag, flush=True)


def try_project_browserown(output: str, *, required: bool) -> None:
    try:
        project_browserown(parse_browserown_status(output))
    except SystemExit as exc:
        prefix = extract_browserown_prefix(output)
        if prefix.get("tags"):
            project_browserown(prefix)
        print("browserown_reject", str(exc), flush=True)
        if required:
            raise


def require_browserown_absent(output: str) -> dict:
    """Passing instrumentation must carry no ownership-failure evidence.

    Two distinct failures, reported distinctly: a rejected ownership stream
    (unknown/malformed/duplicate/out-of-order/partial, or an assertion and
    block that do not match) collapses to the parser's fixed token, while a
    valid but present block on a passing run keeps its own token. The
    emptiness check is deliberately outside the try: inside it, its own
    SystemExit was caught by the parse handler and every pass-with-block run
    reported the parse reason instead.
    """
    try:
        parsed = parse_browserown_status(output)
    except SystemExit:
        raise SystemExit("browserown missing or rejected") from None
    if parsed["tags"]:
        raise SystemExit("browserown present on pass")
    return parsed


def _postauth_dim(tag: str) -> str:
    """Dimension for an allowlisted post-auth tag. Internal only."""
    for dim in POSTAUTH_ORDER:
        if tag.startswith(f"{POSTAUTH_PREFIX}{dim}_"):
            return dim
    raise AssertionError("post-auth tag without dimension")


def _postauth_scan(text: str):
    """Yield post-auth events in stream order."""
    blob = text.replace("\r\n", "\n")
    for raw in blob.splitlines():
        line = raw.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX):]
        if _DIAG_VALUE.fullmatch(value):
            if value in POSTAUTH_TAGS:
                yield ("postauth", value)
            elif value.startswith(POSTAUTH_PREFIX):
                yield ("postauth_unknown", value)
            # Else: another parser's fixed tag; ignore here.
        elif value.startswith(POSTAUTH_PREFIX):
            yield ("postauth_malformed", value)


def _fold_postauth(events) -> tuple[dict, str | None]:
    """Fold zero or one six-slot post-auth block in fixed order."""
    tags: list[str] = []
    seen_dims: set[str] = set()
    position = 0
    for kind, value in events:
        if kind == "postauth_malformed":
            return {"tags": list(tags)}, "postauth malformed tag"
        if kind == "postauth_unknown":
            return {"tags": list(tags)}, "postauth unknown tag"
        dim = _postauth_dim(value)
        if dim in seen_dims:
            return {"tags": list(tags)}, "postauth duplicate"
        if POSTAUTH_ORDER.index(dim) != position:
            return {"tags": list(tags)}, "postauth unexpected order"
        seen_dims.add(dim)
        tags.append(value)
        position += 1
    if position not in (0, len(POSTAUTH_ORDER)):
        return {"tags": list(tags)}, "postauth missing"
    return {"tags": list(tags)}, None


def _postauth_related_tags(text: str) -> list[str]:
    """Exact post-auth slots and the category they follow, in wire order."""
    related: list[str] = []
    for line in text.replace("\r\n", "\n").splitlines():
        line = line.rstrip("\r")
        if not line.startswith(_DIAG_LINE_PREFIX):
            continue
        value = line[len(_DIAG_LINE_PREFIX):]
        if value in POSTAUTH_TAGS or value == ASSERT_PODS_SCREEN:
            related.append(value)
    return related


def parse_postauth_status(text: str) -> dict:
    """Parse and enforce the post-auth block's exact category relationship.

    The relationship is one-directional, unlike the ownership block's. The
    pending-check category ASSERT_PODS_SCREEN is emitted before the wait on
    every live run, pass or fail, so its presence cannot require a block. A
    block, however, is emitted only on that failure and only immediately after
    that category, so a block without it, or not directly after it, is a
    violation.
    """
    parsed, violation = _fold_postauth(_postauth_scan(text))
    if violation is not None:
        raise SystemExit(violation)
    if not parsed["tags"]:
        return parsed
    related = _postauth_related_tags(text)
    if related.count(ASSERT_PODS_SCREEN) != 1:
        raise SystemExit("postauth unexpected without category")
    if related != [ASSERT_PODS_SCREEN] + parsed["tags"]:
        raise SystemExit("postauth unexpected category order")
    return parsed


def extract_postauth_prefix(text: str) -> dict:
    """Valid post-auth prefix before any violation. Safe to project."""
    parsed, _ = _fold_postauth(_postauth_scan(text))
    return parsed


def project_postauth(parsed: dict) -> None:
    """Project only allowlisted fixed post-auth tokens."""
    for tag in parsed.get("tags") or []:
        print("diag_postauth", tag, flush=True)


def try_project_postauth(output: str, *, required: bool) -> None:
    try:
        project_postauth(parse_postauth_status(output))
    except SystemExit as exc:
        prefix = extract_postauth_prefix(output)
        if prefix.get("tags"):
            project_postauth(prefix)
        print("postauth_reject", str(exc), flush=True)
        if required:
            raise


def require_postauth_absent(output: str) -> dict:
    """Passing instrumentation must carry no post-auth failure evidence.

    Two distinct failures keep distinct tokens, exactly as the ownership gate
    does: a rejected stream collapses to the parser's fixed token, and a valid
    but present block on a passing run keeps its own. The emptiness check sits
    outside the handler so it cannot be reported as a parse failure.
    """
    try:
        parsed = parse_postauth_status(output)
    except SystemExit:
        raise SystemExit("postauth missing or rejected") from None
    if parsed["tags"]:
        raise SystemExit("postauth present on pass")
    return parsed


PUBLIC_TEST = "releaseSignInReachesIdpUsername"
LIVE_TEST = "realPkceShowsPods"
ALLOWED_TESTS = frozenset({PUBLIC_TEST, LIVE_TEST})


def _with_optional_phases(base: list[str]) -> list[list[str]]:
    """The base sequence with every legal optional window spliced in.

    The windows come from the same rule the stream parser applies, so no
    sequence this returns could have been rejected on the wire, and no
    accepted stream is missing here.
    """
    idx = base.index(PHASE_CHROME_OPEN) + 1
    return [base[:idx] + window + base[idx:] for window in _optional_windows()]


def expected_phase_sequences(test: str) -> list[list[str]]:
    """Exact completed sequences: public prefix ending username_ready, live full."""
    if test == PUBLIC_TEST:
        base = [PHASE_APP_SIGN_IN, PHASE_CHROME_OPEN, PHASE_IDP_USERNAME_READY]
    elif test == LIVE_TEST:
        base = list(REQUIRED_PHASES)
    else:
        raise SystemExit("requested blackbox Class#method is not allowlisted")
    return _with_optional_phases(base)


def require_diag_complete(output: str, test: str) -> None:
    """Reject missing/incomplete diagnostics on an otherwise passing test."""
    try:
        parsed = parse_diag_status(output)
    except SystemExit:
        raise SystemExit("diag missing or rejected") from None
    if parsed["phases"] not in expected_phase_sequences(test):
        raise SystemExit("diag incomplete phase sequence")


def classify_and_exit(adb: str, reason: str) -> None:
    try:
        dump = _run(
            adb,
            [
                "logcat",
                "-d",
                "-b",
                "crash",
                "-b",
                "main",
                "-s",
                "AndroidRuntime:E",
                "TestRunner:E",
                "AndroidJUnitRunner:E",
            ],
            LOGCAT_TIMEOUT_S,
        )
        blob = (dump.stdout or "") + (dump.stderr or "")
    except subprocess.TimeoutExpired:
        blob = ""
    print("crash_logcat_bytes", len(blob), flush=True)
    crash_class, crash_site = classify_crash(blob)
    print("crash_class", crash_class, "crash_site", crash_site, flush=True)
    raise SystemExit(reason)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--class", dest="cls", required=True)
    parser.add_argument("--test", dest="test", required=True)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
    parser.add_argument("-e", action="append", default=[], metavar="KEY=VAL")
    args = parser.parse_args()

    if args.cls != EXPECTED_CLASS or args.test not in ALLOWED_TESTS:
        raise SystemExit("requested blackbox Class#method is not allowlisted")

    extras, extra_keys = instrumentation_extras(args.e)
    if extra_keys:
        # Keys are identifiers. Values (including scope/package) are never logged.
        print("instrument_extras", ",".join(extra_keys), flush=True)

    adb = _adb()
    try:
        _run(adb, ["logcat", "-c"], LOGCAT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise SystemExit("logcat clear timed out") from None

    command = [
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        *extras,
        "-e",
        "class",
        f"{args.cls}#{args.test}",
        RUNNER,
    ]
    try:
        proc = _run(adb, command, args.timeout)
    except subprocess.TimeoutExpired as exc:
        output = f"{exc.stdout or ''}{exc.stderr or ''}"
        try_project_diag(output, required=False)
        try_project_inventory(output, required=False)
        try_project_prechrome(output, required=False)
        try_project_browserown(output, required=False)
        try_project_postauth(output, required=False)
        classify_and_exit(adb, "instrument timed out")
        return

    output = (proc.stdout or "") + (proc.stderr or "")
    # Non-blocking, exactly like the two streams below: a malformed, unknown,
    # out-of-order, or missing pipodDiag stream still projects the valid
    # allowlisted prefix it reached and the fixed `diag_reject <token>`, and
    # then goes on to parse_instrument and crash classification, so a failing
    # run reports why the test failed instead of why its diagnostics did.
    # Nothing is loosened for a passing run: require_diag_complete below runs
    # the same strict parser after parse success and fails closed on exactly
    # the same violations.
    try_project_diag(output, required=False)
    # Both allowlisted tests cross the shared boundary helper, so both carry
    # the same nine-slot inventory. required=False lets incomplete/rejected
    # inventory on a failing run still project the fixed safe prefix and reach
    # parse_instrument + crash classification; passing completeness/rejections
    # fail later via require_inventory_complete.
    try_project_inventory(output, required=False)
    # Same non-blocking contract for the shared pre-Chrome block: a failing run
    # still projects the fixed prefix it reached and goes on to instrument and
    # crash classification, while a passing run is gated below.
    try_project_prechrome(output, required=False)
    # Failure-only ownership diagnostics are projected before the original
    # instrument result and filtered crash classification, just like the
    # other safe blocks. Invalid/partial data never masks that root result.
    try_project_browserown(output, required=False)
    # Same non-blocking contract for the failure-only post-auth block.
    try_project_postauth(output, required=False)
    try:
        result = parse_instrument(output, expected_class=args.cls, expected_test=args.test, expected_count=1)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    try:
        require_diag_complete(output, args.test)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    try:
        require_inventory_complete(output)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    try:
        require_prechrome_complete(output)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    try:
        # A successful test must carry neither an ownership assertion nor its
        # failure-only block. The same parser requires all four slots when the
        # assertion occurs on a failing run.
        require_browserown_absent(output)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    try:
        # A successful live test reached the exact authenticated screen, so it
        # must carry no post-auth block. The same parser requires all six
        # slots, in order, directly after ASSERT_PODS_SCREEN when one is
        # emitted on a failing run.
        require_postauth_absent(output)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    print(
        "instrument_ok",
        result["class"],
        "test",
        result["test"],
        "tests",
        result["tests"],
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # fail closed without dumping subprocess/UI output
        raise SystemExit(f"blackbox instrument runner failed: {type(exc).__name__}") from exc
