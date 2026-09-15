"""The coverage phase's isolation invariants (CRMA-767 AC3, AC5).

Two structural claims live here, and both are written the way
tests/test_matching_isolation.py writes its own: as assertions that would
fail if someone later wired coverage into a place it must never reach.

**AC5 -- no coverage-derived row reaches the signal corpus or a
trend-scoring path.** The guarantee is not "we remembered not to": the
coverage package cannot write at all, and its guard refuses the named tables
even if a future call site grants them.

**AC3 -- coverage can never raise CONFIDENCE or corroborate.** The valve
returns a boolean (tests/test_coverage_posture.py), and the package it lives
in has no way to reach a confidence: it does not import ``build_verdict``, it
never sets ``matched_trend_id``, and no coverage text is rendered into any
prompt, so the model that restates confidence cannot have seen one.
"""

from __future__ import annotations

import ast
import inspect
import pathlib
import re

import pytest

from prediction_service import coverage as coverage_pkg
from prediction_service.coverage import (
    CONTENT_VECTORS_OBJECT,
    COVERAGE_FORBIDDEN_TOKENS,
    CoverageIsolationViolation,
    SnowflakeCoverageDetector,
    assert_coverage_sql,
    build_detection_sql,
)
from prediction_service.sweep import prompt as sweep_prompt

from .fakes import FakeSnowflake

PACKAGE = pathlib.Path(coverage_pkg.__file__).parent
GRANT = (CONTENT_VECTORS_OBJECT,)

_COMMENT = re.compile(r"#[^\n]*")


def code_only(text: str) -> str:
    """``text`` with its comments and docstrings removed.

    These assertions are about what the package *can do*, so they have to
    read code and not prose. Without this the module docstrings -- which
    explain at length that coverage never touches ``build_verdict`` or
    ``FCT_SIGNALS`` -- would trip every check by naming the thing they
    promise not to do.
    """
    stripped = text
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc:
                stripped = stripped.replace(doc, "", 1)
    return _COMMENT.sub("", stripped)


def package_code() -> str:
    return "\n".join(code_only(path.read_text()) for path in sorted(PACKAGE.glob("*.py")))


# --- 1. the phase's own statement -----------------------------------------


@pytest.mark.parametrize("subject_count", [1, 3, 25])
def test_every_detection_statement_clears_its_own_grant(subject_count):
    assert_coverage_sql(build_detection_sql(subject_count), allowed_tables=GRANT)


def test_a_detector_pointed_at_another_object_raises_before_the_client():
    snowflake = FakeSnowflake()
    detector = SnowflakeCoverageDetector(
        client=snowflake, content_vectors="MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS"
    )

    with pytest.raises(CoverageIsolationViolation):
        detector.detect(["protein coffee"])

    assert snowflake.calls == []


# --- 2. the guard is not vacuous ------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        # Evidence purity (CONTEXT.md): nothing coverage-derived may reach
        # the signal corpus, and the way to guarantee that from this package
        # is that this package cannot write at all.
        "INSERT INTO MCC_PRESENTATION.TREND_AGENT.STG_EXTERNAL_SIGNALS (SIGNAL_ID) VALUES ('x')",
        "INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS (SIGNAL_ID) VALUES ('x')",
        "UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS SET TREND_TOPIC = 'x'",
        "MERGE INTO MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS AS t USING (SELECT 1) AS i ON 1=1",
        "DELETE FROM MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS",
        "CREATE TABLE X AS SELECT 1 FROM CUE_CONTENT_VECTORS",
    ],
)
def test_the_coverage_guard_rejects_any_write(sql):
    with pytest.raises(CoverageIsolationViolation):
        assert_coverage_sql(sql, allowed_tables=GRANT)


def test_the_coverage_guard_rejects_an_object_outside_the_grant():
    with pytest.raises(CoverageIsolationViolation, match="granted at the call site"):
        assert_coverage_sql(
            "SELECT * FROM MCC_RAW.STORY_DATA.CUE_CONTENT_PROCESSED", allowed_tables=GRANT
        )


