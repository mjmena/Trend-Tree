"""The precedence ladder, pure (CRMA-768 AC3).

    strategist action > coverage demotion > automated evidence

The strategy doc states it in one line (7.4) and the whole of it is here, in
one function, with no I/O and no clock. Three rungs, highest first:

1. **Strategist action.** A Dismiss withdraws the call; an Approve holds it
   at ``act`` and says so, whatever the two rungs below read. There is no
   stored protection flag -- protection is simply the latest decision still
   being an Approve, so it ends the moment a human touches the call again
   (strategist/decisions.py resolves latest-per-prediction).
2. **Coverage demotion.** ``act`` -> ``watch/covered``, and only in that
   direction: internal coverage may never raise a posture (7.3's one-way
   valve). Passed in rather than read here -- see below.
3. **Automated evidence.** Whatever the pillar's own reading of the call is.
   Today that is ``act`` for a live call: the pillar has no automated demotion
   rule, and inventing one here would be a new mechanical gate, which the
   strategy does not permit.

**Why coverage is an argument.** Coverage *detection* is CRMA-767's, landing
in parallel, and this module deliberately does not read ``EVIDENCE.coverage``
-- two modules deciding what counts as a coverage demotion is how the rungs
drift apart. The ladder is complete and fully tested with the flag passed
directly; the sweep passes ``coverage_demoted=False`` until that story's pure
demotion function is available to call at the one wiring site.

**This is a posture, not a status.** Posture is queue standing -- what the
Predictions Queue should show a strategist. Status is the ledger's
``PREDICTION_STATUS``, and the only posture that moves it is ``withdrawn``,
which sweep/lifecycle.py turns into a ``WITHDRAWN`` verdict. An Approve
protects standing; it does not stop a resolution. A prediction whose
observable check comes true is RESOLVED_TRUE whether or not a human approved
it, and external saturation still removes it from the queue via a verdict --
"exit is never a separate mechanical rule" (7.7).

**Nothing here is a filter.** Every input produces a posture; no combination
drops, suppresses, or refuses a prediction. ``withdrawn`` is a human's action
recorded as a status, not a rule the system applied.
"""

from __future__ import annotations

from dataclasses import dataclass

from .decisions import StrategistDecision

#: Queue standing, in the strategy's own words (7.7): "act now" demotes to
#: "watch/covered", and demotion is not removal. ``withdrawn`` is the third
#: because a human said so -- it is the only one that leaves the queue.
POSTURE_ACT = "act"
POSTURE_WATCH_COVERED = "watch_covered"
POSTURE_WITHDRAWN = "withdrawn"

POSTURES: frozenset[str] = frozenset({POSTURE_ACT, POSTURE_WATCH_COVERED, POSTURE_WITHDRAWN})

#: Which rung of the ladder decided the posture. Recorded on every verdict so
#: AC3's "precedence is observable" is a fact in the ledger rather than a
#: property of the code.
TIER_STRATEGIST_ACTION = "strategist_action"
TIER_COVERAGE_DEMOTION = "coverage_demotion"
TIER_AUTOMATED_EVIDENCE = "automated_evidence"


@dataclass(frozen=True)
class PostureDecision:
    """The posture the ladder settled on, which rung settled it, and why."""

    posture: str
    tier: str
    #: One sentence, for WHAT_CHANGED and EVIDENCE.strategist. Names the
    #: human and the moment when a human decided it.
    reason: str
    #: True when a strategist Approve is what is holding the posture up --
    #: i.e. a lower rung asked for a demotion and did not get it.
    protected: bool = False

    def __post_init__(self) -> None:
        if self.posture not in POSTURES:
            raise ValueError(
                f"unknown posture: {self.posture!r} (expected one of {sorted(POSTURES)})"
            )

    @property
    def withdrawn(self) -> bool:
        return self.posture == POSTURE_WITHDRAWN

    @property
    def queued(self) -> bool:
        """Whether the call still has queue standing. Demotion is not
        removal, so a watch/covered call is still queued."""
        return self.posture != POSTURE_WITHDRAWN


#: What a lower rung asked for, in the sentence that says a human overruled
#: it. Named rather than spelled twice: the same two words are the tier
#: constants above, and a reason that disagrees with the tier it explains is
#: a reason nobody can check.
DEMOTED_BY_COVERAGE = "coverage"
DEMOTED_BY_AUTOMATED_EVIDENCE = "automated evidence"


