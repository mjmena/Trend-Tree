"""Confidence direction -- derived, never stored (CRMA-766 AC5).

The PRD states it as a schema decision, not a preference:

    "Confidence-direction (strengthened/weakened) is always derived from the
    prior row, never stored."

So there is no ``CONFIDENCE_DIRECTION`` column in
``sql/fct_prediction_verdict_ledger.sql``, nothing in ``domain/ledger.py``
binds one, and this module is the only place the words strengthened and
weakened are produced. It is a pure function of two numbers.

**Why it matters that it is derived.** A stored direction is a second copy of
a fact the ledger already holds, and copies drift: a row backfilled, a row
re-MERGEd, a run that wrote confidence but not direction, and the column now
disagrees with the arithmetic anyone can do on ``CONFIDENCE``. Derived, the
disagreement is impossible -- there is one number, and the direction is a
reading of it. The same argument the strategy makes for deriving the
track-record grade in SQL rather than storing it.

**The tolerance is not a fudge factor.** ``CONFIDENCE`` is ``NUMBER(5,1)``:
the ledger stores one decimal place. Two rows differing by less than 0.05
round to the same stored value, so calling them "changed" would describe a
difference the ledger does not contain.
"""

from __future__ import annotations

#: The three readings. Strings rather than an enum because they are rendered
#: into WHAT_CHANGED text and into the sweep's JSON response, and never
#: stored anywhere.
STRENGTHENED = "strengthened"
WEAKENED = "weakened"
UNCHANGED = "unchanged"

#: No prior row: this is the prediction's first evaluation, so there is no
#: direction to read. Distinct from "unchanged", which is a comparison that
#: was made and came back level.
FIRST_EVALUATION = "first_evaluation"

#: Half of CONFIDENCE's stored precision (NUMBER(5,1)). See the module
#: docstring.
LEDGER_PRECISION_TOLERANCE = 0.05


def confidence_direction(
    prior: float | None,
    current: float,
    *,
    tolerance: float = LEDGER_PRECISION_TOLERANCE,
) -> str:
    """Which way confidence moved since the prior evaluation.

    ``prior`` is ``None`` on a first mint, which reads ``FIRST_EVALUATION``
    -- never ``UNCHANGED``, because nothing was compared.
    """
    if prior is None:
        return FIRST_EVALUATION
    delta = float(current) - float(prior)
    if abs(delta) < tolerance:
        return UNCHANGED
    return STRENGTHENED if delta > 0 else WEAKENED


def confidence_delta(prior: float | None, current: float) -> float | None:
    """The signed movement, or None when there is no prior row. Rounded to
    the ledger's own precision so the number quoted in WHAT_CHANGED is the
    number a reader can reproduce from two ledger rows."""
    if prior is None:
        return None
    return round(float(current) - float(prior), 1)
