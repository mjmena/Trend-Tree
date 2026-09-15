"""The falsifiable 4-part claim and the verdict built from it (CRMA-762,
strategy doc `docs/prediction-pillar-strategy.md` §2/§6).

Falsifiability's *real* enforcement is the ledger's NOT NULL schema
constraint (AC2) -- a claim can never be stored incomplete, full stop. What's
here is the fail-fast layer in front of that: a caller gets an actionable 400
before a warehouse round-trip, instead of a raw Snowflake error. No I/O.
"""

from __future__ import annotations

import unicodedata
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

HorizonBand = Literal[
    "near_term_1_3mo",
    "emerging_3_6mo",
    "cultural_shift_6_12mo",
    "longer_range_12_24mo",
]

PredictionStatus = Literal[
    "ACTIVE",
    "RESOLVED_TRUE",
    "RESOLVED_FALSE",
    "EXPIRED",
    "WITHDRAWN",
]

#: The ledger's status enum. Public because the re-evaluation sweep
#: (CRMA-766) reads a *set* of statuses off the ledger and has to check the
#: set it was given against the same vocabulary build_verdict enforces --
#: two copies of an enum drift, and this one is bound into SQL.
VALID_STATUSES: frozenset[str] = frozenset(
    {"ACTIVE", "RESOLVED_TRUE", "RESOLVED_FALSE", "EXPIRED", "WITHDRAWN"}
)

_VALID_STATUSES = VALID_STATUSES

# Upper bound of each controlled band (strategy doc §7.5), in days.
# HORIZON_AT is the timestamp by which the claim is due to be judged; the
# strategy's §7.6 re-checks an EXPIRED prediction for one further
# horizon-length grace window past this before the grade freezes. 30-day
# months; the strategy doc notes "band boundaries are revisable."
_HORIZON_BAND_DAYS: dict[str, int] = {
    "near_term_1_3mo": 90,
    "emerging_3_6mo": 180,
    "cultural_shift_6_12mo": 365,
    "longer_range_12_24mo": 730,
}

#: The controlled horizon vocabulary, in ascending window order. Public
#: because the generation prompt (generation/prompt.py) has to name the exact
#: strings the domain layer accepts -- a prompt listing a band this module
#: rejects would produce candidates that can never be minted.
HORIZON_BANDS: tuple[str, ...] = tuple(_HORIZON_BAND_DAYS)

# The EVIDENCE VARIANT's contracted keys (strategy doc §6) -- required to be
# *present*, even when a value is legitimately null (e.g. trend_context is
# NULL for a white-space prediction). The key's presence is the contract, not
# its value.
#
# ``strategist`` (CRMA-768) is the human tier: the latest Approve/Dismiss on
# this prediction, the posture it settled on, and which rung of the
# precedence ladder settled it. Present on every row -- including the rows
# where nobody has acted and the rows written while the decision source is
# unreachable -- because "we asked and nobody had acted" and "we could not
# ask" are different facts and the ledger has to be able to say which.
REQUIRED_EVIDENCE_KEYS = (
    "source_signals",
    "saturation",
    "trend_context",
    "coverage",
    "strategist",
)


class InvalidClaim(ValueError):
    """A claim, evidence payload, or verdict field fails a structural check."""


# Column widths from sql/fct_prediction_verdict_ledger.sql. Checked here so an
# over-long field is an actionable 400 at the edge of the service rather than
# a Snowflake "String is too long" surfacing as a 500 after a warehouse
# round-trip. Keep in sync with the DDL.
MAX_LENGTHS: dict[str, int] = {
    "prediction_id": 64,
    "prediction_eval_id": 64,
    "chain_id": 64,
    "subject_descriptor": 256,
    "directional_claim": 1024,
    "observable_check": 1024,
    "horizon_band": 32,
    "matched_trend_id": 64,
    "reasoning": 4000,
    "what_changed": 4000,
    "angle": 512,
    "audience_question": 256,
}


