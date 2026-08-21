"""The matching phase's warehouse reaches (CRMA-764).

Three reads, all of them trend-side, all named here so the phase's whole
surface against the warehouse is one file:

* ``descriptor_index`` -- every trend's current ``descriptor.query`` /
  ``descriptor.statement`` (ADR-0003), read once per run. The descriptor
  vocabulary leg of the match is decided in Python over this list
  (matching/subject.py), not by a SQL fold, so the comparison is exact and
  unit-testable and no trend can fall out of the window before it is
  considered.
* ``candidates_for`` -- the embedding leg: the subject descriptor embedded
  with Cortex and cosine-ranked against each trend's current
  ``TREND_VECTOR``, top-N. Same 1024-dim arctic-embed space the trend vectors
  were written in (sql/fn_trend_embed_doc.sql), so the comparison is
  meaningful rather than merely numeric.
* ``context_for`` -- the matched trend's heat, acceleration, cumulative
  growth and age. **Evidence, never a filter** -- see TrendContext.

Everything here reads. The verdict write is the route's job, after matching
has returned, with the route's own client; ``assert_matching_sql`` runs on
every statement issued from this module and rejects anything that is not a
single read of an explicitly-granted object (matching/isolation.py).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .isolation import assert_matching_sql, positive_int
from .subject import fold, fold_ascii

#: Canonical trend identity. Unqualified -- routes/match.py passes
#: ``settings.qualify(TRENDS_TABLE)``.
TRENDS_TABLE = "FCT_TRENDS"
#: Where the descriptor and the trend vector live (latest row per trend).
ENRICHMENT_LEDGER_TABLE = "FCT_TREND_ENRICHMENT_LEDGER"
#: Heat and lifecycle status, per evaluation.
LIFECYCLE_LEDGER_TABLE = "FCT_TREND_LIFECYCLE_LEDGER"
#: Trend <-> signal links, for the cumulative-growth measures.
TREND_SIGNALS_TABLE = "FCT_TREND_SIGNALS"
#: The signal corpus -- joined only to read a linked signal's SOURCE_NAME.
SIGNALS_TABLE = "FCT_SIGNALS"

#: The embedding model the trend vectors were written with
#: (sql/fn_trend_embed_doc.sql). Embedding the subject in any other space
#: would produce a number that looks like a similarity and means nothing.
EMBED_MODEL = "snowflake-arctic-embed-l-v2.0"

#: How many trends the descriptor index carries. A cap on payload size, not a
#: correctness knob: the descriptor leg compares against whatever it returns,
#: and there are ~500 promoted trends in total.
DEFAULT_DESCRIPTOR_LIMIT = 2000

#: How many cosine-ranked trends one subject's embedding leg considers.
DEFAULT_CANDIDATE_LIMIT = 10

#: How wide the stage-one retrieval window is before stage two re-scores it.
#: Measured, not guessed: probed on 2026-08-21, each of the 284 live trends
#: carrying a descriptor puts its own trend vector inside the top 50 for its
#: own descriptor query (median rank 1, worst 43 of 491). Raising it costs one
#: Cortex embedding per extra row, per subject.
DEFAULT_RESCORE_LIMIT = 50


# The descriptor index. "Current descriptor" is the latest row per trend that
# authored one -- ADR-0003 makes the descriptor *evolving*, not frozen, so it
# is a latest-non-null read exactly like TREND_VECTOR's.
DESCRIPTOR_INDEX_QUERY = """
WITH LATEST_DESCRIPTOR AS (
    SELECT
        TREND_ID,
        PAYLOAD:descriptor:query::STRING     AS DESCRIPTOR_QUERY,
        PAYLOAD:descriptor:statement::STRING AS DESCRIPTOR_STATEMENT,
        ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS RN
    FROM {enrichment}
    WHERE PAYLOAD:descriptor:query::STRING IS NOT NULL
)
SELECT
    t.TREND_ID,
    t.TREND_TOPIC,
    d.DESCRIPTOR_QUERY,
    d.DESCRIPTOR_STATEMENT
