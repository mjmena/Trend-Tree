"""``EVIDENCE.strategist`` -- the human tier, written down (CRMA-768).

Named for what it builds, matching ``saturation/evidence.py``, which owns
``SATURATION_KEY`` the way this file owns ``STRATEGIST_KEY``. There is no
``strategist/run.py``: this package has no phase to run -- the ladder is
pure, the read is a seam, and the sweep is what composes them.

One contracted key on every verdict, present even when no strategist has
touched the call, because its presence is the contract
(``domain.claim.REQUIRED_EVIDENCE_KEYS``) and because "we asked and nobody
had acted" is itself a fact worth having in the ledger.

The payload is what makes AC3's *precedence is observable* true of the data
rather than of the code: every row says which rung of the ladder settled its
posture, and why, in a sentence written for a strategist. CRMA-769's
projection reads ``posture`` for queue standing; nothing reads
``decision`` back into a number.
"""

from __future__ import annotations

from typing import Any

from .decisions import DecisionLookup, StrategistDecision
from .precedence import PostureDecision

#: The EVIDENCE key this story owns. Added to REQUIRED_EVIDENCE_KEYS in
#: domain/claim.py, alongside source_signals / saturation / trend_context /
#: coverage.
STRATEGIST_KEY = "strategist"

#: Said on every row, so the ledger itself carries the rule rather than
#: relying on a reader having found the strategy doc.
PRECEDENCE_LADDER = "strategist action > coverage demotion > automated evidence"

_LABEL_NOTE = (
    "retained as a calibration label for later regression tuning "
    "(FCT_PREDICTION_STRATEGIST_LABELS); never read back at runtime and never used to "
    "adjust CONFIDENCE"
)


def strategist_evidence(
    decision: StrategistDecision | None,
    posture: PostureDecision,
    *,
    lookup: DecisionLookup | None = None,
    coverage_demoted: bool = False,
) -> dict[str, Any]:
    """The ``EVIDENCE.strategist`` payload for one verdict."""
    return {
        "decision": decision.as_evidence() if decision is not None else None,
        "posture": posture.posture,
        "precedence_tier": posture.tier,
        "precedence": PRECEDENCE_LADDER,
        "reason": posture.reason,
        "protected_from_demotion": posture.protected,
        "coverage_demoted": coverage_demoted,
        "source": (lookup or DecisionLookup()).as_evidence(),
        "calibration_label": _LABEL_NOTE if decision is not None else None,
    }
