"""Coverage through the re-evaluation sweep (CRMA-767 AC2, AC4, AC5).

Where tests/test_coverage_posture.py holds the valve and
tests/test_coverage_detect.py holds the statement, this file holds the thing
a strategist would notice: a detection landing in ``EVIDENCE.coverage`` on
the next verdict, the posture dropping to watch/covered while the prediction
stays visible, and external demand putting it back.

The seam is ``sweep_predictions`` -- the same call POST /sweep makes -- with
a fixture detector, so nothing here reaches a warehouse or a model.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.coverage import (
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    CoverageDetection,
    CoveragePhase,
    CoverageReading,
    StaticCoverageDetector,
)
from prediction_service.matching.predictions import (
    LIVE_STATUSES,
    StaticOpenPredictionReader,
)
from prediction_service.matching.trends import TrendCandidate, TrendContext
from prediction_service.sweep import SweepScope, sweep_predictions

from .matching_fakes import (
    CANDIDATE_ROWS,
    CONTEXT_ROW,
    DESCRIPTOR_ROWS,
    TREND_ID,
    RecordingTrendReader,
    open_prediction_row,
)
from .sweep_fakes import SweepLedgerSimulator, SweepLLM, reevaluation_reply

HORIZON = datetime(2027, 2, 14, tzinfo=UTC)
NOW = HORIZON - timedelta(days=60)

SUBJECT = "rucking vests"
PREDICTION_ID = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
PRIOR_CONFIDENCE = 68.0

STORY = CoverageDetection(
    headline="We tried rucking vests for a month: here is what actually happened",
    similarity=0.8104,
    content_id="316520398",
    first_published_date="2026-08-01",
    last_published_date="2026-08-03",
    syndicated_copies=4,
)


def trends() -> RecordingTrendReader:
    return RecordingTrendReader(
        descriptors=[TrendCandidate.from_row(row) for row in DESCRIPTOR_ROWS],
        candidates={
            subject: [TrendCandidate.from_row(row) for row in rows]
            for subject, rows in CANDIDATE_ROWS.items()
        },
        contexts={TREND_ID: TrendContext.from_row(CONTEXT_ROW)},
    )


def phase(reading: CoverageReading | None) -> CoveragePhase | None:
    if reading is None:
        return None
    return CoveragePhase(detector=StaticCoverageDetector(readings={SUBJECT: reading}))


def covered_reading(**overrides) -> CoverageReading:
    return CoverageReading(
        subject=SUBJECT, available=True, detections=(STORY,), **overrides
    )


def sweep(*, coverage=None, confidence=PRIOR_CONFIDENCE, rows=None):
    """One sweep of one live prediction, with the model restating
    ``confidence``."""
    llm = SweepLLM(
        reevaluation_reply=reevaluation_reply(
            {
                "id": 1,
                "prediction_id": PREDICTION_ID,
                "subject": SUBJECT,
                "observable_check": "not_yet",
                "observation": "no house-label listing yet",
                "confidence": confidence,
                "reasoning": "restated for this evaluation",
                "what_changed": "",
            }
        )
    )
    return sweep_predictions(
        predictions=StaticOpenPredictionReader(
            rows or [open_prediction_row()], statuses=LIVE_STATUSES
        ),
        trends=trends(),
        llm=llm,
        coverage=coverage,
        scope=SweepScope(),
        now=NOW,
    )


def coverage_of(result):
    return result.outcomes[0].verdict.evidence["coverage"]


# --- AC2: it lands on the next verdict ------------------------------------


def test_a_detection_lands_in_evidence_coverage_on_the_next_verdict():
    payload = coverage_of(sweep(coverage=phase(covered_reading())))

    assert payload["detected"] is True
    assert payload["story_count"] == 1
    assert payload["detections"][0]["headline"].startswith("We tried rucking vests")
    # The dedupe, readable off the row rather than taken on trust.
    assert payload["syndicated_rows"] == 4


def test_a_covered_prediction_demotes_to_watch_covered_and_stays_visible():
    result = sweep(coverage=phase(covered_reading()))
    verdict = result.outcomes[0].verdict

    assert coverage_of(result)["posture"] == POSTURE_WATCH_COVERED
    assert coverage_of(result)["demoted"] is True
    # Visible, not vanished: the row is still ACTIVE, still matched, still
    # carries a confidence. Coverage is a posture change, never a filter.
    assert verdict.status == "ACTIVE"
    assert verdict.matched_trend_id == TREND_ID
    assert len(result.outcomes) == 1
    assert result.skipped == []


def test_a_subject_we_have_not_covered_reads_as_act():
    reading = CoverageReading(subject=SUBJECT, available=True, detections=())
    payload = coverage_of(sweep(coverage=phase(reading)))

    assert payload["available"] is True
    assert payload["detected"] is False
    assert payload["posture"] == POSTURE_ACT
    assert payload["demoted"] is False


def test_the_payload_records_the_calibration_it_was_found_under():
    payload = coverage_of(sweep(coverage=phase(covered_reading())))

    # AC6, on the row itself: a detection stays readable against the cutoff
    # that produced it, however the threshold is retuned later.
    assert payload["min_similarity"] == 0.78
    assert payload["window_days"] == 180
    assert "folded headline" in payload["dedupe_rule"]
    assert "commerce, wire and staff" in payload["coverage_definition"]


# --- AC4: external demand re-raises ---------------------------------------


def test_rising_external_demand_re_raises_a_covered_prediction_to_act():
    # The world kept getting louder after our stories shipped: the model
    # restates confidence UP, and the same detection no longer demotes.
    result = sweep(coverage=phase(covered_reading()), confidence=PRIOR_CONFIDENCE + 9)
    payload = coverage_of(result)

    assert payload["detected"] is True  # the coverage is still recorded...
    assert payload["posture"] == POSTURE_ACT  # ...it just no longer demotes
    assert payload["demoted"] is False
    assert payload["external_demand"]["rising"] is True
    assert result.outcomes[0].confidence_direction == "strengthened"


def test_a_call_that_only_held_steady_stays_covered():
    result = sweep(coverage=phase(covered_reading()), confidence=PRIOR_CONFIDENCE)

    assert coverage_of(result)["posture"] == POSTURE_WATCH_COVERED
    assert coverage_of(result)["external_demand"]["rising"] is False


# --- AC3: the model never sees it ----------------------------------------


def test_the_re_evaluation_prompt_never_mentions_the_coverage_it_found():
    llm = SweepLLM()
    sweep_predictions(
        predictions=StaticOpenPredictionReader([open_prediction_row()], statuses=LIVE_STATUSES),
        trends=trends(),
        llm=llm,
        coverage=phase(covered_reading()),
        scope=SweepScope(),
        now=NOW,
    )

    system, user = llm.reevaluation_prompts[0]
    assert "rucking vests for a month" not in user
    assert "coverage" not in user.lower()
    assert "coverage" not in system.lower()


def test_coverage_cannot_move_the_confidence_the_model_restated():
    # Same restatement, with and without a detection: the number is
    # identical. AC3 as an equality rather than a promise.
    with_coverage = sweep(coverage=phase(covered_reading()), confidence=71.0)
    without = sweep(coverage=None, confidence=71.0)

    assert with_coverage.outcomes[0].verdict.confidence == 71.0
    assert without.outcomes[0].verdict.confidence == 71.0


def test_coverage_never_corroborates_a_trend_that_did_not_match():
    # A detection on a subject the compare step found no trend for leaves
    # MATCHED_TREND_ID null: coverage is not evidence of a trend.
    row = open_prediction_row(subject="probiotic nasal spray")
    detector = StaticCoverageDetector(
        readings={
            "probiotic nasal spray": CoverageReading(
                subject="probiotic nasal spray", available=True, detections=(STORY,)
            )
        }
    )
    llm = SweepLLM()
    result = sweep_predictions(
        predictions=StaticOpenPredictionReader([row], statuses=LIVE_STATUSES),
        trends=trends(),
        llm=llm,
        coverage=CoveragePhase(detector=detector),
        scope=SweepScope(),
        now=NOW,
    )

    verdict = result.outcomes[0].verdict
    assert verdict.evidence["coverage"]["detected"] is True
    assert verdict.matched_trend_id is None


# --- it cannot cost a verdict --------------------------------------------


def test_an_unwired_coverage_phase_leaves_the_prior_reading_standing():
    prior = {
        "source_signals": ["bluesky:3lqz7a2xk4d2m"],
        "saturation": None,
        "trend_context": None,
        "coverage": {"detected": True, "story_count": 2, "posture": POSTURE_WATCH_COVERED},
    }
    result = sweep(coverage=None, rows=[open_prediction_row(evidence=prior)])

    # Nothing was detected this run, so nothing overwrites what the ledger
    # already holds -- the same stance the sweep takes on saturation.
    assert coverage_of(result)["story_count"] == 2


def test_a_detector_outage_costs_a_posture_change_never_a_verdict():
    reading = CoverageReading(
        subject=SUBJECT, available=False, miss_reason="outage", error="RuntimeError: boom"
    )
    result = sweep(coverage=phase(reading))

    assert len(result.outcomes) == 1
    assert coverage_of(result)["available"] is False
    assert coverage_of(result)["posture"] == POSTURE_ACT
    assert coverage_of(result)["demoted"] is False


def test_a_coverage_phase_that_raises_does_not_fail_the_sweep():
    class Exploding:
        def detect(self, subjects):
            raise RuntimeError("boom")

    result = sweep(coverage=CoveragePhase(detector=Exploding()))

    assert len(result.outcomes) == 1
    assert coverage_of(result)["available"] is False
    assert coverage_of(result)["demoted"] is False


def test_coverage_is_additive_and_disturbs_no_other_evidence_key():
    result = sweep(coverage=phase(covered_reading()))
    evidence = result.outcomes[0].verdict.evidence

    for key in ("source_signals", "saturation", "trend_context", "coverage", "reevaluation"):
        assert key in evidence
    assert evidence["source_signals"] == ["bluesky:3lqz7a2xk4d2m"]


# --- through the deployed route ------------------------------------------


def test_the_sweep_route_detects_coverage_and_writes_it_to_the_ledger():
    service_url = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
    snowflake = SweepLedgerSimulator(
        rows=[open_prediction_row()],
        coverage_rows=[
            {
                "SUBJECT_DESCRIPTOR": SUBJECT,
                "CONTENT_ID": 316520398,
                "HEADLINE": STORY.headline,
                "FIRST_PUBLISHED_DATE": "2026-08-01",
                "LAST_PUBLISHED_DATE": "2026-08-03",
                "SYNDICATED_COPIES": 4,
                "SIMILARITY": 0.8104,
            }
        ],
    )
    app = create_app(
        settings=settings_from_env({"PREDICTION_SERVICE_AUDIENCE": service_url}),
        snowflake=snowflake,
        verify_token=lambda token, audience: {
            "email": "caller@x.iam.gserviceaccount.com",
            "aud": audience,
            "iss": "https://accounts.google.com",
        },
        llm=SweepLLM(),
    )
    response = TestClient(app).post(
        "/sweep",
        json={"skip_generation": True},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 200, response.text

    # 1. the detection read happened, and it is a READ
    detections = [call for call in snowflake.calls if "CUE_CONTENT_VECTORS" in call.sql.upper()]
    assert len(detections) == 1
    assert detections[0].kind == "query"

    # 2. AC5 -- nothing was written anywhere but the verdict ledger
    writes = [call for call in snowflake.calls if call.kind == "execute"]
    assert writes
    for write in writes:
        upper = write.sql.upper()
        assert "FCT_PREDICTION_VERDICT_LEDGER" in upper
        for forbidden in ("STG_EXTERNAL_SIGNALS", "FCT_SIGNALS", "FCT_TRENDS"):
            assert forbidden not in upper

    # 3. the detection reached EVIDENCE.coverage on the row that landed
    payload = json.loads(writes[-1].params["evidence"])["coverage"]
    assert payload["detected"] is True
    assert payload["posture"] == POSTURE_WATCH_COVERED
    assert payload["detections"][0]["content_id"] == "316520398"
