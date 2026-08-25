"""Internal-coverage detection and the demote-only one-way valve (CRMA-767).

``EVIDENCE.coverage`` -- which McClatchy stories, if any, already cover a
prediction's subject -- lands on every re-evaluation this service writes, and
it does exactly one thing to the verdict: it can lower the prediction's
posture from ``act`` to ``watch_covered``. It can never raise ``CONFIDENCE``
and it can never corroborate a trend. The strategy's line is the whole design
constraint: "internal coverage may only demote; external demand may re-raise
a covered prediction."

Public surface:

* ``CoveragePhase`` / ``build_coverage_phase`` -- the pass, and the deployed
  wiring of it.
* ``CoverageDetector`` / ``SnowflakeCoverageDetector`` /
  ``StaticCoverageDetector`` -- the one external seam, deployed and offline
  flavors, neither of which raises.
* ``CoverageReading`` / ``CoverageDetection`` -- what a detection pass found.
* ``coverage_demotes`` / ``posture_for`` / ``ExternalDemand`` -- **the pure
  valve.** ``coverage_demotes`` is the seam CRMA-768's precedence ladder
  imports: no I/O, no LLM, boolean in and out.
* ``build_coverage_evidence`` / ``attach_coverage`` / ``record_coverage`` --
  the ledger payload.
"""

from __future__ import annotations

from .detect import (
    CONTENT_VECTORS_OBJECT,
    CONTENT_VECTORS_TABLE,
    DEFAULT_DETECTION_LIMIT,
    DEFAULT_MIN_HEADLINE_CHARS,
    DEFAULT_MIN_SIMILARITY,
    DEFAULT_SUBJECT_LIMIT,
    DEFAULT_WINDOW_DAYS,
    EMBED_MODEL,
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    CoverageDetection,
    CoverageDetector,
    CoverageReading,
    SnowflakeCoverageDetector,
    StaticCoverageDetector,
    build_detection_sql,
    fold_headline,
)
from .evidence import (
    COVERAGE_KEY,
    ONE_WAY_VALVE_NOTE,
    attach_coverage,
    build_coverage_evidence,
    record_coverage,
)
from .isolation import (
    COVERAGE_FORBIDDEN_TOKENS,
    CoverageIsolationViolation,
    assert_coverage_sql,
)
from .posture import (
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    ExternalDemand,
    coverage_demotes,
    posture_for,
)
from .run import CoveragePhase, build_coverage_phase

__all__ = [
    "CONTENT_VECTORS_OBJECT",
    "CONTENT_VECTORS_TABLE",
    "COVERAGE_FORBIDDEN_TOKENS",
    "COVERAGE_KEY",
    "DEFAULT_DETECTION_LIMIT",
    "DEFAULT_MIN_HEADLINE_CHARS",
    "DEFAULT_MIN_SIMILARITY",
    "DEFAULT_SUBJECT_LIMIT",
    "DEFAULT_WINDOW_DAYS",
    "EMBED_MODEL",
    "MISS_LOOKUP_FAILED",
    "MISS_NOT_CONFIGURED",
    "ONE_WAY_VALVE_NOTE",
    "POSTURE_ACT",
    "POSTURE_WATCH_COVERED",
    "CoverageDetection",
    "CoverageDetector",
    "CoverageIsolationViolation",
    "CoveragePhase",
    "CoverageReading",
    "ExternalDemand",
    "SnowflakeCoverageDetector",
    "StaticCoverageDetector",
    "assert_coverage_sql",
    "attach_coverage",
    "build_coverage_evidence",
    "build_coverage_phase",
    "build_detection_sql",
    "coverage_demotes",
    "fold_headline",
    "posture_for",
    "record_coverage",
]
