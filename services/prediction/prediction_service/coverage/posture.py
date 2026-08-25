"""The demote-only one-way valve (CRMA-767).

This module is the whole of what internal coverage is *allowed* to do to a
prediction, and it is deliberately one boolean wide.

The strategy's rule, quoted, because every line below is a reading of it:

    "internal coverage may only demote (act -> watch/covered); it never
    raises confidence or corroborates. External demand may re-raise a
    covered prediction."

**The valve is structural, not disciplinary.** ``coverage_demotes`` returns
``True`` or ``False``. There is no third return value, no number, and no
field a caller could add a coverage reading into a confidence with. Nothing
in this package imports ``build_verdict``, touches ``Verdict.confidence``, or
produces a ``matched_trend_id`` -- so "coverage raised our confidence in this
call" is not a thing this code can express. tests/test_coverage_isolation.py
holds that as an assertion over the package's own text rather than as a
promise.

**Why the re-raise leg lives here too.** A valve that only ever demoted would
make coverage permanent: we publish once, and the call is pinned at
watch/covered for the rest of its horizon however loudly the world keeps
asking. That is user story 7's exact complaint ("real momentum is not hidden
by our own coverage"). So the demotion is *conditional on the world having
gone quiet*, and the condition is read from evidence that has never seen a
coverage detection -- see ``ExternalDemand``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .detect import CoverageReading

#: The two postures this story deals in. Strings rather than an enum for the
#: same reason sweep/direction.py's are: they are written into the evidence
#: JSON and read back out of it, and an enum member would only have to be
#: unwrapped at both ends.
#:
#: ``act`` is the posture a prediction has by default -- the queue posture the
#: PRD's Predictions Queue is made of. Nothing in this package can produce it
#: where it was not already: ``coverage_demotes`` returning False means "this
#: reading changes nothing", never "promote this".
POSTURE_ACT = "act"
#: Still visible, no longer a call to act on. The PRD's user story 6: "a
#: prediction we have already covered internally should drop to a
#: 'watch/covered' posture rather than vanish".
POSTURE_WATCH_COVERED = "watch_covered"

#: The one ``confidence_direction`` value that counts as external demand still
#: climbing. Spelled here rather than imported from ``sweep/direction.py``
#: because ``sweep`` imports this package and the reverse import would close
#: the cycle; tests/test_coverage_posture.py asserts the two strings agree.
DIRECTION_STRENGTHENED = "strengthened"


@dataclass(frozen=True)
class ExternalDemand:
    """What the world outside McClatchy did between two evaluations.

    One field carries the decision: ``confidence_direction``, the sweep's
    derived reading of how this prediction's own confidence moved
    (sweep/direction.py). It is admissible as *external* demand for a reason
    that has to hold structurally, not by intention: the model that restated
    that confidence was never shown a coverage detection. Coverage is
    attached to ``EVIDENCE`` after the re-evaluation turn has returned and is
    never rendered into a prompt (sweep/prompt.py has no coverage field), so
    a rising confidence cannot be an echo of our own publishing.

    **It is a proxy, and worth naming as one.** The strategy says "external
    demand may re-raise a covered prediction", and v1 has no first-party
    demand series wired into the pillar -- GSC and Google Trends feed the
    opportunity axis, not this one. What this reads instead is the model's
    own restatement of confidence, which is a *reading of* external evidence
    rather than a demand measurement. When a demand series is available it
    belongs here as a second field, not as a replacement for the valve.

    The default is "no reading" -- an empty direction, which is not
    ``strengthened``, so it never re-raises. A caller who has no demand
    reading gets the demotion, which is the safe half of a demote-only
    valve.
    """

    confidence_direction: str = ""
    confidence_delta: float | None = None

    @property
    def rising(self) -> bool:
        """Whether external evidence pushed this call *up* since the prior
        evaluation. Only ``strengthened`` counts: ``unchanged`` is the world
        holding steady, which is precisely the case coverage is meant to
        demote."""
        return self.confidence_direction == DIRECTION_STRENGTHENED

    def as_evidence(self) -> dict[str, Any]:
        return {
            "confidence_direction": self.confidence_direction or None,
            "confidence_delta": self.confidence_delta,
            "rising": self.rising,
            # Said in the payload so a ledger row explains its own posture
            # without the reader having to know this module.
            "source": "the prediction's own confidence movement, restated by a "
            "model that was never shown a coverage detection",
        }


def coverage_demotes(
    reading: CoverageReading | None, *, demand: ExternalDemand | None = None
) -> bool:
    """Does this coverage reading demote the prediction's posture?

    **This is the seam CRMA-768 imports.** It is pure: no I/O, no LLM, no
    clock, no warehouse. Given a reading of what McClatchy has published
    about a subject and a reading of what the world outside McClatchy did,
    it answers the only question coverage is allowed to answer -- and the
    caller owns what to do about it. CRMA-768 owns the precedence ladder
    (strategist action > coverage demotion > automated evidence); this
    function is the middle rung and knows nothing of the other two.

    ``True`` means "lower this prediction's posture from ``act`` to
    ``watch_covered``". ``False`` means "this reading changes nothing" --
    never "raise it". A caller that gets ``False`` keeps whatever posture the
    prediction already had, which is why an absent, unavailable or empty
    reading is a ``False`` rather than an error.

    The three ways to get ``False``:

    * **no reading** (``None``) -- the detector was not wired, or the run
      never got to look. Not knowing is not evidence.
    * **nothing detected** -- we looked and found no McClatchy story above
      the similarity floor. This is the ordinary case.
    * **external demand is still rising** -- we have published, and the
      world went on getting louder anyway. The strategy's re-raise leg
      (user story 7). Note what this does *not* do: it does not delete the
      detections, which stay in ``EVIDENCE.coverage`` either way. Coverage
      that was found is always recorded; what changes is whether it moves
      the posture.
    """
    if reading is None or not reading.detected:
        return False
    return not (demand or ExternalDemand()).rising


def posture_for(
    reading: CoverageReading | None, *, demand: ExternalDemand | None = None
) -> str:
    """``coverage_demotes`` as the posture string that goes in the evidence.

    A thin rendering of the same decision -- deliberately thin, so there is
    exactly one place the demote-or-not question is answered. It cannot
    return anything but the two constants above, and it can only return
    ``POSTURE_WATCH_COVERED`` when ``coverage_demotes`` said so.
    """
    return POSTURE_WATCH_COVERED if coverage_demotes(reading, demand=demand) else POSTURE_ACT