FROM {trends} t
JOIN LATEST_DESCRIPTOR d ON d.TREND_ID = t.TREND_ID AND d.RN = 1
ORDER BY t.TREND_ID ASC
LIMIT %(descriptor_limit)s
"""

# The embedding leg, in two stages: retrieve on the trend vector, score on
# whichever text is the same *shape* as the subject.
#
# The subject is embedded per call rather than stored: a prediction's subject
# descriptor is minted once and read a handful of times, so caching it would
# buy a Cortex call and cost a column nobody else wants.
#
# **Why two stages.** TREND_VECTOR embeds a ~350-character, 3-sentence
# `descriptor.statement` (ADR-0003, sql/fn_trend_embed_doc.sql); a prediction's
# SUBJECT_DESCRIPTOR is a ~16-character noun phrase. Comparing them is
# asymmetric and the cosines compress badly -- measured on 2026-08-21 over the
# 284 live trends that carry a descriptor, a trend's *own* descriptor query
# scores a median 0.5632 against its *own* trend vector, and only 101 of 284
# (36%) reach 0.60 at all. As a scorer that is unusable. As a *retriever* it is
# fine: the same probe puts the trend's own vector at median rank 1 and worst
# rank 43 of 491, so 284 of 284 land inside a 50-row window.
#
# So stage one keeps the trend vector and uses it only to pick the window, and
# stage two re-scores that window noun-phrase against noun-phrase by embedding
# the trend's own `descriptor.query`. A trend with no descriptor keeps its
# statement-side score -- ~42% of promoted trends have none, and dropping them
# from the leg entirely would cost more coverage than the rescale buys. The two
# numbers are on different scales and each carries its own floor; SIMILARITY_BASIS
# is what tells matching/decide.py which one it is holding.
#
# Cost of stage two, measured: ~4.6s per subject against the live corpus versus
# ~2.9s for the single-stage form. The window is what bounds it -- 50 rows of
# Cortex embedding, not 284.
#
# DESCRIPTOR_EXACT is *not* the descriptor-vocabulary decision -- that is made
# in Python over the descriptor index (matching/subject.py, which also folds
# accents and plurals, neither of which this expression does). It is here only
# so that a trend whose descriptor already reads as the subject sorts into the
# window even when its cosine rank would not have put it there.
TREND_CANDIDATE_QUERY = """
WITH LATEST_VECTOR AS (
    SELECT
        TREND_ID,
        TREND_VECTOR,
        ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS RN
    FROM {enrichment}
    WHERE TREND_VECTOR IS NOT NULL
),
LATEST_DESCRIPTOR AS (
    SELECT
        TREND_ID,
        PAYLOAD:descriptor:query::STRING     AS DESCRIPTOR_QUERY,
        PAYLOAD:descriptor:statement::STRING AS DESCRIPTOR_STATEMENT,
        ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS RN
    FROM {enrichment}
    WHERE PAYLOAD:descriptor:query::STRING IS NOT NULL
),
SUBJECT AS (
    SELECT SNOWFLAKE.CORTEX.EMBED_TEXT_1024(%(embed_model)s, %(subject)s) AS SUBJECT_VECTOR
),
WINDOWED AS (
    SELECT
        t.TREND_ID,
        t.TREND_TOPIC,
        d.DESCRIPTOR_QUERY,
        d.DESCRIPTOR_STATEMENT,
        VECTOR_COSINE_SIMILARITY(v.TREND_VECTOR, s.SUBJECT_VECTOR)::FLOAT AS STATEMENT_SIMILARITY,
        IFF(
            TRIM(REGEXP_REPLACE(LOWER(d.DESCRIPTOR_QUERY), '[^0-9a-z]+', ' ')) = %(subject_fold)s,
            1, 0
        ) AS DESCRIPTOR_EXACT
    FROM {trends} t
    JOIN LATEST_VECTOR v ON v.TREND_ID = t.TREND_ID AND v.RN = 1
    LEFT JOIN LATEST_DESCRIPTOR d ON d.TREND_ID = t.TREND_ID AND d.RN = 1
    CROSS JOIN SUBJECT s
    QUALIFY ROW_NUMBER() OVER (
        ORDER BY DESCRIPTOR_EXACT DESC, STATEMENT_SIMILARITY DESC, t.TREND_ID ASC
    ) <= %(rescore_limit)s
),
RESCORED AS (
    SELECT
        w.TREND_ID,
        w.TREND_TOPIC,
        w.DESCRIPTOR_QUERY,
        w.DESCRIPTOR_STATEMENT,
        w.DESCRIPTOR_EXACT,
        w.STATEMENT_SIMILARITY,
        VECTOR_COSINE_SIMILARITY(
            SNOWFLAKE.CORTEX.EMBED_TEXT_1024(%(embed_model)s, w.DESCRIPTOR_QUERY),
            s.SUBJECT_VECTOR
        )::FLOAT AS DESCRIPTOR_SIMILARITY
    FROM WINDOWED w
    CROSS JOIN SUBJECT s
)
SELECT
    TREND_ID,
    TREND_TOPIC,
    DESCRIPTOR_QUERY,
    DESCRIPTOR_STATEMENT,
    COALESCE(DESCRIPTOR_SIMILARITY, STATEMENT_SIMILARITY) AS SIMILARITY,
    IFF(DESCRIPTOR_SIMILARITY IS NULL, 'statement', 'descriptor_query') AS SIMILARITY_BASIS,
    STATEMENT_SIMILARITY,
    DESCRIPTOR_SIMILARITY,
    DESCRIPTOR_EXACT
