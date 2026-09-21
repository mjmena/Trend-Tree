"""The calibration label tier never touches a live number (CRMA-768 AC4).

    "All decisions are retained as a calibration label tier -- recorded for
     later regression tuning, never live-trained on."

That is a *structural* claim, so it gets a structural test, following
matching/isolation.py + tests/test_matching_isolation.py, the existing
precedent for this shape in the service. Four proofs:

1. **The tier is write-only by construction.** ``assert_label_sql`` refuses
   anything that is not a single MERGE into the label table -- so there is no
   statement this module can issue that reads a label back, and a number
   cannot be adjusted from a tier nothing can read.
2. **The guard is not vacuous.** A SELECT against the label table, a write to
   a different table, and a second statement riding behind a semicolon are
   each rejected.
3. **The confidence-producing seam cannot see a label.** Neither
   ``resolve_posture`` nor the sweep's re-evaluation parser takes a label or
   a decision-history argument, and nothing in the confidence path imports
   the label module. A later change that wired labels into confidence would
   have to break one of these to do it.
4. **Behaviourally: the number does not move.** The same sweep run under
   APPROVE, DISMISS, no decision and an unreachable source writes the same
   CONFIDENCE every time -- the model's, unchanged.

The one thing that *does* change under a decision is PREDICTION_STATUS, and
that is the point of the story: a Dismiss is a human's action recorded as a
status, not a rule applied to a number.
"""

from __future__ import annotations

import ast
import inspect
import json
import pathlib
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.strategist import (
    LABEL_TABLE,
    MERGE_LABEL,
    StaticStrategistDecisionReader,
    StrategistDecision,
    UnavailableDecisionReader,
    resolve_posture,
)
from prediction_service.strategist import labels as labels_module
from prediction_service.strategist.labels import (
    CalibrationLabelIsolationViolation,
    assert_label_sql,
)
from prediction_service.sweep.parse import parse_reevaluations

from .matching_fakes import open_prediction_row
from .sweep_fakes import SweepLedgerSimulator, SweepLLM, reevaluation_reply

QUALIFIED = "MCC_PRESENTATION.TREND_AGENT." + LABEL_TABLE
SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}
FIRST = "814a38cb-3935-4ce2-b640-b3154bfa84f4"


# --- 1. the tier's own statement clears its own guard ---------------------


def test_the_only_statement_the_tier_issues_is_a_write_to_its_own_table():
    assert_label_sql(MERGE_LABEL.format(table=QUALIFIED), table=QUALIFIED)


# --- 2. the guard is not vacuous ------------------------------------------


@pytest.mark.parametrize(
    "statement",
    [
        f"SELECT DECISION FROM {QUALIFIED} WHERE PREDICTION_ID = %(id)s",
        f"WITH labels AS (SELECT * FROM {QUALIFIED}) SELECT AVG(OBSERVED_CONFIDENCE) FROM labels",
        f"UPDATE {QUALIFIED} SET DECISION = 'APPROVE'",
        f"DELETE FROM {QUALIFIED}",
    ],
)
def test_the_tier_refuses_to_read_or_mutate_a_label(statement):
    with pytest.raises(CalibrationLabelIsolationViolation):
        assert_label_sql(statement, table=QUALIFIED)


def test_the_tier_refuses_to_write_anywhere_else():
    with pytest.raises(CalibrationLabelIsolationViolation, match="writes only to"):
        assert_label_sql(
            "MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER AS l "
            "USING (SELECT 1) AS i ON 1=1 WHEN NOT MATCHED THEN INSERT (A) VALUES (1)",
            table=QUALIFIED,
        )


def test_a_second_statement_riding_behind_a_semicolon_is_refused():
    with pytest.raises(CalibrationLabelIsolationViolation, match="one statement"):
        assert_label_sql(
            MERGE_LABEL.format(table=QUALIFIED).strip() + f"; SELECT * FROM {QUALIFIED}",
            table=QUALIFIED,
        )


def test_the_label_module_exposes_no_read():
    # There is no reader to call, so a future caller wanting a label back has
    # to add one -- a visible diff, which is the point.
    public = {
        name
        for name in dir(labels_module)
        if not name.startswith("_") and callable(getattr(labels_module, name))
    }
    assert not {name for name in public if "read" in name or "fetch" in name or "load" in name}
    # The MERGE's only SELECT is the scalar `USING (SELECT %(label_id)s)`
    # that supplies the match key. It has no FROM, so the statement reads no
    # table at all -- not the label table, not anything else.
    assert " FROM " not in labels_module.MERGE_LABEL.upper()


# --- 3. the confidence path cannot see a label ----------------------------