def attributed_to(decision: StrategistDecision) -> str:
    """``"a strategist jsmith@mcclatchy.com"`` -- or just ``"a strategist"``
    when the source did not name one."""
    name = (decision.decided_by or "").strip()
    return f"a strategist {name}" if name else "a strategist"


def withdrawal_reason(decision: StrategistDecision) -> str:
    """Why this call is being withdrawn, in one sentence.

    Lives here rather than in sweep/lifecycle.py because the status and the
    posture are two readings of one event, and the ledger records both: the
    sentence reaches WHAT_CHANGED through ``StatusDecision.reason`` and
    ``EVIDENCE.strategist.reason`` through the posture. Written twice, the
    two would drift, and a row whose evidence disagreed with its
    WHAT_CHANGED about why a human's call was dropped is the worst place in
    the pillar to have two stories.
    """
    return (
        f"{attributed_to(decision)} dismissed this call at "
        f"{decision.decided_at.isoformat()}; the human tier outranks automation, so this "
        "verdict records WITHDRAWN, the call leaves the queue, and it is excluded from the "
        "track record"
    )


def _overruled_rung(*, coverage_demoted: bool, automated_posture: str) -> str | None:
    """Which lower rung asked for a demotion that an Approve is holding off,
    or None when neither did. Coverage first: it is the higher of the two."""
    if coverage_demoted:
        return DEMOTED_BY_COVERAGE
    if automated_posture != POSTURE_ACT:
        return DEMOTED_BY_AUTOMATED_EVIDENCE
    return None


def _approval_reason(decision: StrategistDecision, *, overruled: str | None) -> str:
    held = "the call keeps its act standing until a human touches it again"
    approved = f"{attributed_to(decision)} approved this call at {decision.decided_at.isoformat()}"
    if overruled is None:
        return f"{approved}; {held}"
    return f"{approved}, so the {overruled} demotion does not apply; {held}"


def resolve_posture(
    decision: StrategistDecision | None,
    *,
    coverage_demoted: bool = False,
    automated_posture: str = POSTURE_ACT,
) -> PostureDecision:
    """Settle the posture for one prediction at one evaluation.

    ``decision`` is the latest strategist action on this prediction, or None
    when there has been none (or when the decision source could not be read
    -- the two are the same to this function, and the evidence records which).
    ``coverage_demoted`` is CRMA-767's detection, defaulted off so the ladder
    is complete without it. ``automated_posture`` is the pillar's own reading.
    """
    if automated_posture not in POSTURES:
        raise ValueError(
            f"unknown posture: {automated_posture!r} (expected one of {sorted(POSTURES)})"
        )

    if decision is not None and decision.is_dismiss:
        return PostureDecision(
            posture=POSTURE_WITHDRAWN,
            tier=TIER_STRATEGIST_ACTION,
            reason=withdrawal_reason(decision),
        )

    if decision is not None and decision.is_approve:
        overruled = _overruled_rung(
            coverage_demoted=coverage_demoted, automated_posture=automated_posture
        )
        return PostureDecision(
            posture=POSTURE_ACT,
            tier=TIER_STRATEGIST_ACTION,
            reason=_approval_reason(decision, overruled=overruled),
            # "Protected" means a demotion was asked for and did not happen.
            # An Approve nothing argued with is a standing fact, not an
            # event, and saying so every day is churn.
            protected=overruled is not None,
        )

    if coverage_demoted:
        # The one-way valve: coverage can move a posture down and never up,
        # so a call the automated tier already reads as watch/covered stays
        # exactly where it is.
        return PostureDecision(
            posture=POSTURE_WATCH_COVERED,
            tier=TIER_COVERAGE_DEMOTION,
            reason=(
                "we have already published on this subject, so the call demotes to "
                "watch/covered; it stays on the queue, and external demand can raise it "
                "back to act"
            ),
        )

    return PostureDecision(
        posture=automated_posture,
        tier=TIER_AUTOMATED_EVIDENCE,
        reason=(
            "no strategist has acted on this call and no internal coverage was detected; "
            f"its standing is the pillar's own reading ({automated_posture})"
        ),
    )