#: Explicit bidirectional formatting controls. They are Unicode category Cf,
#: not Cc, so a control-character check alone misses them -- and they are the
#: dangerous half: SUBJECT_DESCRIPTOR is composed into the dashboard's rendered
#: claim sentence, where a right-to-left override reverses the display of
#: everything after it. That is display spoofing on the surface a strategist
#: uses to decide whether to believe us. ZWJ/ZWNJ are also Cf and are load-
#: bearing in real scripts, so the check names these twelve rather than
#: rejecting the whole class.
_BIDI_CONTROLS: frozenset[str] = frozenset(
    "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
)


def check_printable(name: str, value: str) -> None:
    """Raise InvalidClaim if ``value`` carries a control or bidi-override
    character.

    Neither survives as meaning -- a NUL truncates in some readers, a
    right-to-left override silently reverses the rest of the rendered
    sentence -- and both reach the dashboard verbatim, since the ledger's
    VARCHAR columns store whatever they are given.
    """
    for ch in value:
        if unicodedata.category(ch) == "Cc" or ch in _BIDI_CONTROLS:
            raise InvalidClaim(
                f"{name} contains a control or bidirectional-override character "
                f"(U+{ord(ch):04X}); claim text must be plain, displayable text"
            )


def check_length(name: str, value: str | None) -> None:
    """Raise InvalidClaim if ``value`` would overflow its ledger column."""
    limit = MAX_LENGTHS[name]
    if value is not None and len(value) > limit:
        raise InvalidClaim(f"{name} exceeds its column width: {len(value)} > {limit} chars")


@dataclass(frozen=True)
class Claim:
    """The 4-part claim, frozen at mint (strategy doc §2/§6): subject,
    directional claim, horizon, observable check. ``subject_descriptor``
    follows ADR-0003's descriptor-vocabulary rule -- an atomic,
    consumer-vernacular noun, not a compound behavior or industry jargon."""

    subject_descriptor: str
    directional_claim: str
    horizon_band: HorizonBand
    observable_check: str

    def __post_init__(self) -> None:
        for name in ("subject_descriptor", "directional_claim", "observable_check"):
            value = getattr(self, name)
            if not value.strip():
                raise InvalidClaim(f"{name} must be non-empty")
            check_length(name, value)
            check_printable(name, value)
        if self.horizon_band not in _HORIZON_BAND_DAYS:
            raise InvalidClaim(
                f"unknown horizon_band: {self.horizon_band!r} "
                f"(expected one of {sorted(_HORIZON_BAND_DAYS)})"
            )


def horizon_length(band: HorizonBand) -> timedelta:
    """The band's own window.

    Public because the grace window is exactly one of these past HORIZON_AT
    (sweep/lifecycle.py): a prediction's re-check period is a property of its
    frozen band, so it is derived from the same table the horizon date came
    from rather than from any stored timestamp.
    """
    try:
        return timedelta(days=_HORIZON_BAND_DAYS[band])
    except KeyError as err:
        raise InvalidClaim(
            f"unknown horizon_band: {band!r} (expected one of {sorted(_HORIZON_BAND_DAYS)})"
        ) from err


def derive_horizon_at(band: HorizonBand, minted_at: datetime) -> datetime:
    """The real timestamp a horizon band resolves to, derived at mint (PRD:
    "HORIZON_AT is a real timestamp derived from the horizon band at mint")."""
    return minted_at + horizon_length(band)


