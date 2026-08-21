"""Saturation is evidence, and the floor is the only gate (CRMA-765).

Driven end to end through POST /generate, because that is the seam the PRD
names: "fire the HTTP trigger, assert what landed in the ledger". Every
assertion here is about rows -- which ones were written, with what confidence,
carrying what evidence -- not about internal call order.

The four ACs this file carries:

* **AC1** every written row carries ``EVIDENCE.saturation`` with the Exploding
  Topics classification (or an explicit miss) and the GDELT breadth.
* **AC2** an ET miss costs nothing: the same run with ET missing and with ET
  hitting writes the same rows at the same confidence.
* **AC3** a ``peaked`` classification reaches the model and lands in
  ``REASONING`` -- and writes exactly as many rows as any other reading.
* **AC5** the exhaustive matrix: across every ET classification, every miss
  kind and every breadth reading including an outage, the set of rows and
  their confidences is IDENTICAL. Nothing about saturation can exclude or
  discount anything.
* **AC4** the floor skips a too-young or too-sparse subject and it produces no
  row -- and with the floor relaxed the same run writes everything, which is
  what makes it the *only* gate.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.saturation import (
    ArticleBreadth,
    DataQualityFloor,
    SaturationLookup,
    SaturationPhase,
    StaticBreadthReader,
    StaticSaturationOracle,
)
from prediction_service.saturation.lookup import (
    ERROR_DEADLINE_EXCEEDED,
    MISS_LOOKUP_FAILED,
    MISS_NOT_IN_CATALOG,
)

from .fakes import FakePredictionLLM, FakeSnowflake

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}

RICH = (
    "Adjustable weighted vests in the 12-20 lb range hold four consecutive weeks on the "
    "category movers list; the leading listings are specialty fitness brands rather than "
    "the mass-market house labels that dominate the rest of the category."
)


def _at(hours_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours_ago)).strftime("%Y-%m-%d %H:%M:%S.%f")


def _row(signal_id: str, *, hours_ago: float = 96, text: str = RICH) -> dict:
    return {
        "SIGNAL_ID": signal_id,
        "SOURCE_NAME": "amazon_trends",
        "SIGNAL_TIMESTAMP": _at(hours_ago),
        "SIGNAL_TITLE": "weighted vests hold the movers list",
        "SIGNAL_TEXT": text,
    }


SETTLED_CORPUS = [_row("s1"), _row("s2", hours_ago=120), _row("s3", hours_ago=72)]

REPLY = json.dumps(
    {
        "predictions": [
            {
                "subject_descriptor": "rucking vests",
                "directional_claim": "mass-market retail adoption expands beyond specialty",
                "horizon_band": "emerging_3_6mo",
                "observable_check": "Target lists a house-label weighted vest under 20 lb",
                "confidence": 68,
                "reasoning": "four independent signals converge on the same shift",
                "source_signals": ["s1", "s2"],
            },
            {
                "subject_descriptor": "cottage cheese",
                "directional_claim": "displaces ricotta as the default soft cheese",
                "horizon_band": "cultural_shift_6_12mo",
                "observable_check": "Good & Gather lists a 4% milkfat tub in its catalog",
                "confidence": 54,
                "reasoning": "a supply-side change plus an inverted diet framing",
                "source_signals": ["s3"],
            },
        ]
    }
)


def _verify_ok(token: str, audience: str) -> dict:
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "https://accounts.google.com",
    }


def _client(snowflake: FakeSnowflake, llm, phase: SaturationPhase) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    return TestClient(
        create_app(
            settings=settings,
            snowflake=snowflake,
            verify_token=_verify_ok,
            llm=llm,
            saturation=phase,
        )
    )


def _phase(
    *,
    lookup: SaturationLookup | None = None,
    reading: ArticleBreadth | None = None,
    floor: DataQualityFloor | None = None,
) -> SaturationPhase:
    """One phase for both subjects: the readings under test apply to whatever
    subject the model proposed, which is what makes the matrix below a
    comparison of readings rather than of subjects."""
    oracle = StaticSaturationOracle(
        lookups={s: lookup for s in ("rucking vests", "cottage cheese")} if lookup else {}
    )
    breadth = StaticBreadthReader(
        readings={s: reading for s in ("rucking vests", "cottage cheese")} if reading else {}
    )
    return SaturationPhase(oracle=oracle, breadth=breadth, floor=floor or DataQualityFloor())


def _writes(snowflake: FakeSnowflake) -> list[dict]:
    return [dict(call.params) for call in snowflake.calls if call.kind == "execute"]


def _fire(phase: SaturationPhase, *, rows=None, weighing_reply=None) -> tuple[FakeSnowflake, dict]:
    snowflake = FakeSnowflake(rows=list(SETTLED_CORPUS if rows is None else rows))
    llm = FakePredictionLLM(reply=REPLY)
    if weighing_reply is not None:
        llm.weighing_reply = weighing_reply
    body = _client(snowflake, llm, phase).post("/generate", json={}, headers=AUTH_HEADERS).json()
    return snowflake, body


def _landed(snowflake: FakeSnowflake) -> dict[str, float]:
    return {w["subject_descriptor"]: w["confidence"] for w in _writes(snowflake)}


def _saturation(write: dict) -> dict:
    return json.loads(write["evidence"])["saturation"]


# --- the readings under test ----------------------------------------------

PEAKED = SaturationLookup(
    query="rucking vests",
    matched=True,
    classification="peaked",
    classifications={"3": "peaked", "12": "peaked"},
    growth={"12": "+318%"},
    keyword="rucking vest",
    absolute_volume=40500,
    total=3,
)
EXPLODING = SaturationLookup(
    query="rucking vests",
    matched=True,
    classification="exploding",
    classifications={"12": "exploding"},
    keyword="rucking vest",
    absolute_volume=40500,
    total=3,
)
REGULAR = SaturationLookup(
    query="rucking vests", matched=True, classification="regular", keyword="vest", total=1
)
CATALOG_MISS = SaturationLookup(
    query="rucking vests", matched=False, miss_reason=MISS_NOT_IN_CATALOG
)
OUTAGE = SaturationLookup(
    query="rucking vests", matched=False, miss_reason=MISS_LOOKUP_FAILED, error="http_403"
)

BROAD = ArticleBreadth(
    query="rucking vests",
    available=True,
    article_count=44,
    distinct_domains=19,
    top_domains=("nytimes.com", "today.com"),
)
NARROW = ArticleBreadth(query="rucking vests", available=True, article_count=2, distinct_domains=2)
SILENT = ArticleBreadth(query="rucking vests", available=True)
GDELT_DOWN = ArticleBreadth(query="rucking vests", available=False, error="rate_limited")


# --- AC1 -------------------------------------------------------------------


def test_every_written_row_carries_the_classification_and_the_breadth():
    snowflake, body = _fire(_phase(lookup=PEAKED, reading=BROAD))

    assert body["predictions_written"] == 2
    for write in _writes(snowflake):
        saturation = _saturation(write)
        assert saturation["exploding_topics"]["classification"] == "peaked"
        assert saturation["gdelt"]["article_count"] == 44
        assert saturation["gdelt"]["distinct_domains"] == 19
        assert saturation["data_quality_floor"]["passes"] is True


def test_a_row_records_an_et_miss_explicitly_rather_than_as_an_absent_key():
    snowflake, _ = _fire(_phase(lookup=None, reading=NARROW))

    for write in _writes(snowflake):
        et = _saturation(write)["exploding_topics"]
        assert et["matched"] is False
        assert et["miss_reason"] == MISS_NOT_IN_CATALOG
        assert et["miss_carries_no_penalty"] is True


# --- AC2: a miss costs nothing --------------------------------------------


def test_an_et_miss_produces_exactly_the_confidence_an_et_hit_does():
    # Same corpus, same model reply, same weighing answer -- the ONLY
    # difference is whether Exploding Topics knows the subject. If any code
    # path penalised a miss, these two would differ.
    hit, _ = _fire(_phase(lookup=EXPLODING, reading=BROAD))
    miss, _ = _fire(_phase(lookup=CATALOG_MISS, reading=BROAD))

    assert _landed(miss) == _landed(hit) == {"rucking vests": 68.0, "cottage cheese": 54.0}


def test_an_et_outage_produces_exactly_the_confidence_a_hit_does():
    # AC2's harder half: not "ET said nothing" but "ET could not be reached".
    # An outage degrades to a miss with no penalty, never to a failed run.
    hit, _ = _fire(_phase(lookup=EXPLODING, reading=BROAD))
    down, body = _fire(_phase(lookup=OUTAGE, reading=GDELT_DOWN))

    assert body["predictions_written"] == 2
    assert _landed(down) == _landed(hit)
    saturation = _saturation(_writes(down)[0])
    assert saturation["exploding_topics"]["error"] == "http_403"
    assert saturation["gdelt"]["available"] is False


def test_the_weighing_pass_carries_the_models_number_across_verbatim():
    # The other side of AC2: when the model DOES move a number, code copies
    # it exactly -- no rounding, no clamping, no adjustment of its own.
    restated = json.dumps(
        {
            "weighings": [
                {
                    "id": 1,
                    "subject": "rucking vests",
                    "confidence": 57.5,
                    "reasoning": "ET says peaked; 19 publishers",
                },
                {
                    "id": 2,
                    "subject": "cottage cheese",
                    "confidence": 61,
                    "reasoning": "exploding with narrow news breadth",
                },
            ]
        }
    )
    snowflake, _ = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply=restated)

    assert _landed(snowflake) == {"rucking vests": 57.5, "cottage cheese": 61.0}
    weighing = _saturation(_writes(snowflake)[0])["weighing"]
    assert weighing["weighed"] is True
    assert weighing["confidence_before"] == 68.0
    assert weighing["confidence_after"] == 57.5


# --- AC3: peaked is addressed, and excludes nothing ------------------------


def test_a_peaked_reading_reaches_the_model_and_lands_in_the_reasoning():
    restated = json.dumps(
        {
            "weighings": [
                {
                    "id": 1,
                    "subject": "rucking vests",
                    "confidence": 57,
                    "reasoning": (
                        "Exploding Topics classifies the matched keyword as peaked at 3 and "
                        "12 months and GDELT shows 44 articles across 19 publishers, so the "
                        "window this call depends on is narrower than the corpus suggested."
                    ),
                },
                {
                    "id": 2,
                    "subject": "cottage cheese",
                    "confidence": 54,
                    "reasoning": "peaked reading did not change my view",
                },
            ]
        }
    )
    snowflake, _ = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply=restated)

    written = {w["subject_descriptor"]: w["reasoning"] for w in _writes(snowflake)}
    assert "peaked" in written["rucking vests"]
    assert "19 publishers" in written["rucking vests"]
    # The second call kept its own number after addressing the same reading --
    # "argues against" is an argument the model may decline, not a rule.
    assert _landed(snowflake)["cottage cheese"] == 54.0


def test_a_peaked_reading_writes_exactly_the_rows_an_exploding_one_does():
    peaked, _ = _fire(_phase(lookup=PEAKED, reading=BROAD))
    exploding, _ = _fire(_phase(lookup=EXPLODING, reading=NARROW))

    assert _landed(peaked) == _landed(exploding)
    assert [w["status"] for w in _writes(peaked)] == ["ACTIVE", "ACTIVE"]


# --- AC5: the exhaustive matrix -------------------------------------------


SATURATION_MATRIX = [
    pytest.param(lookup, reading, id=f"{name}-{breadth_name}")
    for name, lookup in (
        ("peaked", PEAKED),
        ("exploding", EXPLODING),
        ("regular", REGULAR),
        ("catalog-miss", CATALOG_MISS),
        ("et-outage", OUTAGE),
    )
    for breadth_name, reading in (
        ("broad", BROAD),
        ("narrow", NARROW),
        ("silent", SILENT),
        ("gdelt-down", GDELT_DOWN),
    )
]


@pytest.mark.parametrize(("lookup", "reading"), SATURATION_MATRIX)
def test_no_saturation_reading_can_exclude_or_discount_anything(lookup, reading):
    # AC5, held as behaviour rather than as a claim. The weighing model
    # returns no restatement in every cell, so any difference between cells
    # would be CODE reacting to a classification or a breadth number -- the
    # mechanical gate or discount the strategy forbids.
    snowflake, body = _fire(_phase(lookup=lookup, reading=reading))

    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    assert body["predictions_written"] == 2
    assert [r["reason"] for r in body["rejections"]] == []


@pytest.mark.parametrize(("lookup", "reading"), SATURATION_MATRIX)
def test_no_saturation_reading_ever_appears_as_a_rejection_reason(lookup, reading):
    _, body = _fire(_phase(lookup=lookup, reading=reading))

    joined = " ".join(r["reason"] for r in body["rejections"]).lower()
    for word in ("peaked", "exploding topics", "gdelt", "saturation", "breadth"):
        assert word not in joined


# --- AC4: the floor, and only the floor -----------------------------------


def test_a_too_young_subject_is_skipped_and_writes_no_row():
    young = [_row("s1", hours_ago=2), _row("s2", hours_ago=6), _row("s3", hours_ago=71)]

    snowflake, body = _fire(_phase(lookup=EXPLODING, reading=NARROW), rows=young)

    assert set(_landed(snowflake)) == {"cottage cheese"}
    assert body["predictions_written"] == 1
    reasons = [r["reason"] for r in body["rejections"] if r["subject"] == "rucking vests"]
    assert reasons and "too young" in reasons[0]


def test_a_too_sparse_subject_is_skipped_and_writes_no_row():
    thin = [
        _row("s1", text="rucking | rising"),
        _row("s2", text="vest | breakout"),
        _row("s3"),
    ]
    # Titles alone would clear 120 chars, so make the thin rows thin outright.
    for row in thin[:2]:
        row["SIGNAL_TITLE"] = "rucking vest"

    snowflake, body = _fire(_phase(lookup=EXPLODING, reading=NARROW), rows=thin)

    assert set(_landed(snowflake)) == {"cottage cheese"}
    reasons = [r["reason"] for r in body["rejections"] if r["subject"] == "rucking vests"]
    assert reasons and "too sparse" in reasons[0]


def test_a_skipped_subject_is_never_looked_up_at_all():
    # "No verdict is REQUESTED": the floor runs before the oracles, so a
    # skipped subject costs neither an ET call nor a GDELT call.
    young = [_row("s1", hours_ago=2), _row("s2", hours_ago=6), _row("s3", hours_ago=71)]
    oracle = StaticSaturationOracle()
    breadth = StaticBreadthReader()

    _fire(SaturationPhase(oracle=oracle, breadth=breadth), rows=young)

    assert oracle.queries == ["cottage cheese"]
    assert breadth.queries == ["cottage cheese"]


@pytest.mark.parametrize(("lookup", "reading"), SATURATION_MATRIX)
def test_with_the_floor_relaxed_every_candidate_lands_under_every_reading(lookup, reading):
    # The complement of AC4 and the closing argument for AC5: drop the ONE
    # gate to zero and nothing else in the path removes anything, whatever
    # the oracles said.
    thin_and_young = [
        _row("s1", hours_ago=1, text="rucking | rising"),
        _row("s2", hours_ago=1, text="vest | breakout"),
        _row("s3", hours_ago=1, text="cottage | rising"),
    ]
    open_floor = DataQualityFloor(min_observation_age_hours=0, min_evidence_chars=0)

    snowflake, body = _fire(
        _phase(lookup=lookup, reading=reading, floor=open_floor), rows=thin_and_young
    )

    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    assert body["rejections"] == []


def test_a_floored_subject_still_counts_as_proposed():
    # `predictions_proposed` is what the model proposed, counted before the
    # floor runs -- a run that proposed 2 and floored 1 reports 2 proposed and
    # 1 written, with the floor's skip in `rejections`. Counting it after the
    # floor made the field report a number nothing had ever proposed.
    young = [_row("s1", hours_ago=2), _row("s2", hours_ago=6), _row("s3", hours_ago=71)]

    _, body = _fire(_phase(lookup=EXPLODING, reading=NARROW), rows=young)

    assert body["predictions_proposed"] == 2
    assert body["predictions_written"] == 1
    assert [r["subject"] for r in body["rejections"]] == ["rucking vests"]


def test_the_floor_is_the_only_reason_this_phase_ever_drops_a_row():
    # Every rejection a run can produce, enumerated. Generation's own
    # structural rejections (parse.py) and the run's cap are the others; this
    # asserts the saturation phase adds exactly one kind and no more.
    young = [_row("s1", hours_ago=1), _row("s2", hours_ago=1), _row("s3", hours_ago=1)]

    _, body = _fire(_phase(lookup=PEAKED, reading=BROAD), rows=young)

    assert body["predictions_written"] == 0
    assert {r["subject"] for r in body["rejections"]} == {"rucking vests", "cottage cheese"}
    for rejection in body["rejections"]:
        assert "to judge" in rejection["reason"]
        assert "data-quality floor" in rejection["reason"]


# --- degradation: an outage is a miss, never a failed run ------------------


def test_a_failed_weighing_turn_still_writes_every_row_at_generations_numbers():
    # The weighing turn is the only way saturation moves a verdict, so its
    # failure has to leave the verdict exactly where generation left it --
    # writing rows with full saturation evidence and unadjusted confidence.
    # The alternative (code choosing a number) is the mechanical discount the
    # strategy forbids; the other alternative (failing the run) throws away
    # verdicts over an optional second opinion.
    snowflake, body = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply="not json")

    assert body["predictions_written"] == 2
    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    weighing = _saturation(_writes(snowflake)[0])["weighing"]
    assert weighing["weighed"] is False
    assert "unadjusted" in weighing["note"]
    # The evidence still carries what the oracles said.
    assert _saturation(_writes(snowflake)[0])["exploding_topics"]["classification"] == "peaked"


def test_a_renumbered_weighing_reply_never_swaps_two_subjects_numbers():
    # The mislabelling the subject binding exists to stop, at the seam that
    # matters: the ledger. The model re-sorted its entries by its new
    # confidence and renumbered them 1..n -- ordinary behaviour when asked to
    # restate a list. Read back by position, 'rucking vests' would be written
    # with cottage cheese's confidence and a REASONING paragraph naming
    # cottage cheese's classification: every row written, nothing dropped,
    # unfixable downstream and invisible in the response.
    renumbered = json.dumps(
        {
            "weighings": [
                {
                    "id": 1,
                    "subject": "cottage cheese",
                    "confidence": 91,
                    "reasoning": "cottage cheese is exploding, and I am surer of it",
                },
                {
                    "id": 2,
                    "subject": "rucking vests",
                    "confidence": 12,
                    "reasoning": "rucking vests has peaked and I have lost faith",
                },
            ]
        }
    )
    snowflake, body = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply=renumbered)

    # Neither entry binds, so both rows keep generation's own number and
    # reasoning. A skip is not a gate -- every row still lands.
    assert body["predictions_written"] == 2
    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    written = {w["subject_descriptor"]: w["reasoning"] for w in _writes(snowflake)}
    assert "cottage cheese" not in written["rucking vests"]
    assert "rucking vests" not in written["cottage cheese"]


class _FakeClock:
    """Monotonic seconds a test drives by hand -- no sleeping."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class _StallingOracle:
    """An Exploding Topics that burns wall-clock instead of answering -- the
    shape a provider takes when it starts timing out rather than 403ing."""

    def __init__(self, clock: _FakeClock, seconds: float) -> None:
        self._clock = clock
        self._seconds = seconds
        self.queries: list[str] = []

    def classify(self, query: str) -> SaturationLookup:
        self.queries.append(query)
        self._clock.now += self._seconds
        return SaturationLookup(query=query, matched=False, miss_reason=MISS_NOT_IN_CATALOG)