@pytest.mark.parametrize("forbidden", COVERAGE_FORBIDDEN_TOKENS)
def test_a_widened_grant_cannot_buy_coverage_a_look_at_the_signal_or_trend_tables(forbidden):
    # The regression that would matter most: someone makes coverage "better"
    # by granting it the signal corpus or a trend ledger. The allowlist alone
    # would let that through the moment the call site was edited; the
    # denylist refuses it whatever the call site says.
    with pytest.raises(CoverageIsolationViolation, match="evidence purity"):
        assert_coverage_sql(
            f"SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.{forbidden}",
            allowed_tables=(forbidden,),
        )


def test_the_denylist_names_the_tables_ac5_names():
    for table in ("STG_EXTERNAL_SIGNALS", "FCT_SIGNALS"):
        assert table in COVERAGE_FORBIDDEN_TOKENS
    # ...and the trend-scoring path the PRD's isolation invariants name.
    for token in ("FCT_TRENDS", "FCT_TREND_", "HEAT_INDEX", "LIFECYCLE_STATUS"):
        assert token in COVERAGE_FORBIDDEN_TOKENS


def test_a_second_statement_cannot_ride_along_behind_a_semicolon():
    with pytest.raises(CoverageIsolationViolation, match="one statement at a time"):
        assert_coverage_sql(
            "SELECT 1 FROM CUE_CONTENT_VECTORS; DELETE FROM CUE_CONTENT_VECTORS",
            allowed_tables=GRANT,
        )


# --- 3. AC5, said about the package rather than one statement -------------


def test_the_coverage_package_holds_no_write_capability_at_all():
    source = package_code().upper()
    for verb in ("INSERT INTO", "UPDATE ", "MERGE INTO", "DELETE FROM", "CREATE TABLE"):
        assert verb not in source, f"the coverage package must not be able to {verb!r}"


def test_the_coverage_package_never_names_the_signal_corpus():
    # Not even in a string it might one day bind: the only warehouse object
    # this package knows the name of is the content-embedding table. The
    # denylist constant in isolation.py is the deliberate exception.
    isolation = code_only((PACKAGE / "isolation.py").read_text())
    for table in ("STG_EXTERNAL_SIGNALS", "FCT_SIGNALS"):
        assert package_code().count(table) == isolation.count(table) == 1


def test_the_coverage_package_writes_only_through_a_verdicts_evidence():
    source = package_code()
    # Nothing here mints or edits a verdict: consumption is the caller's, and
    # the only thing this package hands back is an evidence dict.
    for reach in ("build_verdict", "matched_trend_id", "Verdict("):
        assert reach not in source


# --- 4. AC3, structurally ------------------------------------------------


def test_no_coverage_reading_is_rendered_into_the_re_evaluation_prompt():
    # The model restates CONFIDENCE. If a coverage detection could reach the
    # prompt, coverage could raise confidence -- which is the one thing the
    # strategy forbids outright. The prompt has no coverage field.
    item_fields = set(inspect.signature(sweep_prompt.ReevaluationItem).parameters)
    assert "coverage" not in item_fields
    assert "coverage" not in sweep_prompt.build_system_prompt().lower()


def test_the_sweep_attaches_coverage_after_the_model_turn_not_before():
    from prediction_service.sweep import run as sweep_run

    source = inspect.getsource(sweep_run.sweep_predictions)
    # Ordering, asserted as ordering: the turn is asked first, the coverage
    # reading is merged into the evidence afterwards.
    assert source.index("_reevaluations(items, llm)") < source.index("record_coverage(")


def test_confidence_is_never_computed_from_a_coverage_reading():
    code = package_code()
    assert "confidence_direction" in code  # ExternalDemand reads one...
    # ...but nothing in the package produces one: no arithmetic on a
    # confidence, and no assignment to one.
    without_fields = code.replace("confidence_direction", "").replace("confidence_delta", "")
    for arithmetic in ("confidence +", "confidence -", "confidence *", "confidence ="):
        assert arithmetic not in without_fields