FROM RESCORED
ORDER BY DESCRIPTOR_EXACT DESC, SIMILARITY DESC, TREND_ID ASC
LIMIT %(candidate_limit)s
"""

# The trend context. These four measures -- heat, acceleration, cumulative
# growth, age -- are exactly the inputs the retired deterministic scorer
# turned into its PREDICTION_ELIGIBLE gate (prediction-agent-p_QPCkLP1). They
# are carried here as addressed context and nothing else; see TrendContext.
#
# The growth measures are cumulative-set deltas (each signal / source
# attributed to the window in which it FIRST linked to the trend), so a bulk
# re-link of historical rows raises the level once instead of manufacturing a
# phantom cliff -- the same construction the scorer used, for the same reason.
# The source leg counts distinct SOURCE_NAMEs rather than the scorer's
# publisher domains: SOURCE_NAME is the pipeline's own first-class notion of
# a source (DISTINCT_SOURCE_COUNT on FCT_TRENDS), and reproducing the
# scorer's 40-line domain-extraction CASE here would duplicate a mapping that
# is maintained elsewhere.
TREND_CONTEXT_QUERY = """
WITH LIFECYCLE_NOW AS (
    SELECT
        NEW_STATUS                                AS LIFECYCLE_STATUS,
        COALESCE(NEW_HEAT_SMOOTHED, NEW_HEAT)     AS HEAT_INDEX,
        ROW_NUMBER() OVER (ORDER BY EVALUATED_AT DESC) AS RN
    FROM {lifecycle}
    WHERE TREND_ID = %(trend_id)s
),
HEAT_HISTORY AS (
    SELECT
        (SELECT COALESCE(NEW_HEAT_SMOOTHED, NEW_HEAT)
           FROM {lifecycle}
          WHERE TREND_ID = %(trend_id)s
            AND EVALUATED_AT <= DATEADD('day', -7, CURRENT_TIMESTAMP())
          ORDER BY EVALUATED_AT DESC LIMIT 1)  AS HEAT_7D_AGO,
        (SELECT COALESCE(NEW_HEAT_SMOOTHED, NEW_HEAT)
           FROM {lifecycle}
          WHERE TREND_ID = %(trend_id)s
            AND EVALUATED_AT <= DATEADD('day', -14, CURRENT_TIMESTAMP())
          ORDER BY EVALUATED_AT DESC LIMIT 1)  AS HEAT_14D_AGO
),
SIGNAL_LINKS AS (
    SELECT SIGNAL_ID, MIN(LINKED_AT) AS FIRST_LINKED
    FROM {trend_signals}
    WHERE TREND_ID = %(trend_id)s
    GROUP BY SIGNAL_ID
),
SIGNAL_GROWTH AS (
    SELECT
        COUNT(*)                                                             AS N_NOW,
        COUNT_IF(FIRST_LINKED < DATEADD('day', -7, CURRENT_TIMESTAMP()))     AS N_PRIOR
    FROM SIGNAL_LINKS
),
SOURCE_LINKS AS (
    SELECT sig.SOURCE_NAME, MIN(l.FIRST_LINKED) AS FIRST_LINKED
    FROM SIGNAL_LINKS l
    JOIN {signals} sig ON sig.SIGNAL_ID = l.SIGNAL_ID
    GROUP BY sig.SOURCE_NAME
),
SOURCE_GROWTH AS (
    SELECT
        COUNT(*)                                                             AS N_NOW,
        COUNT_IF(FIRST_LINKED < DATEADD('day', -7, CURRENT_TIMESTAMP()))     AS N_PRIOR
    FROM SOURCE_LINKS
)
SELECT
    t.TREND_ID,
    t.TREND_TOPIC,
    ln.LIFECYCLE_STATUS,
    ln.HEAT_INDEX,
    hh.HEAT_7D_AGO,
    hh.HEAT_14D_AGO,
    (ln.HEAT_INDEX - hh.HEAT_7D_AGO)
        - (hh.HEAT_7D_AGO - hh.HEAT_14D_AGO)             AS ACCELERATION,
    sg.N_NOW                                             AS LINKED_SIGNALS_TOTAL,
    sg.N_NOW - sg.N_PRIOR                                AS LINKED_SIGNALS_ADDED_7D,
    og.N_NOW                                             AS DISTINCT_SOURCES_TOTAL,
    og.N_NOW - og.N_PRIOR                                AS DISTINCT_SOURCES_ADDED_7D,
    DATEDIFF('day', t.PROMOTED_AT, CURRENT_TIMESTAMP())  AS AGE_DAYS
