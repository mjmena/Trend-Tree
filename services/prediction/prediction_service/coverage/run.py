"""The coverage phase: detect, then let the verdict decide (CRMA-767).

Runs inside the re-evaluation sweep, in two halves that are deliberately far
apart:

1. **Detection** -- ``phase.readings(subjects)``, one warehouse read for the
   whole sweep, issued *before* the model turn. Deterministic SQL, no LLM
   (detect.py).
2. **Consumption** -- ``record_coverage`` on each prediction's evidence,
   *after* the model turn has returned its restated confidence. Verdict-side
   and demote-only (posture.py).

**The gap between the two halves is the AC3 guarantee.** The re-evaluation
prompt is built from ``ReevaluationItem`` (sweep/prompt.py), which has no
coverage field and never gains one; the model therefore restates confidence
having never been told whether we published. Coverage is merged into the
evidence afterwards. So "coverage cannot raise confidence" is not a rule the
prompt has to keep -- there is no path along which a detection could reach
the number.

**Nothing in this phase can drop a prediction.** A detection, an empty
result, a detector that was never wired and a warehouse outage all produce
the same set of verdicts; they differ only in what ``EVIDENCE.coverage``
says and in whether the posture reads ``watch_covered``. The pillar's one
permitted mechanical gate is CRMA-765's mint-time data-quality floor, and
this is not it.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .detect import (
    CONTENT_VECTORS_TABLE,
    CoverageDetector,
    CoverageQueryRunner,
    CoverageReading,
    SnowflakeCoverageDetector,
    StaticCoverageDetector,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..config import Settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CoveragePhase:
    """The phase's one collaborator, injected -- so every test runs offline
    and a threshold change is a construction change, not a monkeypatch."""

    detector: CoverageDetector

    @classmethod
    def offline(cls) -> CoveragePhase:
        """A phase that consults nobody: every subject is an explicit
        ``not_configured`` miss, which demotes nothing."""
        return cls(detector=StaticCoverageDetector())

    def readings(self, subjects: Sequence[str]) -> list[CoverageReading]:
        """One reading per subject, in the order given -- the public seam.

        Cannot raise: the detector swallows its own outage into a miss, and
        this catches anything left over. A coverage pass that fails costs a
        posture change; a coverage pass that raises would cost every verdict
        in the sweep, which is a far worse trade for a signal that can only
        ever demote.
        """
        try:
            return self.detector.detect(list(subjects))
        except Exception as err:  # noqa: BLE001 - see the docstring
            log.warning("coverage phase failed; every subject reads unlooked: %s", err)
            return [
                CoverageReading(
                    subject=subject,
                    available=False,
                    miss_reason="the coverage phase raised",
                    error=f"{type(err).__name__}: {err}",
                )
                for subject in subjects
            ]


def build_coverage_phase(settings: Settings, client: CoverageQueryRunner) -> CoveragePhase:
    """The deployed phase, from config and the route's own Snowflake client.

    Built in the route rather than in ``server.py`` (where the saturation
    phase is built) because this phase's only collaborator is the warehouse
    client the route already holds -- there is no key to read and no network
    call made at construction time, so nothing is gained by moving it up.
    """
    coverage = settings.coverage
    if not coverage.enabled:
        return CoveragePhase.offline()
    return CoveragePhase(
        detector=SnowflakeCoverageDetector(
            client=client,
            content_vectors=coverage.content_vectors_table or CONTENT_VECTORS_TABLE,
            min_similarity=coverage.min_similarity,
            window_days=coverage.window_days,
            min_headline_chars=coverage.min_headline_chars,
            detection_limit=coverage.detection_limit,
        )
    )
