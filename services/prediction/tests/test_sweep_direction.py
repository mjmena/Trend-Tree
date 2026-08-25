"""Confidence direction is derived, and nowhere stored (CRMA-766 AC5).

    "No stored direction column exists; strengthened/weakened is computed
    from the prior row's confidence delta."

Two halves, and the second is the one that can rot. The arithmetic is easy to
get right and easy to keep right. The *absence* of a column is the thing a
later change adds back by accident -- someone adds CONFIDENCE_DIRECTION to
the DDL "because the dashboard wants it", the writer starts binding it, and
now there are two copies of one fact. So the structural half is asserted
against the real files: the shipped DDL, and the parameters the service
actually binds.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from prediction_service.domain.claim import Claim, build_verdict
from prediction_service.domain.ledger import insert_params
from prediction_service.sweep.direction import (
    FIRST_EVALUATION,
    LEDGER_PRECISION_TOLERANCE,
    STRENGTHENED,
    UNCHANGED,
    WEAKENED,
    confidence_delta,
    confidence_direction,
)

DDL = Path(__file__).resolve().parents[3] / "sql" / "fct_prediction_verdict_ledger.sql"


# --- the arithmetic --------------------------------------------------------


def test_a_higher_confidence_reads_strengthened():
    assert confidence_direction(60.0, 74.0) == STRENGTHENED
    assert confidence_delta(60.0, 74.0) == 14.0


def test_a_lower_confidence_reads_weakened():
    assert confidence_direction(74.0, 60.0) == WEAKENED
    assert confidence_delta(74.0, 60.0) == -14.0


def test_no_prior_row_is_a_first_evaluation_not_an_unchanged_one():
    # "Unchanged" is the result of a comparison. A first mint had nothing to
    # compare against, and saying otherwise would put a movement claim on a
    # row that cannot have one.
    assert confidence_direction(None, 68.0) == FIRST_EVALUATION
    assert confidence_delta(None, 68.0) is None


def test_a_movement_the_ledger_cannot_store_reads_unchanged():
    # CONFIDENCE is NUMBER(5,1): both of these round to the same stored
    # value, so calling them "changed" would describe a difference the ledger
    # does not contain.
    assert confidence_direction(68.0, 68.0 + LEDGER_PRECISION_TOLERANCE / 2) == UNCHANGED
    assert confidence_direction(68.0, 68.0) == UNCHANGED
    # ...and one that IS storable is not swallowed.
    assert confidence_direction(68.0, 68.1) == STRENGTHENED


# --- the absence of a column -----------------------------------------------


def test_the_ledger_ddl_declares_no_direction_column():
    ddl = DDL.read_text().upper()
    # Any column whose name suggests a stored direction. Deliberately broad:
    # the criterion is that no such column exists, not that one particular
    # spelling of it does not.
    columns = set(re.findall(r"^\s{2}([A-Z_]+)\s+(?:VARCHAR|NUMBER|TIMESTAMP|VARIANT)", ddl, re.M))
    assert columns, "the DDL parse found no columns at all -- the regex has rotted"
    # DIRECTIONAL_CLAIM is one of the four frozen claim columns -- the
    # *direction of the claim about the world*, not the direction confidence
    # moved. Named as an exception so the check below can stay broad.
    claim_columns = {"DIRECTIONAL_CLAIM"}
    offenders = [
        column
        for column in columns - claim_columns
        if "DIRECTION" in column or "STRENGTHEN" in column or "WEAKEN" in column
        or "CONFIDENCE_DELTA" in column or "CONFIDENCE_CHANGE" in column
    ]
    assert offenders == [], (
        f"{offenders} looks like a stored confidence direction. It is derived from the "
        "prior row's CONFIDENCE (sweep/direction.py) and must not be a column -- a second "
        "copy of a fact the ledger already holds is a copy that can disagree with it."
    )


def test_the_service_binds_no_direction_parameter():
    verdict = build_verdict(
        Claim(
            subject_descriptor="rucking vests",
            directional_claim="mainstream retail adoption expands",
            horizon_band="emerging_3_6mo",
            observable_check="house-label listings at two of three mass retailers",
        ),
        confidence=74.0,
        reasoning="because",
        evidence={
            "source_signals": [],
            "saturation": None,
            "trend_context": None,
            "coverage": None,
            "strategist": None,
        },
        what_changed="Confidence strengthened from 68.0 to 74.0 (+6.0).",
        minted_at=datetime(2026, 8, 21, tzinfo=UTC),
    )
    bound = insert_params(verdict)
    # `directional_claim` is a frozen claim part, not a movement -- see above.
    assert not [
        key
        for key in bound
        if "direction" in key.lower() and key != "directional_claim"
    ]
    assert not [key for key in bound if "delta" in key.lower()]
    # The direction is readable from what IS bound -- two confidences, one
    # per row -- which is the whole argument for not storing it.
    assert "confidence" in bound


def test_the_verdict_object_carries_no_direction_field():
    from dataclasses import fields

    from prediction_service.domain.claim import Verdict

    names = {f.name for f in fields(Verdict)}
    assert not [name for name in names if "direction" in name]


@pytest.mark.parametrize(
    ("prior", "current", "expected"),
    [
        (0.0, 100.0, STRENGTHENED),
        (100.0, 0.0, WEAKENED),
        (50.0, 50.0, UNCHANGED),
        (None, 50.0, FIRST_EVALUATION),
    ],
)
def test_direction_is_a_pure_function_of_two_numbers(prior, current, expected):
    assert confidence_direction(prior, current) == expected
    # Called twice with the same inputs it gives the same answer -- no state,
    # no clock, nothing read from a row.
    assert confidence_direction(prior, current) == expected
