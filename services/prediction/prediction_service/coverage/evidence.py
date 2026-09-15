"""The ``EVIDENCE.coverage`` payload -- pure construction, no I/O (CRMA-767).

``coverage`` is one of the four contracted keys on the evidence VARIANT
(domain/claim.py, strategy doc §6). CRMA-763 shipped it present-and-null
because presence is the contract; this module fills it in, and it is the
*only* place a coverage detection is allowed to reach the ledger.

Two properties this module exists to hold, in the same shape
``saturation/evidence.py`` holds its two:

* **It is additive.** ``attach_coverage`` returns a new evidence dict with
  ``coverage`` set and every other key -- ``source_signals``,
  ``saturation``, ``trend_context``, the ``reevaluation`` block -- passed
  through untouched.
* **It records, and the only judgement it carries is a demotion.** Every
  field is a reading of what McClatchy published. The single decision in the
  payload is ``demoted`` / ``posture``, and it comes from
  ``posture.coverage_demotes`` -- a boolean. No field here is a score, a
  penalty, or anything a confidence could be derived from.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .detect import CoverageReading
from .posture import POSTURE_ACT, POSTURE_WATCH_COVERED, ExternalDemand, coverage_demotes

#: The evidence key this story owns. Named so the tests, the route and the
#: sweep can refer to it without a bare string, and so grepping finds every
#: writer.
COVERAGE_KEY = "coverage"

#: Said in the payload itself, so anyone reading a ledger row understands the
#: valve without having to read the strategy doc.
ONE_WAY_VALVE_NOTE = (
    "internal coverage is demote-only: it may lower this prediction's posture from "
    "'act' to 'watch_covered', and it can never raise CONFIDENCE or corroborate a "
    "trend. Only external demand re-raises a covered call."
)


def build_coverage_evidence(
    reading: CoverageReading, *, demand: ExternalDemand | None = None
) -> dict[str, Any]:
    """The whole ``EVIDENCE.coverage`` value for one verdict."""
    external = demand or ExternalDemand()
    demoted = coverage_demotes(reading, demand=external)
    return {
        "provider": "cortex_cue_content_vectors",
        "query": reading.subject,
        # "We looked" vs "we could not look" -- see CoverageReading.
        "available": reading.available,
        "detected": reading.detected,
        "miss_reason": reading.miss_reason,
        "error": reading.error,
        # Distinct stories, syndicated copies already counted once...
        "story_count": reading.story_count,
        # ...and the rows that folded into them, so the dedupe is visible
        # rather than taken on trust.
        "syndicated_rows": reading.syndicated_rows,
        "top_similarity": reading.top_similarity,
        "detections": [detection.as_evidence() for detection in reading.detections],
        # The calibration in force for THIS row, so a past detection stays
        # readable against the cutoff that produced it (AC6).
        "min_similarity": reading.min_similarity,
        "window_days": reading.window_days,
        "dedupe_rule": (
            "one detection per case- and punctuation-folded headline; SYNDICATED_COPIES "
            "counts the CUE_CONTENT_VECTORS rows that folded into it, so a story that ran "
            "on twelve McClatchy sites is one piece of coverage"
        ),
        "coverage_definition": (
            "inclusive -- commerce, wire and staff alike; the published-content pool "
            "carries no content-class column and no class is filtered out"
        ),
        # One decision, rendered two ways -- asked once, so the boolean and
        # the string can never disagree.
        "posture": POSTURE_WATCH_COVERED if demoted else POSTURE_ACT,
        "demoted": demoted,
        "external_demand": external.as_evidence(),
        "one_way_valve": ONE_WAY_VALVE_NOTE,
    }


def attach_coverage(
    evidence: Mapping[str, Any], coverage: Mapping[str, Any]
) -> dict[str, Any]:
    """``evidence`` with ``coverage`` filled in and nothing else disturbed."""
    merged = dict(evidence)
    merged[COVERAGE_KEY] = dict(coverage)
    return merged


#: What the row says when this evaluation could not look and the prior row's
#: detection was kept. Named so a test can assert on it without a bare string.
NOT_RE_READ_NOTE = (
    "coverage was not re-read at this evaluation (the detector was unavailable); the "
    "prior detection and the posture derived from it stand unchanged"
)


def carries_a_detection(coverage: Any) -> bool:
    """Whether a stored ``EVIDENCE.coverage`` value holds a real detection, as
    opposed to null or a recorded miss."""
    return isinstance(coverage, Mapping) and bool(coverage.get("detected"))


def record_coverage(
    evidence: Mapping[str, Any],
    reading: CoverageReading | None,
    *,
    demand: ExternalDemand | None = None,
) -> dict[str, Any]:
    """Build and attach in one call -- the sweep's single seam into this
    package.

    Two cases leave the prior row's ``coverage`` standing, and both are the
    same argument the sweep already makes about saturation: a row that could
    not look must not read as a row that looked and found nothing.

    * **A ``None`` reading** -- no detector was wired at all. The evidence is
      returned untouched, which for a re-evaluation means the prior payload
      is carried forward (matching/run.py already copies it).
    * **An unavailable reading over a prior detection** -- the detector was
      wired and the warehouse did not answer, or the kill switch is off. This
      is the case that matters: overwriting a real detection with a miss
      would flip ``posture`` back to ``act``, which is a re-raise that no
      external demand drove -- exactly what AC4 forbids. The prior payload is
      kept verbatim and annotated.

    Kept **verbatim**, not re-decided against this evaluation's ``demand``: a
    posture derived from a stale detection and a fresh demand reading mixes
    two moments, and the epic's rule for an unbindable reading is "keep the
    prior value", never reconcile it. The cost is bounded and stated -- a
    covered call whose detector is down stays covered even if demand rises,
    until the next pass that actually looks re-decides both halves together.
    """
    if reading is None:
        return dict(evidence)
    if not reading.available and carries_a_detection(evidence.get(COVERAGE_KEY)):
        prior = dict(evidence[COVERAGE_KEY])
        prior["note"] = NOT_RE_READ_NOTE
        prior["miss_reason"] = reading.miss_reason
        prior["error"] = reading.error
        return attach_coverage(evidence, prior)
    return attach_coverage(evidence, build_coverage_evidence(reading, demand=demand))