def test_a_spent_lookup_budget_is_an_explicit_miss_and_still_writes_every_row():
    # The failure the budget exists for: the lookups are sequential and
    # max_predictions goes to 25, so a stalling provider could otherwise spend
    # the whole Cloud Run request AFTER generation had run and been paid for,
    # and leave zero rows in the ledger. Past the budget a subject carries
    # "we did not get to look" -- the same penalty-free state an outage
    # produces -- and its row lands at generation's own confidence.
    clock = _FakeClock()
    oracle = _StallingOracle(clock, seconds=12.0)
    phase = SaturationPhase(
        oracle=oracle,
        breadth=StaticBreadthReader(),
        lookup_budget_s=10.0,
        clock=clock,
    )

    snowflake, body = _fire(phase)

    assert body["predictions_written"] == 2
    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    # The first subject was looked up; the budget was gone before the second.
    assert oracle.queries == ["rucking vests"]
    skipped = _saturation(
        next(w for w in _writes(snowflake) if w["subject_descriptor"] == "cottage cheese")
    )
    assert skipped["exploding_topics"]["error"] == ERROR_DEADLINE_EXCEEDED
    assert skipped["exploding_topics"]["miss_carries_no_penalty"] is True
    assert skipped["gdelt"]["available"] is False
    assert skipped["gdelt"]["error"] == ERROR_DEADLINE_EXCEEDED