@dataclass(frozen=True)
class Verdict:
    """One row of the verdict ledger: claim (frozen) + verdict + evidence +
    narrative, per the record envelope (strategy doc §6)."""

    prediction_id: str
    #: This row's own identity, minted here rather than left to the ledger's
    #: ``DEFAULT UUID_STRING()``. That default made the write
    #: non-idempotent: the shared Snowflake client retries a call whose
    #: response was lost, an already-committed INSERT would then land a
    #: *second* row under a fresh server-side id, and Snowflake's PRIMARY KEY
    #: is informational only, so nothing would dedupe it. A caller-supplied
    #: id lets the write be a MERGE (see domain/ledger.py) that a retry turns
    #: into a no-op.
    prediction_eval_id: str
    #: One value per run/generation pass, per the DDL's comment.
    chain_id: str | None
    claim: Claim
    horizon_at: datetime
    confidence: float
    status: PredictionStatus
    matched_trend_id: str | None
    evidence: dict[str, Any]
    reasoning: str
    what_changed: str | None
    minted_at: datetime
    #: Strategist-facing narrative (CRMA-782). Both are optional and neither
    #: is part of the claim: the 4-part claim is machine-facing by design
    #: (ADR-0003's register plus the observable check's named-source rule),
    #: which leaves nowhere for "why does this matter" to live. Every row
    #: written before CRMA-782 carries NULL in both, so they default rather
    #: than joining the required arguments.
    angle: str | None = None
    audience_question: str | None = None


def build_verdict(
    claim: Claim,
    *,
    confidence: float,
    reasoning: str,
    evidence: dict[str, Any],
    status: str = "ACTIVE",
    matched_trend_id: str | None = None,
    what_changed: str | None = None,
    prediction_id: str | None = None,
    prediction_eval_id: str | None = None,
    chain_id: str | None = None,
    minted_at: datetime | None = None,
    horizon_at: datetime | None = None,
    angle: str | None = None,
    audience_question: str | None = None,
) -> Verdict:
    """Mint a new verdict row for ``claim``. Re-evaluations of the same
    prediction call this again with the same ``prediction_id`` and the same
    ``claim`` -- the claim never moves under a PREDICTION_ID; that invariant
    is the caller's responsibility today (the generation/matching pipeline
    that would enforce it is later scope), so this only validates the shape
    of a single row.

    ``horizon_at`` exists for that re-evaluation case. HORIZON_AT is one of
    the four frozen claim columns, and deriving it from ``minted_at`` on a
    later evaluation would quietly push back the date the claim is due to be
    judged -- a frozen claim that moves. A re-evaluation passes the value the
    ledger already holds (see matching/run.py); a first mint omits it and
    gets the band's derivation.
    """
    missing = [k for k in REQUIRED_EVIDENCE_KEYS if k not in evidence]
    if missing:
        raise InvalidClaim(f"evidence missing required keys: {missing}")
    if not (0 <= confidence <= 100):
        raise InvalidClaim(f"confidence must be in [0, 100], got {confidence}")
    if status not in _VALID_STATUSES:
        raise InvalidClaim(
            f"unknown status: {status!r} (expected one of {sorted(_VALID_STATUSES)})"
        )
    if not reasoning.strip():
        raise InvalidClaim("reasoning must be non-empty")
    check_length("reasoning", reasoning)
    check_length("what_changed", what_changed)
    check_length("matched_trend_id", matched_trend_id)
    check_length("prediction_id", prediction_id)
    check_length("prediction_eval_id", prediction_eval_id)
    check_length("chain_id", chain_id)
    # Both are written to be displayed verbatim -- that is the whole point of
    # them -- so they get the check that protects a display surface: a
    # right-to-left override reverses everything after it. The card itself is
    # CRMA-769 and does not exist yet; checking at the write is what stops a
    # bad row being there waiting when it does. REASONING predates the check
    # and still gets only a length bound; these two do not inherit that gap.
    for name, narrative in (("angle", angle), ("audience_question", audience_question)):
        check_length(name, narrative)
        if narrative is not None:
            check_printable(name, narrative)

    minted = minted_at or datetime.now(UTC)
    return Verdict(
        prediction_id=prediction_id or str(uuid.uuid4()),
        prediction_eval_id=prediction_eval_id or str(uuid.uuid4()),
        chain_id=chain_id,
        claim=claim,
        horizon_at=horizon_at or derive_horizon_at(claim.horizon_band, minted),
        confidence=confidence,
        status=status,  # type: ignore[arg-type]
        matched_trend_id=matched_trend_id,
        evidence=dict(evidence),
        reasoning=reasoning,
        what_changed=what_changed,
        minted_at=minted,
        angle=angle,
        audience_question=audience_question,
    )
