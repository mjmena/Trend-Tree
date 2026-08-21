"""Status transitions and the grace window (CRMA-766).

The whole of the pillar's status machine lives here, and it is pure: no
clock of its own, no I/O, no model. The sweep hands it a prior status, the
frozen claim's ``HORIZON_AT`` and horizon band, the moment being evaluated,
and what the observable check currently reads -- and gets back the status to
write and a plain sentence saying why.

**The grace window** (strategy doc §7.6, PRD "Track-record grades"):

    "EXPIRED is re-checked for one additional horizon length, then the grade
    freezes."

So a prediction has three time regions, and both boundaries come out of the
frozen claim:

    mint ......... HORIZON_AT ......... HORIZON_AT + one horizon length
         ACTIVE   |     EXPIRED,       |      EXPIRED, frozen
                  |   still re-checked |   (no further evaluations)

"One horizon length" is the band's own window -- 90 / 180 / 365 / 730 days,
``domain.claim.horizon_length`` -- not ``HORIZON_AT - EVALUATED_AT``. Two
reasons, and the second is the load-bearing one:

1. They are the same number by construction (``derive_horizon_at`` adds
   exactly the band's window to the mint moment), so nothing is lost.
2. ``HORIZON_AT`` and ``HORIZON_BAND`` are frozen claim columns, written by
   this service from aware UTC datetimes. ``EVALUATED_AT`` is not
   trustworthy on every row in the ledger: rows written before CRMA-764
   carry Snowflake's *session-local* ``CURRENT_TIMESTAMP()``, about four
   hours off UTC. A grace window derived from the band cannot be moved by
   that skew; one derived from a stored mint timestamp could be, by hours,
   silently, and only on the oldest rows.

**What ends a prediction.** A truth arriving at any point -- before the
horizon, or inside the grace window -- resolves it. That is the point of
re-checking an EXPIRED prediction at all: a claim that came true late reads
as a late truth (the Early-Late grade, CRMA-771's derivation) rather than as
silently wrong. After the grace window closes, nothing further is appended:
the last row stands, and the grade derived from it is final.

Nothing here grades. Correct / Early-Late / Incorrect is derived in SQL from
these rows (CRMA-771) and is deliberately not computed, not stored, and not
named in any column this module produces.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ..domain.claim import HorizonBand, PredictionStatus, horizon_length

#: What the observable check currently reads. Three values, because "we
#: looked and it has not happened yet" and "we could not tell" are the same
#: decision here (keep re-checking) but not the same sentence, and the
#: distinction belongs in the reading's rationale, not in the enum.
OBSERVED_MET = "met"
OBSERVED_FAILED = "failed"
OBSERVED_NOT_YET = "not_yet"

OBSERVATIONS: frozenset[str] = frozenset({OBSERVED_MET, OBSERVED_FAILED, OBSERVED_NOT_YET})

#: Statuses the sweep will never re-evaluate: the call is settled, or a human
#: withdrew it. A row in one of these is terminal by definition, not by
#: elapsed time.
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"RESOLVED_TRUE", "RESOLVED_FALSE", "WITHDRAWN"}
)


@dataclass(frozen=True)
class Observation:
    """What the observable check reads at this evaluation.

    ``outcome`` is one of the three constants above. ``rationale`` is the
    sentence that says how it was read -- it reaches ``WHAT_CHANGED``, so it
    is written for a strategist, not for a log.

    The default is deliberately ``not_yet`` with a rationale that says nobody
    looked: a sweep running without a model, or one whose model call failed,
    must not be able to resolve anything by accident. Silence resolves
    nothing.
    """

    outcome: str = OBSERVED_NOT_YET
    rationale: str = "the observable check was not read at this evaluation"

    def __post_init__(self) -> None:
        if self.outcome not in OBSERVATIONS:
            raise ValueError(
                f"unknown observation outcome: {self.outcome!r} "
                f"(expected one of {sorted(OBSERVATIONS)})"
            )

    @property
    def resolves(self) -> bool:
        return self.outcome in (OBSERVED_MET, OBSERVED_FAILED)


@dataclass(frozen=True)
class StatusDecision:
    """The status to write, whether this is the prediction's last evaluation,
    and why."""

    status: PredictionStatus
    #: True when the grace window has closed: this row is the last one this
    #: PREDICTION_ID will ever get, and the grade derived from it is final.
    final: bool
    #: One sentence, for WHAT_CHANGED. Says what moved, or that nothing did.
    reason: str
    #: When the grace window closes. Carried so callers can report it without
    #: recomputing it -- and so a test can assert the bound directly.
    grace_ends_at: datetime


def grace_ends_at(horizon_at: datetime, band: HorizonBand) -> datetime:
    """The instant an EXPIRED prediction stops being re-checked: exactly one
    further horizon length past ``HORIZON_AT``."""
    return horizon_at + horizon_length(band)


def grace_remaining(horizon_at: datetime, band: HorizonBand, now: datetime) -> timedelta:
    """How much of the grace window is left at ``now``. Negative once it has
    closed; larger than one horizon length before ``HORIZON_AT``."""
    return grace_ends_at(horizon_at, band) - now


def is_past_grace(horizon_at: datetime, band: HorizonBand, now: datetime) -> bool:
    """Whether the grace window has closed. The boundary is exclusive at the
    start (``now == HORIZON_AT`` is expired, not active) and inclusive at the
    end (``now == grace_ends_at`` is past): a prediction gets one horizon
    length of grace, not one horizon length plus an instant."""
    return now >= grace_ends_at(horizon_at, band)


def is_reevaluable(status: str, horizon_at: datetime, band: HorizonBand, now: datetime) -> bool:
    """Whether the sweep should append another row for this prediction.

    ACTIVE always is -- including an ACTIVE row whose grace window has
    already elapsed unobserved, which still earns exactly one final EXPIRED
    row so the ledger records the transition rather than leaving the last
    word as a claim that was never closed.

    EXPIRED is, until the grace window closes; after that the grade is
    frozen and appending anything would move it.
    """
    normalized = (status or "").upper()
    if normalized in TERMINAL_STATUSES:
        return False
    if normalized == "EXPIRED":
        return not is_past_grace(horizon_at, band, now)
    return normalized == "ACTIVE"


def next_status(
    *,
    prior_status: str,
    horizon_at: datetime,
    band: HorizonBand,
    now: datetime,
    observation: Observation | None = None,
) -> StatusDecision:
    """The status this evaluation writes.

    Precedence, highest first:

    1. **A settled observable check resolves the prediction**, whenever it
       arrives -- before the horizon or inside the grace window. AC4's
       "a truth arriving in that window flips it to RESOLVED_TRUE" is this
       clause, and it is the reason EXPIRED is re-checked at all.
    2. **Time.** Past ``HORIZON_AT`` the prediction is EXPIRED, and it stays
       EXPIRED (and re-checked) until the grace window closes.
    3. Otherwise it stays ACTIVE.

    A terminal prior status is returned unchanged and marked final: the sweep
    does not select those, and if one reaches here it is not this pass's job
    to reopen it.
    """
    reading = observation or Observation()
    prior = (prior_status or "ACTIVE").upper()
    closes_at = grace_ends_at(horizon_at, band)

    if prior in TERMINAL_STATUSES:
        return StatusDecision(
            status=prior,  # type: ignore[arg-type]
            final=True,
            reason=f"already settled as {prior}; this evaluation changes nothing",
            grace_ends_at=closes_at,
        )

    if reading.outcome == OBSERVED_MET:
        return StatusDecision(
            status="RESOLVED_TRUE",
            final=True,
            reason=(
                "the observable check now reads TRUE"
                + (" inside the grace window" if now >= horizon_at else " before the horizon")
                + f": {reading.rationale}"
            ),
            grace_ends_at=closes_at,
        )
    if reading.outcome == OBSERVED_FAILED:
        return StatusDecision(
            status="RESOLVED_FALSE",
            final=True,
            reason=f"the observable check is settled against the claim: {reading.rationale}",
            grace_ends_at=closes_at,
        )

    if now >= closes_at:
        # The grace window has closed with nothing observed. One last row so
        # the ledger says so, then silence.
        return StatusDecision(
            status="EXPIRED",
            final=True,
            reason=(
                f"the horizon passed at {horizon_at.isoformat()} and the one-horizon grace "
                f"window closed at {closes_at.isoformat()} with the observable check "
                "unmet; this is the final evaluation"
            ),
            grace_ends_at=closes_at,
        )
    if now >= horizon_at:
        return StatusDecision(
            status="EXPIRED",
            final=False,
            reason=(
                f"the horizon passed at {horizon_at.isoformat()}; the observable check is "
                f"still unmet and will be re-checked until {closes_at.isoformat()}, one "
                "further horizon length"
            ),
            grace_ends_at=closes_at,
        )
    return StatusDecision(
        status="ACTIVE",
        final=False,
        reason=f"still open; the horizon is {horizon_at.isoformat()}",
        grace_ends_at=closes_at,
    )
