"""The match decision -- pure, deterministic, no I/O, no model (CRMA-764).

The PRD's sentence is the whole specification: "Each open prediction is
compared against current trends via the descriptor vocabulary and
embeddings." Two legs, in that order of authority:

1. **Descriptor vocabulary** (ADR-0003). A trend whose current
   ``descriptor.query`` names the same subject as the prediction's
   ``SUBJECT_DESCRIPTOR`` *is* that trend -- both strings are authored under
   the same rule (an atomic, consumer-vernacular noun), by design, so an
   agreement between them is an identity, not a resemblance. Decided by
   ``matching.subject.same_subject``: exact after folding case, punctuation,
   accents and plurals. No threshold exists to tune.

2. **Embeddings.** Where no descriptor agrees -- and ~40% of promoted trends
   have no descriptor at all, since ADR-0003's migration was active-only --
   the subject is compared in the trend-vector space and the closest trend
   wins if it clears ``min_similarity``.

What decides nothing here: heat, acceleration, cumulative growth, age,
lifecycle status. Those are read *after* a match is settled, as context for
the verdict's reasoning. The signature below is the structural half of that
guarantee -- ``decide_match`` has no parameter through which a TrendContext
could enter.

**On the one threshold that does exist.** ``min_similarity`` is the match
mechanic, not a gate on predictions: no prediction is ever dropped by it.
A subject that clears it becomes a matched prediction; a subject that does
not becomes a white-space prediction. Both are written. The strategy's
§10.4 ban is on rules that *exclude*, and this excludes nothing.

Its value comes from a measurement, not a preference. Probed on 2026-08-21
against the 491 live trends with the five subjects then open in the ledger:
"air-dry clay" scored 0.6162 against the trend it genuinely is (next
neighbour 0.3436), while "probiotic nasal spray" scored 0.5699 against
"probiotic intimate sprays and washes" -- a different subject sharing a
word. 0.60 sits in that gap. It is a per-request parameter (routes/match.py)
so re-tuning it against a wider sample is a request body, not a deploy.
"""

from __future__ import annotations

from dataclasses import dataclass

from .subject import same_subject
from .trends import TrendCandidate

#: Cosine floor for the embedding leg. See the module docstring for the
#: measurement behind the number.
DEFAULT_MIN_SIMILARITY = 0.60

#: How a match was reached. Recorded in EVIDENCE so a ledger reader can tell
#: an identity from a resemblance without re-running anything.
MATCH_DESCRIPTOR = "descriptor_vocabulary"
MATCH_EMBEDDING = "embedding"


@dataclass(frozen=True)
class MatchDecision:
    """Whether this prediction corroborates an existing trend, and on what
    grounds. ``trend is None`` is a white-space prediction -- a real outcome,
    not a failure."""

    trend: TrendCandidate | None
    method: str | None
    #: The runners-up the embedding leg saw, best-first. Kept in EVIDENCE so
    #: a match that later looks wrong can be re-argued from the row.
    considered: tuple[TrendCandidate, ...] = ()
    min_similarity: float = DEFAULT_MIN_SIMILARITY

    @property
    def matched(self) -> bool:
        return self.trend is not None

    @property
    def trend_id(self) -> str | None:
        return self.trend.trend_id if self.trend else None


def _rank_key(candidate: TrendCandidate) -> tuple[float, str]:
    """Best first, and total: two trends at the same similarity resolve by
    TREND_ID so a re-run of the same data reaches the same trend."""
    return (-(candidate.similarity or 0.0), candidate.trend_id)


def decide_match(
    subject: str,
    *,
    descriptor_index: list[TrendCandidate],
    candidates: list[TrendCandidate],
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
    considered_limit: int = 5,
) -> MatchDecision:
    """Resolve ``subject`` to a trend, or to white space.

    ``descriptor_index`` is every trend carrying a descriptor; ``candidates``
    is the cosine-ranked window for this subject. The two overlap, and a
    trend found by both is reported once, under the descriptor method --
    the stronger claim.
    """
    ranked = sorted(candidates, key=_rank_key)
    considered = tuple(ranked[: max(0, considered_limit)])

    # Leg 1. Searched over the whole index rather than the cosine window: a
    # trend whose descriptor already reads as this subject must not be missed
    # because its vector happened to rank eleventh.
    by_descriptor = [
        trend
        for trend in descriptor_index
        if trend.descriptor_query and same_subject(subject, trend.descriptor_query)
    ]
    if by_descriptor:
        # Similarity is not what chose it, but a descriptor hit that also
        # appears in the cosine window should report the number it scored.
        similarity_by_id = {
            trend.trend_id: trend.similarity for trend in ranked if trend.similarity is not None
        }
        enriched = [
            trend
            if trend.similarity is not None
            else TrendCandidate(
                trend_id=trend.trend_id,
                trend_topic=trend.trend_topic,
                descriptor_query=trend.descriptor_query,
                descriptor_statement=trend.descriptor_statement,
                similarity=similarity_by_id.get(trend.trend_id),
            )
            for trend in by_descriptor
        ]
        best = sorted(enriched, key=_rank_key)[0]
        return MatchDecision(
            trend=best,
            method=MATCH_DESCRIPTOR,
            considered=considered,
            min_similarity=min_similarity,
        )

    # Leg 2.
    for candidate in ranked:
        if candidate.similarity is not None and candidate.similarity >= min_similarity:
            return MatchDecision(
                trend=candidate,
                method=MATCH_EMBEDDING,
                considered=considered,
                min_similarity=min_similarity,
            )

    return MatchDecision(
        trend=None, method=None, considered=considered, min_similarity=min_similarity
    )


def match_evidence(decision: MatchDecision) -> dict[str, object]:
    """The provenance block recorded at ``EVIDENCE.match``.

    Not one of the four contracted keys (domain/claim.REQUIRED_EVIDENCE_KEYS)
    -- readable context, per the strategy's "filterable facts are columns,
    readable context is JSON". The filterable fact is MATCHED_TREND_ID, and
    that is a column.
    """
    return {
        "phase": "match",
        "method": decision.method,
        "matched_trend_id": decision.trend_id,
        "similarity": decision.trend.similarity if decision.trend else None,
        "min_similarity": decision.min_similarity,
        "considered": [
            {
                "trend_id": candidate.trend_id,
                "trend_topic": candidate.trend_topic,
                "descriptor_query": candidate.descriptor_query,
                "similarity": candidate.similarity,
            }
            for candidate in decision.considered
        ],
    }
