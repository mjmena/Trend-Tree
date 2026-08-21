"""The saturation phase: floor, look up, weigh, attach (CRMA-765).

Runs after generation has returned and before anything is written, so the
whole story lives in one call the route makes:

    result = phase.weigh(result, llm=llm)

Order is deliberate and is the answer to "how much mechanism is there":

1. **The data-quality floor** (floor.py) -- the pillar's one permitted
   mechanical gate. A subject whose observation record is too young or too
   sparse to judge is skipped here, before an oracle is called and before a
   verdict is requested of the model, and it produces no ledger row.
2. **The two lookups** (lookup.py) -- Exploding Topics by subject descriptor,
   GDELT article breadth for the same string. Neither can raise; an outage is
   an explicit miss. They are also bounded in total by one wall-clock budget
   (DEFAULT_LOOKUP_BUDGET_S), so a stalling provider cannot spend the whole
   HTTP request and leave a paid-for generation pass with nothing written --
   the subjects past the budget carry a ``deadline_exceeded`` miss, which
   costs them nothing.
3. **The weighing turn** (weigh.py) -- the readings go to the model, which
   restates its own confidence and reasoning. Code copies the number across;
   it never adjusts one.
4. **Attachment** (evidence.py) -- ``EVIDENCE.saturation`` is merged into the
   evidence dict, leaving ``source_signals``, ``trend_context``, ``coverage``
   and the generation provenance block exactly as they were. A matched
   prediction and a white-space prediction are handled identically here,
   because nothing in this package reads ``matched_trend_id``.

**The only way a verdict disappears in this phase is step 1.** Steps 2-4
cannot drop a candidate and cannot change a number: a peaked classification,
a broad GDELT reading, an ET miss and a total ET outage all produce the same
set of verdicts, differing only in the evidence they carry and in whatever
the model itself decided to do about it. tests/test_saturation_no_gate.py
holds that as an exhaustive matrix rather than as a claim.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ..domain.claim import Verdict
from ..generation.llm import PredictionLLM
from ..generation.parse import Rejection
from ..generation.run import GenerationResult
from ..generation.signals import SignalRecord
from .evidence import attach_saturation, build_saturation_evidence
from .floor import DataQualityFloor, FloorAssessment, assess_floor
from .lookup import (
    ERROR_DEADLINE_EXCEEDED,
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    ArticleBreadth,
    BreadthReader,
    ExplodingTopicsOracle,
    GdeltBreadthReader,
    SaturationLookup,
    SaturationOracle,
    StaticBreadthReader,
    StaticSaturationOracle,
)
from .weigh import (
    Weighing,
    WeighingItem,
    build_weighing_system_prompt,
    build_weighing_user_prompt,
    parse_weighings,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..config import Settings

log = logging.getLogger(__name__)

#: Wall-clock seconds the two lookups may spend across the WHOLE run, not per
#: subject. Arithmetic, against the deployed request budget:
#:
#:   Cloud Run --timeout            600s  (deploy/deploy.sh)
#:   - generation turn              180s  (PREDICTION_GEMINI_TIMEOUT_S)
#:   - weighing turn                180s  (same client, same ceiling)
#:   - the verdict writes            60s  (up to max_predictions MERGEs
#:                                         through the retrying client)
#:   - corpus read + serialization   20s
#:   = 160s left, taken as 150 for margin.
#:
#: Why a budget at all: the lookups are sequential and ``max_predictions`` is
#: caller-settable to 25, so a provider that stalls instead of answering could
#: otherwise spend 25 x (ET timeout + GDELT timeout) and get the request
#: killed AFTER generation had run and been paid for, with zero rows written.
#: When the budget expires the remaining subjects get an explicit
#: ``deadline_exceeded`` miss -- the same penalty-free state an outage
#: produces -- and the run writes every row it was going to write.
DEFAULT_LOOKUP_BUDGET_S = 150.0


def corpus_index(signals: Any) -> dict[str, tuple[str | None, str]]:
    """``{signal_id: (timestamp, title + text)}`` for the floor to measure.

    Built from the corpus the model was actually shown, so the floor and the
    prompt agree about what the evidence was.
    """
    index: dict[str, tuple[str | None, str]] = {}
    for signal in signals or ():
        if not isinstance(signal, SignalRecord) or not signal.signal_id:
            continue
        text = " ".join(part for part in (signal.signal_title, signal.signal_text) if part)
        index[signal.signal_id] = (signal.signal_timestamp, text)
    return index


@dataclass(frozen=True)
class SaturationPhase:
    """The phase's collaborators, injected. Both oracles and the floor are
    arguments so every test runs offline and so a threshold change is a
    construction change, not a monkeypatch."""

    oracle: SaturationOracle
    breadth: BreadthReader
    floor: DataQualityFloor = DataQualityFloor()
    #: See DEFAULT_LOOKUP_BUDGET_S. Zero or less means "no budget", which is
    #: what the offline flavors want: their lookups cannot block.
    lookup_budget_s: float = DEFAULT_LOOKUP_BUDGET_S
    #: Monotonic seconds, injectable so a test can breach the budget without
    #: sleeping. Deliberately not the wall clock: an NTP step must not decide
    #: whether a subject gets looked up.
    clock: Callable[[], float] = field(default=time.monotonic)

    @classmethod
    def offline(cls, floor: DataQualityFloor | None = None) -> SaturationPhase:
        """A phase that consults nobody: every subject is an explicit
        ``not_configured`` Exploding Topics miss and an unavailable GDELT
        reading, and the data-quality floor still applies.

        This is what a caller who did not wire the deployed phase gets --
        tests, the local loop, and any create_app that omits ``saturation``.
        It is deliberately not a silent no-op: the two misses land in
        ``EVIDENCE.saturation`` and say which oracle was not consulted, so a
        ledger row written by an unwired service reads as one.
        """
        return cls(
            oracle=StaticSaturationOracle(default_miss_reason=MISS_NOT_CONFIGURED),
            breadth=StaticBreadthReader(default_available=False),
            floor=floor or DataQualityFloor(),
        )

    def _lookups(self, subject: str) -> tuple[SaturationLookup, ArticleBreadth]:
        return self.oracle.classify(subject), self.breadth.breadth(subject)

    def _unlooked(self, subject: str) -> tuple[SaturationLookup, ArticleBreadth]:
        """What a subject the run never got to carries. Both readings say "we
        did not look" -- which is a miss, and a miss is never a penalty."""
        return (
            SaturationLookup(
                query=subject,
                matched=False,
                miss_reason=MISS_LOOKUP_FAILED,
                error=ERROR_DEADLINE_EXCEEDED,
            ),
            ArticleBreadth(query=subject, available=False, error=ERROR_DEADLINE_EXCEEDED),
        )

    def _read_all(self, subjects: list[str]) -> list[tuple[SaturationLookup, ArticleBreadth]]:
        """Both oracles for each subject, in order, inside one wall-clock
        budget. See DEFAULT_LOOKUP_BUDGET_S for the arithmetic and for why the
        budget exists at all.

        Breaching it is not a gate: the subject still gets a verdict, a row and
        its own confidence -- it just carries "we did not get to look" instead
        of a classification, exactly as a provider outage does.
        """
        deadline = self.clock() + self.lookup_budget_s if self.lookup_budget_s > 0 else None
        readings: list[tuple[SaturationLookup, ArticleBreadth]] = []
        breached = False
        for subject in subjects:
            if deadline is not None and self.clock() >= deadline:
                if not breached:
                    breached = True
                    log.warning(
                        "saturation lookup budget spent; the rest of this run's subjects "
                        "carry an explicit %s miss and keep their own confidence",
                        ERROR_DEADLINE_EXCEEDED,
                        extra={"looked_up": len(readings), "subjects": len(subjects)},
                    )
                readings.append(self._unlooked(subject))
                continue
            readings.append(self._lookups(subject))
        return readings

    def _weighings(
        self, items: list[WeighingItem], llm: PredictionLLM | None
    ) -> tuple[dict[int, Weighing], dict[str, Any]]:
        """Ask the model to restate its calls. Returns the weighings plus the
        provenance block that goes into the evidence.

        Every failure degrades to "unweighed": the verdicts still land, still
        carry their full saturation evidence, and still carry generation's own
        confidence -- untouched, because the alternative (code choosing a
        number when the model could not) is exactly the mechanical discount
        the strategy forbids.
        """
        if llm is None:
            return {}, {"weighed": False, "note": "no model available for the weighing pass"}
        try:
            response = llm.complete(
                system=build_weighing_system_prompt(),
                user=build_weighing_user_prompt(items),
            )
            # Bound by subject, not by list position: see parse_weighings.
            weighings = parse_weighings(
                response.text, subjects=[item.subject_descriptor for item in items]
            )
        except Exception as err:  # noqa: BLE001 - an outage is a miss, not a failed run
            log.warning("saturation weighing pass failed; verdicts stay unweighed: %s", err)
            return {}, {
                "weighed": False,
                "note": f"the weighing pass failed ({type(err).__name__}); "
                "confidence and reasoning are generation's own, unadjusted",
            }
        return weighings, {
            "weighed": True,
            "model": response.model,
            # ONE batched call weighs the whole run, and this same block is
            # copied onto every verdict it covered -- so the token and cost
            # fields are named for the batch. Summing `batch_cost_usd` across
            # ledger rows over-counts by `batch_size`; the run-level total is
            # GenerationResult.cost_usd, which adds this once (see _add_cost).
            "batch_size": len(items),
            "batch_input_tokens": response.input_tokens,
            "batch_output_tokens": response.output_tokens,
            "batch_cost_usd": response.cost_usd,
        }

    def weigh(
        self,
        result: GenerationResult,
        *,
        llm: PredictionLLM | None,
        now: datetime | None = None,
    ) -> GenerationResult:
        """The phase, end to end. Returns a new ``GenerationResult``."""
        moment = now or datetime.now(UTC)
        index = corpus_index(result.corpus)

        kept: list[tuple[Verdict, FloorAssessment]] = []
        skipped: list[Rejection] = []
        for position, verdict in enumerate(result.verdicts):
            subject = verdict.claim.subject_descriptor
            cited = list(verdict.evidence.get("source_signals") or [])
            assessment = assess_floor(subject, cited, index, floor=self.floor, now=moment)
            if assessment.passes:
                kept.append((verdict, assessment))
            else:
                skipped.append(Rejection(position, assessment.reason or "", subject))

        if skipped:
            log.info(
                "data-quality floor skipped subjects",
                extra={"chain_id": result.chain_id, "skipped": len(skipped)},
            )
        if not kept:
            return replace(result, verdicts=[], rejected=[*result.rejected, *skipped])

        readings = self._read_all([v.claim.subject_descriptor for v, _ in kept])
        items = [
            WeighingItem(
                subject_descriptor=verdict.claim.subject_descriptor,
                directional_claim=verdict.claim.directional_claim,
                horizon_band=verdict.claim.horizon_band,
                observable_check=verdict.claim.observable_check,
                confidence=verdict.confidence,
                reasoning=verdict.reasoning,
                lookup=lookup,
                reading=reading,
            )
            for (verdict, _), (lookup, reading) in zip(kept, readings, strict=True)
        ]
        weighings, provenance = self._weighings(items, llm)

        weighed: list[Verdict] = []
        for position, ((verdict, assessment), (lookup, reading)) in enumerate(
            zip(kept, readings, strict=True), 1
        ):
            decision = weighings.get(position)
            block = dict(provenance)
            block["confidence_before"] = verdict.confidence
            block["confidence_after"] = (
                verdict.confidence if decision is None else decision.confidence
            )
            if decision is None and provenance.get("weighed"):
                block["note"] = (
                    "the model returned no usable restatement for this call -- absent, "
                    "malformed, or not bound to this subject; confidence and reasoning "
                    "are generation's own, unadjusted"
                )
            saturation = build_saturation_evidence(
                lookup=lookup, reading=reading, floor=assessment, weighing=block
            )
            weighed.append(
                replace(
                    verdict,
                    # The model's own number, carried across verbatim. There
                    # is no arithmetic on confidence in this package.
                    confidence=verdict.confidence if decision is None else decision.confidence,
                    reasoning=verdict.reasoning if decision is None else decision.reasoning,
                    evidence=attach_saturation(verdict.evidence, saturation),
                )
            )

        if not provenance.get("weighed"):
            # No second turn happened, so there is nothing to add. Leaving the
            # totals alone matters: folding in an absent cost would turn a
            # priced generation run into an unpriced one and read downstream
            # as "nobody priced this model".
            return replace(result, verdicts=weighed, rejected=[*result.rejected, *skipped])
        return replace(
            result,
            verdicts=weighed,
            rejected=[*result.rejected, *skipped],
            input_tokens=result.input_tokens + int(provenance.get("batch_input_tokens") or 0),
            output_tokens=result.output_tokens + int(provenance.get("batch_output_tokens") or 0),
            cost_usd=_add_cost(result.cost_usd, provenance.get("batch_cost_usd")),
        )


