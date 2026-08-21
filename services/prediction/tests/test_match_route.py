"""POST /match end to end (CRMA-764 AC1, AC3).

The PRD's primary seam: fire the authenticated HTTP trigger, then assert on
what reached the ledger. Nothing here asserts prompt content or call order
inside the phase.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS

from .fakes import FakePredictionLLM, RecordedCall
from .matching_fakes import (
    OTHER_TREND_ID,
    TREND_ID,
    LedgerSimulator,
    RoutingFakeSnowflake,
    open_prediction_row,
)

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}
GOOGLE_ISSUER = "https://accounts.google.com"

NARRATIVE = json.dumps(
    {
        "reasoning": (
            "The claim now sits on a trend the pipeline already tracks. Heat reads 46 "
            "against 41 seven days ago, so the acceleration of +3.0 says attention is "
            "still building; 4 of 11 linked signals arrived in the last week. The trend "
            "is 31 days old, so the series behind that reading is short."
        )
    }
)


def _verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _client(snowflake, llm=None) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    return TestClient(
        create_app(settings=settings, snowflake=snowflake, verify_token=_verify_ok, llm=llm)
    )


def _both_predictions() -> list[dict]:
    return [
        open_prediction_row(),
        open_prediction_row(
            prediction_id="7dfe9315-9934-4f48-9471-6570f0d739ba",
            subject="probiotic nasal spray",
            confidence=66.0,
            reasoning="Specialty listings appear, but no mass pharmacy has moved.",
        ),
    ]


def test_a_run_produces_both_matched_and_white_space_rows():
    # AC1, at the seam. One live subject resolves to a trend the pipeline
    # tracks; one does not, and is recorded rather than dropped.
    snowflake = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["matched"] == 1
    assert body["white_space"] == 1
    assert body["verdicts_written"] == 2

    by_subject = {r["subject_descriptor"]: r for r in body["results"]}
    matched = by_subject["rucking vests"]
    assert matched["matched_trend_id"] == TREND_ID
    assert matched["match_method"] == "descriptor_vocabulary"
    assert matched["trend_context"]["heat_index"] == 46.0
    assert matched["trend_context"]["acceleration"] == 3.0
    assert matched["trend_context"]["age_days"] == 31.0

    white_space = by_subject["probiotic nasal spray"]
    assert white_space["matched_trend_id"] is None
    assert white_space["trend_context"] is None


def test_both_kinds_of_row_reach_the_ledger_with_the_contracted_evidence():
    snowflake = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    client.post("/match", json={}, headers=AUTH_HEADERS)

    writes = snowflake.writes
    assert len(writes) == 2
    written = {call.params["subject_descriptor"]: call.params for call in writes}

    matched = written["rucking vests"]
    assert matched["matched_trend_id"] == TREND_ID
    evidence = json.loads(matched["evidence"])
    assert all(key in evidence for key in REQUIRED_EVIDENCE_KEYS)
    assert evidence["trend_context"]["trend_id"] == TREND_ID
    # The keys this phase does not own are carried forward untouched.
    assert evidence["source_signals"] == ["bluesky:3lqz7a2xk4d2m"]
    assert evidence["saturation"] is None
    assert evidence["coverage"] is None

    white_space = written["probiotic nasal spray"]
    assert white_space["matched_trend_id"] is None
    ws_evidence = json.loads(white_space["evidence"])
    assert all(key in ws_evidence for key in REQUIRED_EVIDENCE_KEYS)
    assert ws_evidence["trend_context"] is None
    assert ws_evidence["match"]["method"] is None
    # The runners-up are still on the row -- a white-space call is auditable.
    assert ws_evidence["match"]["considered"][0]["trend_id"] == OTHER_TREND_ID


def test_the_matched_verdicts_reasoning_addresses_the_trend_context():
    # AC2's readable half: the narrative the row carries names the measures.
    snowflake = RoutingFakeSnowflake(predictions=[open_prediction_row()])
    llm = FakePredictionLLM(reply=NARRATIVE)
    client = _client(snowflake, llm)

    client.post("/match", json={}, headers=AUTH_HEADERS)

    reasoning = snowflake.writes[0].params["reasoning"]
    assert "46" in reasoning and "acceleration" in reasoning
    # ...and the model was actually shown those figures.
    prompt = llm.last_user_prompt
    assert "heat index now (0-100): 46.0" in prompt
    assert "acceleration (change in the 7-day heat change): 3.0" in prompt


def test_the_frozen_claim_including_the_horizon_is_restated_not_re_derived():
    # A re-evaluation must not push back the date the claim is due to be
    # judged. HORIZON_AT on the new row is the one the ledger already held.
    snowflake = RoutingFakeSnowflake(predictions=[open_prediction_row()])
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    client.post("/match", json={}, headers=AUTH_HEADERS)

    params = snowflake.writes[0].params
    assert params["horizon_at"].isoformat().startswith("2027-02-14")
    assert params["horizon_band"] == "emerging_3_6mo"
    assert params["directional_claim"] == (
        "mainstream retail adoption expands beyond specialty fitness"
    )
    assert params["prediction_id"] == "814a38cb-3935-4ce2-b640-b3154bfa84f4"


def test_re_firing_the_same_chain_id_merges_instead_of_appending():
    first = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(first, FakePredictionLLM(reply=NARRATIVE))
    resp = client.post("/match", json={"chain_id": "pred-match-chain-fixed"}, headers=AUTH_HEADERS)
    first_ids = sorted(r["prediction_eval_id"] for r in resp.json()["results"])

    second = RoutingFakeSnowflake(predictions=_both_predictions(), rowcount=0)
    client = _client(second, FakePredictionLLM(reply=NARRATIVE))
    resp = client.post("/match", json={"chain_id": "pred-match-chain-fixed"}, headers=AUTH_HEADERS)

    assert sorted(r["prediction_eval_id"] for r in resp.json()["results"]) == first_ids
    # rowcount 0 models the MERGE matching what the first run wrote.
    assert resp.json()["verdicts_written"] == 0


def test_a_dry_run_resolves_the_matches_and_writes_nothing():
    snowflake = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    resp = client.post("/match", json={"dry_run": True}, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["matched"] == 1
    assert resp.json()["verdicts_written"] == 0
    assert snowflake.writes == []


def test_the_only_write_a_match_run_makes_is_the_verdict_ledger():
    # AC3's structural half: a white-space prediction reaches the ledger and
    # nothing else. No trend table, no signal corpus, no dashboard object is
    # written by this run -- the isolation invariant, asserted over the whole
    # statement set rather than intended in a comment.
    snowflake = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    client.post("/match", json={}, headers=AUTH_HEADERS)

    assert snowflake.writes, "the run must have written the verdict rows"
    for call in snowflake.writes:
        assert "FCT_PREDICTION_VERDICT_LEDGER" in call.sql.upper()
        assert call.sql.strip().upper().startswith("MERGE INTO")


def test_a_service_with_no_narrative_model_still_matches():
    # /match does not 503 the way /generate does: the match itself is decided
    # without a model, so a keyless service still writes correct
    # MATCHED_TREND_IDs and trend_context -- only the narrative degrades.
    snowflake = RoutingFakeSnowflake(predictions=[open_prediction_row()])
    client = _client(snowflake, llm=None)

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    result = resp.json()["results"][0]
    assert result["matched_trend_id"] == TREND_ID
    assert result["narrated"] is False
    assert "no narrative model" in result["note"]
    # The prior evaluation's reasoning is carried forward verbatim.
    assert snowflake.writes[0].params["reasoning"].startswith("Four independent sources")


def test_a_failing_narrative_call_degrades_the_prose_and_never_the_row():
    from prediction_service.generation.llm import LLMError

    snowflake = RoutingFakeSnowflake(predictions=[open_prediction_row()])
    client = _client(snowflake, FakePredictionLLM(fail_with=LLMError("upstream 500")))

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["verdicts_written"] == 1
    assert resp.json()["results"][0]["matched_trend_id"] == TREND_ID
    assert "narrative unavailable" in resp.json()["results"][0]["note"]


def test_a_run_with_no_open_predictions_is_an_empty_success():
    snowflake = RoutingFakeSnowflake(predictions=[])
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["predictions_considered"] == 0
    assert snowflake.writes == []


def test_the_route_requires_a_caller():
    snowflake = RoutingFakeSnowflake(predictions=[])
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    assert client.post("/match", json={}).status_code == 401


def test_a_warehouse_failure_is_a_502_that_wrote_nothing():
    class Exploding(RoutingFakeSnowflake):
        def query(self, sql, params=None):
            raise RuntimeError("Error contacting database")

    snowflake = Exploding()
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 502
    assert snowflake.writes == []


def test_the_scope_bounds_are_validated_at_the_edge():
    snowflake = RoutingFakeSnowflake(predictions=[])
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    def status(body):
        return client.post("/match", json=body, headers=AUTH_HEADERS).status_code

    assert status({"min_similarity": 1.5}) == 422
    assert status({"prediction_limit": 0}) == 422


def test_a_failed_context_read_alone_still_writes_every_row():
    # The distinction the blanket-failure test above cannot make. Trend
    # context is *evidence*; the heaviest statement this phase issues is the
    # one that fetches it, and one timeout on one matched trend must not cost
    # the run -- least of all the white-space rows, which never needed a
    # context read at all.
    class ContextTimesOut(RoutingFakeSnowflake):
        def query(self, sql, params=None):
            if "DATEDIFF" in sql.upper():
                self.calls.append(RecordedCall(sql, params, kind="query"))
                raise RuntimeError("000630: Statement reached its statement or warehouse timeout")
            return super().query(sql, params)

    snowflake = ContextTimesOut(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    resp = client.post("/match", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["matched"] == 1
    assert body["white_space"] == 1
    # Both rows land -- the matched one without its context, the white-space
    # one exactly as it always would have.
    assert body["verdicts_written"] == 2
    assert len(snowflake.writes) == 2

    by_subject = {r["subject_descriptor"]: r for r in body["results"]}
    matched = by_subject["rucking vests"]
    assert matched["matched_trend_id"] == TREND_ID
    assert matched["trend_context"] is None
    assert "trend context unavailable" in matched["note"]
    # ...and the evidence key is present-but-null, per the ledger contract.
    evidence = json.loads(snowflake.writes[0].params["evidence"])
    assert set(REQUIRED_EVIDENCE_KEYS) <= set(evidence)
    assert evidence["trend_context"] is None


def test_evaluated_at_is_written_in_utc_alongside_horizon_at():
    # Both columns are TIMESTAMP_NTZ. HORIZON_AT is written by this service
    # from an aware UTC datetime; EVALUATED_AT used to take the DDL's
    # CURRENT_TIMESTAMP() default, which Snowflake evaluates in the *session*
    # timezone -- so the two columns sat hours apart on rows minted in the
    # same instant, and a resolution sweep would grade one against the other.
    snowflake = RoutingFakeSnowflake(predictions=_both_predictions())
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    before = datetime.now(UTC)
    resp = client.post("/match", json={}, headers=AUTH_HEADERS)
    after = datetime.now(UTC)

    assert resp.status_code == 200, resp.text
    for write in snowflake.writes:
        assert "EVALUATED_AT" in write.sql
        evaluated_at = write.params["evaluated_at"]
        assert evaluated_at.tzinfo is not None
        assert evaluated_at.utcoffset() == timedelta(0)
        assert before <= evaluated_at <= after
        # ...and it is on the same clock as HORIZON_AT, which is what makes
        # the two comparable at resolution time.
        assert write.params["horizon_at"].utcoffset() == timedelta(0)


def test_the_open_pool_is_worked_through_rather_than_starved():
    # AC1/AC3 depend on "unmatched" meaning white space. Every evaluation
    # appends a row, so evaluating a prediction makes it the most recently
    # evaluated one: a newest-first ORDER BY under a LIMIT would hand the cap
    # back to the same head of the queue forever and leave the tail with
    # MATCHED_TREND_ID NULL indefinitely, indistinguishable from a genuine
    # miss. This runs five open predictions through a cap of two and asserts
    # every one of them is eventually looked at.
    pool = [
        open_prediction_row(prediction_id=f"pred-{n}", subject=f"subject {n}")
        for n in range(5)
    ]
    for offset, row in enumerate(pool):
        row["EVALUATED_AT"] = datetime(2026, 8, 1, 12, 0, tzinfo=UTC) + timedelta(hours=offset)

    snowflake = LedgerSimulator(rows=pool)
    client = _client(snowflake, FakePredictionLLM(reply=NARRATIVE))

    seen: set[str] = set()
    for _ in range(4):
        resp = client.post("/match", json={"prediction_limit": 2}, headers=AUTH_HEADERS)
        assert resp.status_code == 200, resp.text
        seen |= {r["prediction_id"] for r in resp.json()["results"]}

    assert seen == {row["PREDICTION_ID"] for row in pool}
