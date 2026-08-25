"""The middle rung of the precedence ladder, end to end (CRMA-768 AC3).

    strategist action > **coverage demotion** > automated evidence

CRMA-767 owns coverage *detection* and its own `EVIDENCE.coverage` payload;
CRMA-768 owns the ladder that decides which rung a verdict's posture came
from. Between the two stories sits one line in sweep/run.py -- the
``coverage_demotes(covered, demand=demand)`` call whose result feeds both
``resolve_posture`` and ``EVIDENCE.strategist``.

Neither story's own tests reach that line. 767's assert on
``EVIDENCE.coverage.posture``, which ``record_coverage`` builds from the
reading directly; 768's drive the ladder with the flag passed by hand. So the
wiring between them could be replaced with a literal ``False`` and every test
in both files would still pass. This file is what makes that revert fail.

Three cases, and the second is the one the whole design of the call site is
for:

1. A real detection demotes the posture, and the ladder says coverage did it.
2. **An Approve overrules a real detection.** The settled tier is
   ``strategist_action``, so a row that derived ``coverage_demoted`` back out
   of its own posture would claim no coverage demotion happened -- while the
   same row's ``reason`` says a human overruled one. The flag has to be
   carried, not re-derived.
3. Rising external demand re-raises a covered call, driven by the demand
   argument alone -- the one-way valve's return leg, read through the ladder
   rather than through 767's payload.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.coverage import (
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
from prediction_service.strategist import (
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    TIER_AUTOMATED_EVIDENCE,
    TIER_COVERAGE_DEMOTION,
    TIER_STRATEGIST_ACTION,
    StaticStrategistDecisionReader,
    StrategistDecision,
)
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

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}

HORIZON = datetime(2027, 2, 14, tzinfo=UTC)
NOW = HORIZON - timedelta(days=60)

SUBJECT = "rucking vests"
PREDICTION_ID = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
PRIOR_CONFIDENCE = 68.0
DECIDED_AT = datetime(2026, 8, 22, 15, 4, tzinfo=UTC)

#: 767's fixture story, restated here rather than imported from its test
#: module: this file is the seam between the two stories and should not break
#: because a sibling renamed one of its own fixtures.
STORY = CoverageDetection(
    headline="We tried rucking vests for a month: here is what actually happened",
    similarity=0.8104,
    content_id="316520398",
    first_published_date="2026-08-01",
    last_published_date="2026-08-03",
    syndicated_copies=4,
)

COVERAGE_ROW = {
    "SUBJECT_DESCRIPTOR": SUBJECT,
    "CONTENT_ID": 316520398,
    "HEADLINE": STORY.headline,
    "FIRST_PUBLISHED_DATE": "2026-08-01",
    "LAST_PUBLISHED_DATE": "2026-08-03",
    "SYNDICATED_COPIES": 4,
    "SIMILARITY": 0.8104,
}


def _trends() -> RecordingTrendReader:
    return RecordingTrendReader(
        descriptors=[TrendCandidate.from_row(row) for row in DESCRIPTOR_ROWS],
        candidates={
            subject: [TrendCandidate.from_row(row) for row in rows]
            for subject, rows in CANDIDATE_ROWS.items()
        },
        contexts={TREND_ID: TrendContext.from_row(CONTEXT_ROW)},
    )


def _covered() -> CoveragePhase:
    """A detector that has genuinely published on this subject."""
    return CoveragePhase(
        detector=StaticCoverageDetector(
            readings={
                SUBJECT: CoverageReading(subject=SUBJECT, available=True, detections=(STORY,))
            }
        )
    )


def _uncovered() -> CoveragePhase:
    """A detector that looked and found nothing -- a reading, not a miss."""
    return CoveragePhase(
        detector=StaticCoverageDetector(
            readings={SUBJECT: CoverageReading(subject=SUBJECT, available=True, detections=())}
        )
    )


def _llm(confidence: float = PRIOR_CONFIDENCE) -> SweepLLM:
    return SweepLLM(
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


def _decisions(action: str | None) -> StaticStrategistDecisionReader:
    if action is None:
        return StaticStrategistDecisionReader()
    return StaticStrategistDecisionReader(
        decisions=[
            StrategistDecision(
                prediction_id=PREDICTION_ID, decision=action, decided_at=DECIDED_AT
            )
        ]
    )


def _sweep(*, coverage, decision=None, confidence=PRIOR_CONFIDENCE):
    return sweep_predictions(
        predictions=StaticOpenPredictionReader(
            [open_prediction_row()], statuses=LIVE_STATUSES
        ),
        trends=_trends(),
        llm=_llm(confidence),
        coverage=coverage,
        decisions=_decisions(decision),
        scope=SweepScope(),
        now=NOW,
    )


def _strategist(result) -> dict:
    return result.outcomes[0].verdict.evidence["strategist"]


def _verdict_write(snowflake) -> dict:
    """The EVIDENCE the route wrote to the verdict ledger.

    Selected by the bind names rather than by position: a run that read a
    strategist decision also writes a calibration label, so the LAST write is
    not necessarily the verdict.
    """
    rows = [
        call.params
        for call in snowflake.calls
        if call.kind == "execute" and "evidence" in call.params
    ]
    assert rows, "no verdict row was written"
    return json.loads(rows[-1]["evidence"])


# --- 1. a real detection demotes, and the ladder says coverage did it -----


def test_a_real_detection_settles_the_posture_on_the_coverage_rung():
    result = _sweep(coverage=_covered())
    outcome = result.outcomes[0]

    assert outcome.posture.posture == POSTURE_WATCH_COVERED
    assert outcome.posture.tier == TIER_COVERAGE_DEMOTION
    payload = _strategist(result)
    assert payload["posture"] == POSTURE_WATCH_COVERED
    assert payload["precedence_tier"] == TIER_COVERAGE_DEMOTION
    assert payload["coverage_demoted"] is True
    # Demotion is not removal: the call is still live, still matched.
    assert outcome.verdict.status == "ACTIVE"
    assert outcome.verdict.matched_trend_id == TREND_ID


def test_a_subject_we_have_not_published_on_stays_on_the_automated_rung():
    # The control for the test above: same wiring, no detection, so the
    # ladder never reaches the coverage rung.
    result = _sweep(coverage=_uncovered())

    assert _strategist(result)["precedence_tier"] == TIER_AUTOMATED_EVIDENCE
    assert _strategist(result)["coverage_demoted"] is False
    assert _strategist(result)["posture"] == POSTURE_ACT


def test_the_coverage_demotion_is_said_out_loud_in_what_changed():
    result = _sweep(coverage=_covered())

    assert "watch/covered" in (result.outcomes[0].verdict.what_changed or "")


# --- 2. AC3: an Approve overrules a REAL coverage demotion ----------------


def test_an_approve_overrules_a_real_coverage_demotion_and_the_row_says_so():
    result = _sweep(coverage=_covered(), decision="APPROVE")
    outcome = result.outcomes[0]
    payload = _strategist(result)

    # The human tier won...
    assert outcome.posture.posture == POSTURE_ACT
    assert outcome.posture.tier == TIER_STRATEGIST_ACTION
    assert outcome.posture.protected is True
    # ...and the row still records that there WAS a coverage demotion to
    # overrule. This is the assertion the call site's local variable exists
    # for: the settled tier is strategist_action, so anything deriving this
    # flag back out of the posture reads False here and the row contradicts
    # its own reason string.
    assert payload["coverage_demoted"] is True
    assert payload["protected_from_demotion"] is True
    assert "coverage demotion does not apply" in payload["reason"]


def test_an_approve_with_no_coverage_is_not_recorded_as_overruling_one():
    # The other side of the same flag: an Approve on an uncovered call has
    # nothing to overrule, so it must not claim it did.
    payload = _strategist(_sweep(coverage=_uncovered(), decision="APPROVE"))

    assert payload["coverage_demoted"] is False
    assert payload["protected_from_demotion"] is False


def test_a_dismiss_outranks_a_real_coverage_demotion_too():
    # Top rung over middle rung: the call is withdrawn, not demoted, and the
    # detection is still recorded against it.
    result = _sweep(coverage=_covered(), decision="DISMISS")
    payload = _strategist(result)

    assert result.outcomes[0].verdict.status == "WITHDRAWN"
    assert payload["posture"] == "withdrawn"
    assert payload["precedence_tier"] == TIER_STRATEGIST_ACTION
    assert payload["coverage_demoted"] is True
    assert result.outcomes[0].verdict.evidence["coverage"]["detected"] is True


# --- 3. the re-raise leg, read through the ladder -------------------------


def test_rising_external_demand_takes_a_covered_call_back_off_the_coverage_rung():
    """The valve's return leg, asserted as a *difference*.

    Written differentially on purpose. "Demand rose, so the posture is act"
    is also what a call site that never consulted coverage at all would
    produce, so on its own this case cannot tell a working valve from a
    missing one. The same detection under two demand readings can: only the
    demand argument differs between these two sweeps, so the postures having
    to differ is the assertion.
    """
    rising = _sweep(coverage=_covered(), confidence=PRIOR_CONFIDENCE + 9)
    steady = _sweep(coverage=_covered(), confidence=PRIOR_CONFIDENCE)

    assert rising.outcomes[0].confidence_direction == "strengthened"
    assert steady.outcomes[0].confidence_direction == "unchanged"

    assert _strategist(rising)["coverage_demoted"] is False
    assert _strategist(rising)["posture"] == POSTURE_ACT
    assert _strategist(rising)["precedence_tier"] == TIER_AUTOMATED_EVIDENCE

    assert _strategist(steady)["coverage_demoted"] is True
    assert _strategist(steady)["posture"] == POSTURE_WATCH_COVERED

    # The coverage itself is still on both rows -- the valve changed a
    # posture, it did not delete a detection.
    for result in (rising, steady):
        assert result.outcomes[0].verdict.evidence["coverage"]["detected"] is True


def test_a_call_that_only_held_steady_stays_on_the_coverage_rung():
    payload = _strategist(_sweep(coverage=_covered(), confidence=PRIOR_CONFIDENCE))

    assert payload["coverage_demoted"] is True
    assert payload["precedence_tier"] == TIER_COVERAGE_DEMOTION


# --- 4. one row, one posture: the detector-outage case -------------------


def _covered_prior() -> dict:
    """A ledger row that already carries a real detection and the demotion
    derived from it -- what the previous sweep wrote."""
    return {
        "source_signals": ["bluesky:3lqz7a2xk4d2m"],
        "saturation": None,
        "trend_context": None,
        "strategist": None,
        "coverage": {
            "detected": True,
            "story_count": 1,
            "posture": POSTURE_WATCH_COVERED,
            "demoted": True,
            "detections": [{"content_id": "316520398", "headline": STORY.headline}],
        },
    }


def _outage() -> CoveragePhase:
    """The detector was wired and the warehouse did not answer."""
    return CoveragePhase(
        detector=StaticCoverageDetector(
            readings={
                SUBJECT: CoverageReading(
                    subject=SUBJECT,
                    available=False,
                    miss_reason="outage",
                    error="RuntimeError: boom",
                )
            }
        )
    )


def _sweep_over(prior: dict, *, coverage, decision=None, confidence=PRIOR_CONFIDENCE):
    return sweep_predictions(
        predictions=StaticOpenPredictionReader(
            [open_prediction_row(evidence=prior)], statuses=LIVE_STATUSES
        ),
        trends=_trends(),
        llm=_llm(confidence),
        coverage=coverage,
        decisions=_decisions(decision),
        scope=SweepScope(),
        now=NOW,
    )


def test_a_detector_outage_leaves_both_evidence_blocks_saying_watch_covered():
    """The contradiction this pair of stories shipped without a test.

    ``record_coverage`` deliberately keeps a prior detection when the
    detector could not answer -- overwriting it with a miss would re-raise a
    covered call with no external demand behind it (CRMA-767 AC4). The
    ladder therefore has to read the coverage that *lands*, not this pass's
    unavailable reading: asked about the reading, the valve says "no
    demotion", and the one row then states two postures. CRMA-769 projects
    ``EVIDENCE.strategist.posture`` for queue standing, so the wrong one is
    the one a strategist sees.
    """
    result = _sweep_over(_covered_prior(), coverage=_outage())
    evidence = result.outcomes[0].verdict.evidence

    assert evidence["coverage"]["posture"] == POSTURE_WATCH_COVERED
    assert evidence["strategist"]["posture"] == POSTURE_WATCH_COVERED
    assert evidence["strategist"]["coverage_demoted"] is True
    assert evidence["strategist"]["precedence_tier"] == TIER_COVERAGE_DEMOTION
    # And the row still says it could not look, so the posture is readable as
    # a carried-forward one rather than a fresh detection.
    assert evidence["coverage"]["error"] == "RuntimeError: boom"


def test_an_approve_still_overrules_a_carried_forward_demotion():
    # The two fixes meeting: the demotion survives the outage, and the human
    # tier still outranks it -- recorded as overruled, not as absent.
    result = _sweep_over(_covered_prior(), coverage=_outage(), decision="APPROVE")
    evidence = result.outcomes[0].verdict.evidence

    assert evidence["coverage"]["posture"] == POSTURE_WATCH_COVERED
    assert evidence["strategist"]["posture"] == POSTURE_ACT
    assert evidence["strategist"]["precedence_tier"] == TIER_STRATEGIST_ACTION
    assert evidence["strategist"]["coverage_demoted"] is True
    assert evidence["strategist"]["protected_from_demotion"] is True


def test_an_unwired_detector_also_leaves_the_two_blocks_agreeing():
    # No coverage phase at all -- local runs, and any deploy without the
    # detector. `record_coverage` returns the evidence untouched, so the
    # prior payload is what lands, and the ladder must read that rather than
    # treating "nobody looked" as "not covered".
    result = _sweep_over(_covered_prior(), coverage=None)
    evidence = result.outcomes[0].verdict.evidence

    assert evidence["coverage"]["posture"] == POSTURE_WATCH_COVERED
    assert evidence["strategist"]["posture"] == POSTURE_WATCH_COVERED
    assert evidence["strategist"]["coverage_demoted"] is True


def test_a_pass_that_looked_and_found_nothing_lifts_both_blocks_together():
    # The other direction, so the agreement is not just "always demoted": a
    # reading that actually looked and found the stories gone from the window
    # lifts the demotion, and both blocks move together.
    result = _sweep_over(_covered_prior(), coverage=_uncovered())
    evidence = result.outcomes[0].verdict.evidence

    assert evidence["coverage"]["posture"] == POSTURE_ACT
    assert evidence["strategist"]["posture"] == POSTURE_ACT
    assert evidence["strategist"]["coverage_demoted"] is False
    assert evidence["strategist"]["precedence_tier"] == TIER_AUTOMATED_EVIDENCE


def test_a_row_with_no_prior_coverage_is_not_read_as_covered():
    # The null case: a prediction minted before the detector existed carries
    # `coverage: None`, which must read as "no demotion", not as a demotion.
    prior = {
        "source_signals": [],
        "saturation": None,
        "trend_context": None,
        "coverage": None,
        "strategist": None,
    }
    result = _sweep_over(prior, coverage=None)
    evidence = result.outcomes[0].verdict.evidence

    assert evidence["coverage"] is None
    assert evidence["strategist"]["coverage_demoted"] is False
    assert evidence["strategist"]["posture"] == POSTURE_ACT


# --- through the deployed route ------------------------------------------


def test_the_sweep_route_settles_the_coverage_rung_on_the_row_it_writes():
    snowflake = SweepLedgerSimulator(
        rows=[open_prediction_row()], coverage_rows=[dict(COVERAGE_ROW)]
    )
    app = create_app(
        settings=settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL}),
        snowflake=snowflake,
        verify_token=lambda token, audience: {
            "email": "caller@x.iam.gserviceaccount.com",
            "aud": audience,
            "iss": "https://accounts.google.com",
        },
        llm=SweepLLM(),
        decisions=_decisions(None),
    )

    response = TestClient(app).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    assert response.status_code == 200, response.text

    assert response.json()["results"][0]["posture"] == POSTURE_WATCH_COVERED
    assert response.json()["results"][0]["posture_tier"] == TIER_COVERAGE_DEMOTION

    payload = _verdict_write(snowflake)["strategist"]
    assert payload["precedence_tier"] == TIER_COVERAGE_DEMOTION
    assert payload["coverage_demoted"] is True


def test_the_sweep_route_lets_an_approve_overrule_the_detection_it_found():
    snowflake = SweepLedgerSimulator(
        rows=[open_prediction_row()], coverage_rows=[dict(COVERAGE_ROW)]
    )
    app = create_app(
        settings=settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL}),
        snowflake=snowflake,
        verify_token=lambda token, audience: {
            "email": "caller@x.iam.gserviceaccount.com",
            "aud": audience,
            "iss": "https://accounts.google.com",
        },
        llm=SweepLLM(),
        decisions=_decisions("APPROVE"),
    )

    response = TestClient(app).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    assert response.status_code == 200, response.text

    assert response.json()["results"][0]["posture"] == POSTURE_ACT
    assert response.json()["results"][0]["posture_tier"] == TIER_STRATEGIST_ACTION

    evidence = _verdict_write(snowflake)
    # The detection is on the row, and the strategist block records that it
    # was overruled rather than that it never happened.
    assert evidence["coverage"]["detected"] is True
    assert evidence["strategist"]["coverage_demoted"] is True
    assert evidence["strategist"]["protected_from_demotion"] is True