def _add_cost(base: float | None, extra: Any) -> float | None:
    """Both turns' costs, or unknown.

    Unknown plus anything stays unknown -- the same stance llm.py takes on an
    unpriced model. A run whose two calls it cannot both price reports null
    rather than a number that is quietly missing a turn. Only ever called for
    a weighing turn that actually happened; see the caller."""
    if base is None or extra is None:
        return None
    return round(base + float(extra), 6)


def floor_from_settings(settings: Settings) -> DataQualityFloor:
    """The data-quality floor's thresholds, from config. Split out because the
    floor is local arithmetic over the corpus and applies whether or not the
    external oracles are wired -- an offline phase still floors."""
    return DataQualityFloor(
        min_observation_age_hours=settings.saturation.min_observation_age_hours,
        min_evidence_chars=settings.saturation.min_evidence_chars,
    )


def build_saturation_phase(settings: Settings) -> SaturationPhase:
    """The deployed phase, from config. Built in server.py, alongside the
    Gemini client, and for the same reason: it is the one place in this
    service that is allowed to reach the network at construction time, so a
    caller that did not ask for it (every test, the local loop) cannot
    accidentally get an outbound HTTP call.

    With no Exploding Topics key the oracle degrades to an explicit
    ``not_configured`` miss rather than refusing to start -- the PRD lists ET
    access as "an assumption with an owner (a miss is never a penalty)", and
    the same stance config.GeminiSettings takes on a missing Gemini key
    applies here with more force: an unavailable oracle must not stop the
    pillar writing verdicts.
    """
    saturation = settings.saturation
    if saturation.exploding_topics_api_key.strip():
        oracle: SaturationOracle = ExplodingTopicsOracle(
            saturation.exploding_topics_api_key,
            timeout_s=saturation.exploding_topics_timeout_s,
        )
    else:
        oracle = StaticSaturationOracle(default_miss_reason=MISS_NOT_CONFIGURED)
    breadth: BreadthReader = (
        GdeltBreadthReader(
            window_days=saturation.gdelt_window_days, timeout_s=saturation.gdelt_timeout_s
        )
        if saturation.gdelt_enabled
        else StaticBreadthReader(default_available=False)
    )
    return SaturationPhase(
        oracle=oracle,
        breadth=breadth,
        floor=floor_from_settings(settings),
        lookup_budget_s=saturation.lookup_budget_s,
    )