class _ExplodingPhase:
    """A saturation phase that violates its own no-raise invariant."""

    def weigh(self, result, *, llm, now=None):
        raise RecursionError("maximum recursion depth exceeded")


def test_a_saturation_phase_that_raises_costs_the_run_its_evidence_not_its_rows():
    # `weigh` is built not to raise, but that is an unenforced invariant
    # guarding an expensive, already-completed generation pass. Anything
    # uncaught -- a pathological JSON body, a third-party oracle ignoring the
    # Protocol's no-raise contract, a future edit -- must not turn a paid-for
    # run into a 500 with nothing written.
    snowflake = FakeSnowflake(rows=list(SETTLED_CORPUS))
    client = _client(snowflake, FakePredictionLLM(reply=REPLY), _ExplodingPhase())

    response = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["predictions_written"] == 2
    assert _landed(snowflake) == {"rucking vests": 68.0, "cottage cheese": 54.0}
    # The rows land without saturation evidence -- the key stays as generation
    # left it, present and null, which is the contract.
    assert json.loads(_writes(snowflake)[0]["evidence"])["saturation"] is None


def test_a_run_reports_both_turns_of_token_usage():
    _, body = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply='{"weighings": []}')

    # The fake bills 1200/300 per call and the run makes two: generation and
    # the weighing turn. Reporting one turn would understate what it spent.
    assert body["llm_token_usage"] == {"input": 2400, "output": 600, "total": 3000}


