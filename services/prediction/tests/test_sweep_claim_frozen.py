"""The minted claim is byte-identical across every row of a PREDICTION_ID
(CRMA-766 AC2).

    "Re-evaluating an ACTIVE prediction appends a row -- the minted claim
    columns are byte-identical across all its rows."

This is the acceptance criterion the pillar is worthless without. The four
claim columns are what make a prediction falsifiable; a claim that can be
reworded, or a HORIZON_AT that can slide forward, is a claim nobody can ever
be wrong about. Snowflake has no cross-row CHECK, so this is the writing
service's contract and this file is where it is held.

The strongest form of the assertion is the one used here: drive several
successive evaluations through the real sweep against a ledger that actually
appends, then read the rows back **as bound parameters** -- the exact values
handed to the connector -- and compare them byte for byte. Not "the object
still has the same claim": the bytes that reach the column.

The pressure applied on the way:

* the model is asked repeatedly, and each time it tries to reword the claim,
  move the horizon, and rename the subject. It has no field to do it in, and
  these tests prove the wording it offers is discarded.
* the status changes under the prediction (ACTIVE -> EXPIRED -> RESOLVED),
  because a status transition is the moment a re-derivation would be most
  tempting.
* the horizon is crossed, so a HORIZON_AT re-derived from "now" would be
  visibly different rather than coincidentally equal.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from prediction_service.domain.ledger import insert_params
from prediction_service.matching.predictions import (
    LIVE_STATUSES,
    StaticOpenPredictionReader,
)
from prediction_service.matching.trends import TrendCandidate
from prediction_service.sweep import SweepScope, sweep_predictions

from .matching_fakes import DESCRIPTOR_ROWS, RecordingTrendReader, open_prediction_row

CLAIM_COLUMNS = (
    "subject_descriptor",
    "directional_claim",
    "horizon_at",
    "observable_check",
)

PREDICTION_ID = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
HORIZON = datetime(2027, 2, 14, tzinfo=UTC)
BAND_DAYS = 180  # emerging_3_6mo


def _trends() -> RecordingTrendReader:
    return RecordingTrendReader(
        descriptors=[TrendCandidate.from_row(row) for row in DESCRIPTOR_ROWS],
        candidates={},
    )


#: A model that tries, every single time, to move the claim.
_MEDDLING_REPLY = json.dumps(
    {
        "reevaluations": [
            {
                "id": 1,
                "prediction_id": "814a38cb-3935-4ce2-b640-b3154bfa84f4",
                "subject": "rucking vests",
                # Every one of these is an attempt to move a frozen part.
                "subject_descriptor": "weighted vests",
                "directional_claim": "actually I meant something narrower now",
                "observable_check": "let us grade this on vibes instead",
                "horizon_at": "2029-01-01T00:00:00+00:00",
                "horizon_band": "longer_range_12_24mo",
                "observable_check_outcome": "not_yet",
                "confidence": 71.0,
                "reasoning": "restated reasoning",
                "what_changed": "the model would like a different claim",
            }
        ]
    }
)


class _MeddlingLLM:
    model = "fake-model"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def complete(self, *, system: str, user: str):
        from prediction_service.generation.llm import LLMResponse

        self.calls.append((system, user))
        return LLMResponse(
            text=_MEDDLING_REPLY,
            model=self.model,
            input_tokens=10,
            output_tokens=10,
            cost_usd=0.0,
        )


def _evaluate(row: dict, *, now: datetime) -> dict:
    """One sweep evaluation of ``row``; returns the bound parameters of the
    single verdict it produced."""
    result = sweep_predictions(
        predictions=StaticOpenPredictionReader([row], statuses=LIVE_STATUSES),
        trends=_trends(),
        llm=_MeddlingLLM(),
        saturation=None,
        scope=SweepScope(),
        now=now,
    )
    assert len(result.outcomes) == 1, result.skipped
    return insert_params(result.outcomes[0].verdict)


def _next_row(previous: dict, bound: dict) -> dict:
    """The ledger row this evaluation appended, in the shape the next read
    hands back."""
    row = dict(previous)
    row.update(
        {
            "PREDICTION_EVAL_ID": bound["prediction_eval_id"],
            "SUBJECT_DESCRIPTOR": bound["subject_descriptor"],
            "DIRECTIONAL_CLAIM": bound["directional_claim"],
            "HORIZON_AT": bound["horizon_at"],
            "OBSERVABLE_CHECK": bound["observable_check"],
            "HORIZON_BAND": bound["horizon_band"],
            "CONFIDENCE": bound["confidence"],
            "PREDICTION_STATUS": bound["status"],
            "MATCHED_TREND_ID": bound["matched_trend_id"],
            "EVIDENCE": bound["evidence"],
            "REASONING": bound["reasoning"],
            "EVALUATED_AT": bound["evaluated_at"],
        }
    )
    return row


def test_the_claim_columns_are_byte_identical_across_every_evaluation():
    row = open_prediction_row(prediction_id=PREDICTION_ID)
    # The first row's claim, as the ledger holds it.
    minted = {
        "subject_descriptor": row["SUBJECT_DESCRIPTOR"],
        "directional_claim": row["DIRECTIONAL_CLAIM"],
        "observable_check": row["OBSERVABLE_CHECK"],
    }

    # Six evaluations across nearly two years: before the horizon, at it,
    # inside the grace window, and past it.
    moments = [
        HORIZON - timedelta(days=120),
        HORIZON - timedelta(days=30),
        HORIZON - timedelta(seconds=1),
        HORIZON,
        HORIZON + timedelta(days=BAND_DAYS // 2),
        HORIZON + timedelta(days=BAND_DAYS - 1),
    ]

    rows: list[dict] = []
    for moment in moments:
        bound = _evaluate(row, now=moment)
        rows.append(bound)
        row = _next_row(row, bound)

    assert len(rows) == len(moments)
    # Every row is a distinct evaluation of the SAME prediction...
    assert {r["prediction_id"] for r in rows} == {PREDICTION_ID}
    assert len({r["prediction_eval_id"] for r in rows}) == len(rows)
    # ...and the four claim columns never move, byte for byte.
    for column in CLAIM_COLUMNS:
        values = [r[column] for r in rows]
        assert len(set(values)) == 1, f"{column} moved across evaluations: {values}"
    for column, expected in minted.items():
        assert rows[0][column] == expected
        assert all(r[column] == expected for r in rows)
    # HORIZON_AT specifically: the same instant, not merely the same date.
    assert all(r["horizon_at"] == HORIZON for r in rows)
    # And the band, which the grace window is derived from, is frozen too.
    assert len({r["horizon_band"] for r in rows}) == 1

    # The pressure actually applied: the statuses did move under it.
    assert [r["status"] for r in rows] == [
        "ACTIVE",
        "ACTIVE",
        "ACTIVE",
        "EXPIRED",
        "EXPIRED",
        "EXPIRED",
    ]


def test_a_re_evaluation_never_re_derives_horizon_at_from_the_evaluation_time():
    # The failure this guards against is silent: derive HORIZON_AT from
    # `now` at each evaluation and the judging date walks forward forever,
    # so the claim is never due. Evaluating a year after the mint would move
    # it by a year.
    row = open_prediction_row(prediction_id=PREDICTION_ID)
    late = HORIZON - timedelta(days=1)
    bound = _evaluate(row, now=late)
    assert bound["horizon_at"] == HORIZON
    # Not "now plus a band", which is what a re-derivation would produce.
    assert bound["horizon_at"] != late + timedelta(days=BAND_DAYS)


def test_the_model_cannot_reword_the_claim_however_hard_it_tries():
    row = open_prediction_row(prediction_id=PREDICTION_ID)
    bound = _evaluate(row, now=HORIZON - timedelta(days=10))

    # The reply asked for all four to move. None did.
    assert bound["subject_descriptor"] == "rucking vests"
    assert bound["subject_descriptor"] != "weighted vests"
    assert bound["directional_claim"] == row["DIRECTIONAL_CLAIM"]
    assert bound["observable_check"] == row["OBSERVABLE_CHECK"]
    assert bound["horizon_at"] == HORIZON
    # What it WAS allowed to move, moved.
    assert bound["confidence"] == 71.0
    assert bound["reasoning"] == "restated reasoning"


def test_the_re_evaluation_prompt_tells_the_model_the_claim_is_frozen():
    # Belt as well as braces: the parser has no field for a claim part, and
    # the prompt says so out loud, so a model is not being invited to write
    # something that is silently thrown away.
    from prediction_service.sweep.prompt import build_system_prompt

    prompt = build_system_prompt()
    assert "THE CLAIM IS FROZEN" in prompt
    assert "DO NOT REWRITE IT" in prompt


def test_the_parser_has_no_field_a_claim_part_could_arrive_in():
    from dataclasses import fields

    from prediction_service.sweep.parse import Reevaluation

    names = {f.name for f in fields(Reevaluation)}
    # An exact set, so that adding a field to the sweep's parser is a
    # deliberate act reviewed against the frozen-claim rule rather than a
    # quiet widening. `angle` and `audience_question` (CRMA-782) were added
    # under that review: both are strategist-facing narrative ABOUT the
    # call, neither is a claim part, and neither is read by anything that
    # grades one. The `forbidden` assertion below is the rule itself.
    assert names == {
        "confidence",
        "reasoning",
        "what_changed",
        "observation",
        "angle",
        "audience_question",
    }
    forbidden = (
        "subject",
        "subject_descriptor",
        "directional_claim",
        "horizon_at",
        "horizon_band",
        "observable_check",
    )
    assert not names & set(forbidden)