def test_the_precedence_ladder_takes_no_confidence_and_returns_none():
    # It settles queue standing. A function that cannot receive a number and
    # does not return one cannot adjust one.
    signature = inspect.signature(resolve_posture)

    assert "confidence" not in signature.parameters
    assert set(signature.parameters) == {"decision", "coverage_demoted", "automated_posture"}


def test_the_re_evaluation_parser_takes_no_label_history():
    # Confidence is restated by the model in the re-evaluation turn and
    # parsed here. Nothing about a strategist's past decisions reaches it, so
    # the model cannot be primed with the labels either.
    signature = inspect.signature(parse_reevaluations)

    assert not {
        name for name in signature.parameters if "label" in name or "decision" in name
    }


def test_no_module_in_the_confidence_path_imports_the_label_tier():
    # A source-level check, deliberately: this is the test that fails if
    # someone later wires calibration labels into a number, wherever they do
    # it from.
    root = pathlib.Path(labels_module.__file__).parent.parent
    confidence_path = [
        root / "sweep" / "run.py",
        root / "sweep" / "parse.py",
        root / "generation" / "run.py",
        root / "generation" / "parse.py",
        root / "matching" / "run.py",
        root / "matching" / "decide.py",
        root / "saturation" / "weigh.py",
        root / "saturation" / "run.py",
        root / "strategist" / "precedence.py",
    ]
    offenders = []
    for path in confidence_path:
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("labels"):
                offenders.append(path.name)
            if isinstance(node, ast.Import):
                offenders += [path.name for a in node.names if a.name.endswith("labels")]
    assert offenders == [], (
        f"{offenders} imports the calibration label tier. Labels are retained for a later "
        "offline regression pass and must never reach a live confidence."
    )


# --- 4. behaviourally: no decision moves a number -------------------------


def _verify_ok(token: str, audience: str) -> dict:
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "https://accounts.google.com",
    }


def _row() -> dict:
    row = open_prediction_row(prediction_id=FIRST, confidence=68.0)
    row["HORIZON_AT"] = (datetime.now(UTC) + timedelta(days=60)).strftime(
        "%Y-%m-%d %H:%M:%S.%f"
    )[:-3]
    return row


def _llm() -> SweepLLM:
    return SweepLLM(
        reevaluation_reply=reevaluation_reply(
            {
                "id": 1,
                "prediction_id": FIRST,
                "subject": "rucking vests",
                "observable_check": "not_yet",
                "observation": "no listing yet",
                "confidence": 74.0,
                "reasoning": "The behaviour keeps widening.",
                "what_changed": "Two more sources landed.",
            }
        )
    )


def _run(reader) -> dict:
    ledger = SweepLedgerSimulator(rows=[_row()])
    client = TestClient(
        create_app(
            settings=settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL}),
            snowflake=ledger,
            verify_token=_verify_ok,
            llm=_llm(),
            decisions=reader,
        )
    )
    resp = client.post("/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    written = [
        call.params
        for call in ledger.writes
        if call.params.get("prediction_id") == FIRST and "subject_descriptor" in call.params
    ]
    return written[-1]


def _decision(action: str) -> StaticStrategistDecisionReader:
    return StaticStrategistDecisionReader(
        decisions=[
            StrategistDecision(
                prediction_id=FIRST,
                decision=action,
                decided_at=datetime(2026, 8, 22, 15, 4, tzinfo=UTC),
                observed_confidence=12.0,
                observed_flag="Watchlist",
            )
        ]
    )


def test_the_confidence_written_is_the_models_whatever_the_strategist_did():
    readings = {
        name: _run(reader)["confidence"]
        for name, reader in (
            ("untouched", StaticStrategistDecisionReader()),
            ("approved", _decision("APPROVE")),
            ("dismissed", _decision("DISMISS")),
            ("unreachable", UnavailableDecisionReader()),
        )
    }

    assert set(readings.values()) == {74.0}, readings


def test_a_label_never_reaches_the_evidence_as_a_number_to_reason_from():
    # EVIDENCE.strategist carries the decision so a human can read why the
    # posture is what it is. What it must not carry is a *derived* figure --
    # an approval rate, a calibration adjustment, a weight.
    evidence = json.loads(_run(_decision("APPROVE"))["evidence"])["strategist"]

    assert set(evidence["decision"]) == {
        "decision",
        "prediction_id",
        "decided_at",
        "decided_by",
        "source",
    }
    assert "never used to adjust CONFIDENCE" in evidence["calibration_label"]


def test_a_dismiss_changes_the_status_and_only_the_status():
    approved = _run(_decision("APPROVE"))
    dismissed = _run(_decision("DISMISS"))

    assert (approved["status"], dismissed["status"]) == ("ACTIVE", "WITHDRAWN")
    assert approved["confidence"] == dismissed["confidence"]
    assert approved["matched_trend_id"] == dismissed["matched_trend_id"]