FROM {trends} t
LEFT JOIN LIFECYCLE_NOW ln ON ln.RN = 1
LEFT JOIN HEAT_HISTORY hh ON TRUE
LEFT JOIN SIGNAL_GROWTH sg ON TRUE
LEFT JOIN SOURCE_GROWTH og ON TRUE
WHERE t.TREND_ID = %(trend_id)s
"""


def _get(row: Mapping[str, Any], name: str) -> Any:
    """Read a column from a warehouse row (upper-case keys) or a fixture dict
    (lower-case keys) -- the local loop and the deployed run share the code
    below this line."""
    if name in row:
        return row[name]
    return row.get(name.lower())


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


#: ``SIMILARITY`` was computed against the trend's own ``descriptor.query`` --
#: a noun phrase against a noun phrase, the like-with-like comparison.
BASIS_DESCRIPTOR_QUERY = "descriptor_query"
#: ``SIMILARITY`` was computed against TREND_VECTOR, which embeds a
#: 3-sentence ``descriptor.statement``. The fallback for a trend that has no
#: descriptor at all; a different scale, and it carries a different floor.
BASIS_STATEMENT = "statement"


@dataclass(frozen=True)
class TrendCandidate:
    """One trend, as the compare step sees it."""

    trend_id: str
    trend_topic: str | None = None
    descriptor_query: str | None = None
    descriptor_statement: str | None = None
    #: Cosine against the subject's embedding. None on a descriptor-index row,
    #: which is read without a subject to compare to.
    similarity: float | None = None
    #: Which text ``similarity`` was measured against. The two bases are on
    #: different scales, so this is what matching/decide.py reads to pick the
    #: floor that applies. Defaults to the statement basis: a caller that
    #: supplies a bare number (a fixture, a unit test) is describing the
    #: original comparison.
    similarity_basis: str = BASIS_STATEMENT

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> TrendCandidate:
        return cls(
            trend_id=str(_get(row, "TREND_ID") or ""),
            trend_topic=_text(_get(row, "TREND_TOPIC")),
            descriptor_query=_text(_get(row, "DESCRIPTOR_QUERY")),
            descriptor_statement=_text(_get(row, "DESCRIPTOR_STATEMENT")),
            similarity=_number(_get(row, "SIMILARITY")),
            similarity_basis=_text(_get(row, "SIMILARITY_BASIS")) or BASIS_STATEMENT,
        )


@dataclass(frozen=True)
class TrendContext:
    """The matched trend's heat, acceleration, cumulative growth and age.

    **These are the demoted v2-gate measures.** The retired deterministic
    scorer combined exactly these into ``PREDICTION_ELIGIBLE`` --
    ``heat_now < 70 AND acceleration > 0 AND (source_delta > 0 OR
    signal_delta > 0) AND days_since_promotion >= 14 AND percentile >= 0.70``
    -- and the strategy's whole objection to that scorer is that a threshold
    is not a judgement. So they survive here as *evidence a model reasons
    over*, and the code does not read them: nothing in this service branches
    on a value in this object. No value of heat, acceleration, growth or age
    can drop a prediction, change its confidence, or change whether it
    matched. tests/test_no_mechanical_filter.py is the proof.

    Every measure is nullable, and a null is not a failure -- a trend
    promoted four days ago has no 14-day-old heat row, so its acceleration is
    unknown. Unknown is reported as unknown; it is never defaulted to a
    number the model would then reason over as if it were measured.
    """

    trend_id: str
    trend_topic: str | None = None
    lifecycle_status: str | None = None
    heat_index: float | None = None
    heat_7d_ago: float | None = None
    heat_14d_ago: float | None = None
    acceleration: float | None = None
    linked_signals_total: float | None = None
    linked_signals_added_7d: float | None = None
    distinct_sources_total: float | None = None
    distinct_sources_added_7d: float | None = None
    age_days: float | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> TrendContext:
        return cls(
            trend_id=str(_get(row, "TREND_ID") or ""),
            trend_topic=_text(_get(row, "TREND_TOPIC")),
            lifecycle_status=_text(_get(row, "LIFECYCLE_STATUS")),
            heat_index=_number(_get(row, "HEAT_INDEX")),
            heat_7d_ago=_number(_get(row, "HEAT_7D_AGO")),
            heat_14d_ago=_number(_get(row, "HEAT_14D_AGO")),
            acceleration=_number(_get(row, "ACCELERATION")),
            linked_signals_total=_number(_get(row, "LINKED_SIGNALS_TOTAL")),
            linked_signals_added_7d=_number(_get(row, "LINKED_SIGNALS_ADDED_7D")),
            distinct_sources_total=_number(_get(row, "DISTINCT_SOURCES_TOTAL")),
            distinct_sources_added_7d=_number(_get(row, "DISTINCT_SOURCES_ADDED_7D")),
            age_days=_number(_get(row, "AGE_DAYS")),
        )

    def as_evidence(self) -> dict[str, Any]:
        """The ``EVIDENCE.trend_context`` payload for a matched verdict.

        ``basis`` is written into the row itself rather than left to this
        docstring: a reader of the ledger in a year should be able to see,
        from the row, that these numbers were context and not a gate.
        """
        return {
            "trend_id": self.trend_id,
            "trend_topic": self.trend_topic,
            "lifecycle_status": self.lifecycle_status,
            "heat_index": self.heat_index,
            "heat_7d_ago": self.heat_7d_ago,
            "heat_14d_ago": self.heat_14d_ago,
            "acceleration": self.acceleration,
            "linked_signals_total": self.linked_signals_total,
            "linked_signals_added_7d": self.linked_signals_added_7d,
            "distinct_sources_total": self.distinct_sources_total,
            "distinct_sources_added_7d": self.distinct_sources_added_7d,
            "age_days": self.age_days,
            "basis": (
                "addressed context for the verdict's reasoning, never a filter: "
                "no value here excludes a prediction or adjusts its confidence"
            ),
        }


class TrendReader(Protocol):
    """The compare step's view of the trend pipeline. Read-only by
    construction -- there is no method here that writes."""

    def descriptor_index(self) -> list[TrendCandidate]: ...

    def candidates_for(self, subject: str, *, limit: int) -> list[TrendCandidate]: ...

    def context_for(self, trend_id: str) -> TrendContext | None: ...


class TrendQueryRunner(Protocol):
    """The read half of a warehouse client. Narrowed as a declaration of what
    this module uses; ``assert_matching_sql`` is what enforces it."""

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]: ...


class SnowflakeTrendReader:
    """The deployed compare step's trend side.

    Table names are injected so ``Settings.qualify`` stays in one place, but
    a caller cannot use them to smuggle in another object: every statement is
    measured against the grant written at its own call site below before the
    client is called at all.
    """

    def __init__(
        self,
        client: TrendQueryRunner,
        *,
        trends: str = TRENDS_TABLE,
        enrichment: str = ENRICHMENT_LEDGER_TABLE,
        lifecycle: str = LIFECYCLE_LEDGER_TABLE,
        trend_signals: str = TREND_SIGNALS_TABLE,
        signals: str = SIGNALS_TABLE,
        descriptor_limit: int = DEFAULT_DESCRIPTOR_LIMIT,
        rescore_limit: int = DEFAULT_RESCORE_LIMIT,
        embed_model: str = EMBED_MODEL,
    ) -> None:
        self._client = client
        self._trends = trends
        self._enrichment = enrichment
        self._lifecycle = lifecycle
        self._trend_signals = trend_signals
        self._signals = signals
        self._descriptor_limit = descriptor_limit
        self._rescore_limit = rescore_limit
        self._embed_model = embed_model

    def descriptor_index(self) -> list[TrendCandidate]:
        sql = DESCRIPTOR_INDEX_QUERY.format(trends=self._trends, enrichment=self._enrichment)
        assert_matching_sql(sql, allowed_tables=(TRENDS_TABLE, ENRICHMENT_LEDGER_TABLE))
        params = {
            "descriptor_limit": positive_int("descriptor_limit", self._descriptor_limit)
        }
        return [TrendCandidate.from_row(row) for row in self._client.query(sql, params)]

    def candidates_for(
        self, subject: str, *, limit: int = DEFAULT_CANDIDATE_LIMIT
    ) -> list[TrendCandidate]:
        sql = TREND_CANDIDATE_QUERY.format(trends=self._trends, enrichment=self._enrichment)
        assert_matching_sql(sql, allowed_tables=(TRENDS_TABLE, ENRICHMENT_LEDGER_TABLE))
        candidate_limit = positive_int("candidate_limit", limit)
        params = {
            "embed_model": self._embed_model,
            "subject": subject,
            # The SQL fold is ASCII-only, so the bind it is compared against
            # has to be too -- see subject.fold_ascii.
            "subject_fold": fold_ascii(subject),
            "candidate_limit": candidate_limit,
            # Never narrower than the window it feeds.
            "rescore_limit": max(
                positive_int("rescore_limit", self._rescore_limit), candidate_limit
            ),
        }
        return [TrendCandidate.from_row(row) for row in self._client.query(sql, params)]

    def context_for(self, trend_id: str) -> TrendContext | None:
        sql = TREND_CONTEXT_QUERY.format(
            trends=self._trends,
            lifecycle=self._lifecycle,
            trend_signals=self._trend_signals,
            signals=self._signals,
        )
        assert_matching_sql(
            sql,
            allowed_tables=(
                TRENDS_TABLE,
                LIFECYCLE_LEDGER_TABLE,
                TREND_SIGNALS_TABLE,
                SIGNALS_TABLE,
            ),
        )
        rows = self._client.query(sql, {"trend_id": trend_id})
        if not rows:
            return None
        return TrendContext.from_row(rows[0])


class FixtureTrendReader:
    """The local loop's trend side: rows from a fixture, no warehouse and no
    network. Same ``TrendReader`` surface the deployed run uses, so the
    offline path exercises the real decision code.

    The cosine itself is not simulated -- a fixture row carries the
    similarities its author wrote, per subject, under ``SIMILARITIES``
    (keyed by the subject descriptor; looked up on the folded form so
    "rucking vests" and "Rucking Vests" are one key). A row may also carry a
    flat ``SIMILARITY`` as the fallback for subjects it does not name.

    Per-subject is the whole point. A single flat number would hand every
    prediction the same neighbour list, which is not what a cosine does and
    would let a fixture run "match" two unrelated subjects to one trend.
    """

    def __init__(
        self,
        trends: Iterable[Mapping[str, Any]] = (),
        contexts: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        rows = list(trends)
        self._trends: Sequence[TrendCandidate] = [TrendCandidate.from_row(row) for row in rows]
        self._similarities: list[dict[str, float]] = []
        for row in rows:
            raw = _get(row, "SIMILARITIES") or {}
            self._similarities.append(
                {
                    fold(str(key)): value
                    for key, value in dict(raw).items()
                    if _number(value) is not None
                }
            )
        self._contexts = {
            trend_id: TrendContext.from_row(row) for trend_id, row in (contexts or {}).items()
        }

    def descriptor_index(self) -> list[TrendCandidate]:
        return [trend for trend in self._trends if trend.descriptor_query]

    def candidates_for(
        self, subject: str, *, limit: int = DEFAULT_CANDIDATE_LIMIT
    ) -> list[TrendCandidate]:
        key = fold(subject)
        scored = [
            TrendCandidate(
                trend_id=trend.trend_id,
                trend_topic=trend.trend_topic,
                descriptor_query=trend.descriptor_query,
                descriptor_statement=trend.descriptor_statement,
                similarity=_number(per_subject.get(key, trend.similarity)),
                similarity_basis=trend.similarity_basis,
            )
            for trend, per_subject in zip(self._trends, self._similarities, strict=True)
        ]
        ranked = sorted(scored, key=lambda t: (-(t.similarity or 0.0), t.trend_id))
        return list(ranked[: max(0, int(limit))])

    def context_for(self, trend_id: str) -> TrendContext | None:
        return self._contexts.get(trend_id)