def test_the_weighing_block_says_it_is_a_batch_and_how_big():
    # ONE call weighs the whole run, and its provenance block is copied onto
    # every verdict it covered. Anyone summing the cost across ledger rows
    # would over-count by the batch size, so the row says so in its own field
    # names -- and the run-level total adds it exactly once.
    snowflake, body = _fire(
        _phase(lookup=PEAKED, reading=BROAD), weighing_reply='{"weighings": []}'
    )

    blocks = [_saturation(w)["weighing"] for w in _writes(snowflake)]
    assert [b["batch_size"] for b in blocks] == [2, 2]
    assert {b["batch_cost_usd"] for b in blocks} == {blocks[0]["batch_cost_usd"]}
    # The response's total counts that one call once, not once per row.
    assert body["llm_token_usage"]["input"] == 2400


def test_a_failed_weighing_turn_does_not_unprice_the_generation_turn():
    _, body = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply="not json")

    assert body["llm_token_usage"] == {"input": 1200, "output": 300, "total": 1500}
    assert body["llm_cost_estimate"] > 0


def test_an_unwired_service_records_which_oracle_was_not_consulted():
    # create_app without a saturation phase gets SaturationPhase.offline():
    # no outbound call, and both misses named in the evidence, so a row
    # written by an unwired revision reads as one.
    snowflake = FakeSnowflake(rows=list(SETTLED_CORPUS))
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    client = TestClient(
        create_app(
            settings=settings,
            snowflake=snowflake,
            verify_token=_verify_ok,
            llm=FakePredictionLLM(reply=REPLY),
        )
    )

    body = client.post("/generate", json={}, headers=AUTH_HEADERS).json()

    assert body["predictions_written"] == 2
    saturation = _saturation(_writes(snowflake)[0])
    assert saturation["exploding_topics"]["miss_reason"] == "not_configured"
    assert saturation["gdelt"]["available"] is False


def test_the_model_may_raise_confidence_on_a_peaked_reading_and_code_allows_it():
    # The sharpest form of "argues against is an argument, not a rule": ET
    # says peaked, GDELT says broad, and the model raises its number anyway.
    # If any ceiling, cap or peaked-aware clamp existed, this is where it
    # would show.
    restated = json.dumps(
        {
            "weighings": [
                {
                    "id": 1,
                    "subject": "rucking vests",
                    "confidence": 99.9,
                    "reasoning": "peaked, and I am more sure",
                },
                {
                    "id": 2,
                    "subject": "cottage cheese",
                    "confidence": 0,
                    "reasoning": "and I have lost all faith in this one",
                },
            ]
        }
    )
    snowflake, _ = _fire(_phase(lookup=PEAKED, reading=BROAD), weighing_reply=restated)

    assert _landed(snowflake) == {"rucking vests": 99.9, "cottage cheese": 0.0}
