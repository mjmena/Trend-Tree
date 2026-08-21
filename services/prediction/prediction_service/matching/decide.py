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

2. **Embeddings.** Where no descriptor agrees -- and ~42% of promoted trends
   have no descriptor at all, since ADR-0003's migration was active-only --
   the subject is compared in the arctic-embed space and the closest trend
   wins if it clears the floor that applies to it.

What decides nothing here: heat, acceleration, cumulative growth, age,
lifecycle status. Those are read *after* a match is settled, as context for
the verdict's reasoning. The signature below is the structural half of that
guarantee -- ``decide_match`` has no parameter through which a TrendContext
could enter.

**On the thresholds that do exist.** A similarity floor is the match
mechanic, not a gate on predictions: no prediction is ever dropped by one.
A subject that clears its floor becomes a matched prediction; a subject that
does not becomes a white-space prediction. Both are written. The strategy's
§10.4 ban is on rules that *exclude*, and this excludes nothing.

There are two floors because there are two comparisons, on two scales
(matching/trends.py). A candidate scored against a trend's own
``descriptor.query`` is a noun phrase against a noun phrase; a candidate
scored against TREND_VECTOR is a noun phrase against a 3-sentence statement.
``TrendCandidate.similarity_basis`` says which, and that is what picks the
floor.

**What is actually measured, and how much of it.** Two read-only probes over
the live corpus on 2026-08-21:

* *Scale.* For each of the 284 live trends carrying a descriptor, its own
  ``descriptor.query`` was scored against its own TREND_VECTOR -- the
  friendliest possible positive, the subject named verbatim. Median 0.5632,
  max 0.7898, and only 101 of 284 (36%) reach 0.60. Against 40,186 random
  cross-trend pairs the same comparison has a p99 of 0.4121. So the shipped
  0.60 sat just above the noise floor of a badly compressed scale, and the
  leg was close to inert: on the five subjects then open, its one "match"
  came from the descriptor leg, and "rucking vests" scored 0.3313 against
  "weighted vest" -- ranked *second*, behind an unrelated trend at 0.3433.
  Under the query-to-query comparison the same pair scores 0.6033 and ranks
  first.

* *Separation.* A hand-labelled set drawn from the live descriptor index --
  **10 positives and 65 hard negatives**, the negatives being the top-scoring
  cross-trend pairs under each comparison, so they are the hardest ones each
  metric produces. Query-to-query separates better: AUC 0.868 versus 0.731.
  At 0.85 it recovers 7 of 10 positives with 0 of 65 false matches; the
  statement comparison reaches 0 false matches only at 0.65, where it
  recovers 1 of 10. Hence ``DESCRIPTOR_QUERY_MIN_SIMILARITY = 0.85``. Note
  what it buys and what it does not: it catches the same-subject-plus-a-word
  family the exact descriptor fold misses ("korean skincare" /
  "korean skincare routine" 0.9214, "canned dirty soda" / "dirty soda"
  0.8858), and it still leaves "rucking vests" / "weighted vest" (0.6033) as
  white space, because no floor separates that pair from
  "magnesium sleep drink" / "magnesium sleep spray" (0.8430), which is not a
  match. Synonymy at that distance is not a cosine problem.

* *The statement floor stays at 0.60, and that number is NOT re-derived.*
  It now applies only to trends with no descriptor, and by construction those
  are exactly the trends no labelled positive can be built for -- there is no
  authored subject string to pair them with. 75 labelled examples would not
  make a floor for a population none of them belong to. It is left where it
  was, and it remains a per-request parameter (routes/match.py) so a wider
  sample can move it without a deploy. n=0 for this number; said plainly.
"""

from __future__ import annotations

from dataclasses import dataclass

from .subject import same_subject
from .trends import BASIS_DESCRIPTOR_QUERY, TrendCandidate

#: Cosine floor for the embedding leg when the score came from TREND_VECTOR
#: (the trend has no descriptor of its own to compare against). Per-request.
#: See the module docstring: this number is inherited, not measured.
DEFAULT_MIN_SIMILARITY = 0.60

#: Cosine floor for the embedding leg when the score came from the trend's own
#: ``descriptor.query``. A different comparison on a different scale, so a
#: different number: 0.868 AUC over 10 labelled positives and 65 hard
#: negatives, 7/10 recall at 0/65 false matches here. Not per-request -- a
#: request body carries the floor for the comparison it can reason about, and
#: this one is a property of the two authored vocabularies, not of a run.
DESCRIPTOR_QUERY_MIN_SIMILARITY = 0.85

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


def floor_for(candidate: TrendCandidate, *, min_similarity: float) -> float:
    """The floor that applies to this candidate's score.

    Two comparisons, two scales, two numbers -- see the module docstring.
    ``min_similarity`` is the caller's (per-request) statement-side floor;
    the descriptor-side one is a constant here.
    """
    if candidate.similarity_basis == BASIS_DESCRIPTOR_QUERY:
        return DESCRIPTOR_QUERY_MIN_SIMILARITY
    return min_similarity


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

    # Leg 2. Ranked by raw score, but cleared against the floor for the scale
    # the score is on -- a candidate scored on one basis is never admitted by
    # the other's number.
    for candidate in ranked:
        if candidate.similarity is not None and candidate.similarity >= floor_for(
            candidate, min_similarity=min_similarity
        ):
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
        "similarity_basis": (
            decision.trend.similarity_basis if decision.trend else None
        ),
        "min_similarity": decision.min_similarity,
        "min_similarity_applied": (
            floor_for(decision.trend, min_similarity=decision.min_similarity)
            if decision.trend
            else None
        ),
        "considered": [
            {
                "trend_id": candidate.trend_id,
                "trend_topic": candidate.trend_topic,
                "descriptor_query": candidate.descriptor_query,
                "similarity": candidate.similarity,
                "similarity_basis": candidate.similarity_basis,
            }
            for candidate in decision.considered
        ],
    }
