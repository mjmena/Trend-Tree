"""Mechanical detection of McClatchy coverage of a prediction's subject
(CRMA-767).

The PRD fixes the mechanism, and this module is that sentence in SQL:

    "Coverage detection is mechanical SQL: prediction subject text embedded
    at 768 dims via Cortex, cosine-matched against the CMS story-embedding
    table (``CUE_CONTENT_VECTORS``), inclusive definition (commerce + wire +
    staff), syndicated duplicates counted once. Similarity threshold and
    dedupe rule are tuned at implementation. Detection results land only in
    ``EVIDENCE.coverage``."

**No LLM anywhere in this file.** Detection is deterministic, which is what
makes it testable standalone (AC1) -- the same statement lives at
``sql/prediction_coverage_detection.sql`` in a form you can paste into a
worksheet, and tests/test_coverage_detect.py holds the two files to the same
constants.

**Inclusive by construction.** ``CUE_CONTENT_VECTORS`` carries no
content-type, byline or credit-line column at all (``PUBLISHED_DATE``,
``CONTENTID``, ``HEADLINE``, ``KEYWORDS``, ``KEY_WORDS_VECTOR``,
``CLUSTER_ID``, ``CLUSTER_DESCRIPTION`` -- verified 2026-08-24), so there is
nothing here to filter commerce, wire or staff apart with, and the pool
predicate below adds no such filter. "Inclusive (commerce + wire + staff)" is
therefore a property of the code rather than a rule someone has to keep: a
future edit that wanted to exclude a content class would have to *add* a
join to reach a column that would tell it which class a story is.

**Why the pool is narrowed at all**, given that:

* ``KEY_WORDS_VECTOR IS NOT NULL`` -- there is nothing to cosine against
  otherwise.
* ``ARRAY_SIZE(KEYWORDS) > 0`` -- a stored vector over an empty keyword list
  is noise wearing the shape of a reading. In a 30-day window on 2026-08-24,
  66,612 rows carried no headline, 43,844 of them still carried a vector,
  and only 3,046 carried any keywords.
* ``HEADLINE IS NOT NULL`` and at least ``MIN_HEADLINE_CHARS`` of it -- the
  junk floor, and the one that changes results. CMS test rows ("test", "Test
  QA3", "BE Sanity validation", "related Carousel") sit in the live pool and
  scored 0.72-0.75 against short subject descriptors on 2026-08-24 --
  *above* every genuine adjacency for niche subjects like "urolithin A". A
  demote-only signal makes a false positive the expensive error: it quietly
  lowers a live call's posture with an unreadable row as its only evidence.
  Every one of those test rows is under 30 characters; real McClatchy
  headlines are not.

  This is pool hygiene on the *content* side, not a gate on predictions:
  nothing here can filter, suppress or refuse a prediction, and a subject
  with no detections gets a verdict exactly as one with ten does.

**The dedupe rule (AC1, AC6): one detection per folded headline.** A
syndicated story runs on many McClatchy sites and lands in
``CUE_CONTENT_VECTORS`` once per publication -- same headline, same keyword
vector, different ``CONTENTID``. Folding on
``TRIM(REGEXP_REPLACE(LOWER(HEADLINE), '[^0-9a-z]+', ' '))`` counts that
story once and records how many copies collapsed into it
(``SYNDICATED_COPIES``), with the earliest and latest publication dates. It
is deliberately the *headline*, not ``CLUSTER_ID``: clusters group related
stories (863 of them across a 180-day, 485k-row window), which would count a
whole topic once rather than a whole syndication once.

**The threshold (AC6): 0.78.** Measured 2026-08-24, ten live
``SUBJECT_DESCRIPTOR`` values off ``FCT_PREDICTION_VERDICT_LEDGER`` against
the 180-day pool this module defines. The sample contained exactly one
genuine piece of McClatchy coverage of a prediction's subject -- "protein
coffee" -> *Protein coffee: How the trending drink is changing the way
Americans fuel their mornings* -- and it scored **0.8172**. The best
*adjacent, non-covering* hit across all ten subjects scored **0.7730**
("continuous hormone monitor" -> a perimenopause-symptoms explainer). 0.78
sits in that gap.

The gap is the whole calibration, and it is narrow, so the error direction
was chosen deliberately: genuine coverage that scores low is missed (the
sample's "filtered showerhead" -> *Everything You Need To Know About Shower
Filters* sits at 0.7047 and does not clear the bar). That is the right way
to be wrong here. A missed detection leaves a call exactly where the external
evidence put it; a false detection silently demotes a live call on the
strength of a story that is not about it. Re-tune by moving
``DEFAULT_MIN_SIMILARITY`` -- the value in force is written into every
``EVIDENCE.coverage`` payload, so past rows stay readable against the cutoff
that produced them.

**The window: 180 days**, following the trend-side content match
(``sql/task_recompute_content_matches.sql``, CRMA-452) against the same
table, so the two readings of "have we written about this" span the same
corpus.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..matching.isolation import positive_int
from .isolation import assert_coverage_sql

log = logging.getLogger(__name__)

#: The data team's story embeddings. Fully qualified here rather than through
#: ``Settings.qualify``: it lives in MCC_RAW.STORY_DATA, not in this
#: service's own MCC_PRESENTATION.TREND_AGENT schema, and pretending
#: otherwise would let a schema setting silently repoint it.
CONTENT_VECTORS_TABLE = "MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS"

#: The object name the isolation guard checks the statement's FROM targets
#: against.
CONTENT_VECTORS_OBJECT = "CUE_CONTENT_VECTORS"

#: The model ``KEY_WORDS_VECTOR`` was written with -- 768-dim
#: arctic-embed-m-v1.5, fingerprint-confirmed by the data team and reused by
#: CRMA-452. Embedding the subject in any other space produces a number that
#: looks like a similarity and means nothing. Distinct from the 1024-dim
#: arctic-embed-l-v2.0 space ``TREND_VECTOR`` lives in
#: (matching/trends.py); the two are never compared.
EMBED_MODEL = "snowflake-arctic-embed-m-v1.5"

#: Cosine floor for a detection. See the module docstring for the measurement.
DEFAULT_MIN_SIMILARITY = 0.78

#: How far back the published-content pool reaches.
DEFAULT_WINDOW_DAYS = 180

#: The junk floor on headline length. See the module docstring.
DEFAULT_MIN_HEADLINE_CHARS = 30

#: Most detections recorded per subject. A cap on payload size: coverage is
#: read as "have we written about this, and what" -- the tenth-best story
#: adds nothing a strategist acts on, and ``EVIDENCE`` is a VARIANT that ends
#: up on every ledger row.
DEFAULT_DETECTION_LIMIT = 5

#: Subjects per statement. The whole sweep is detected in ONE read: the pool
#: scan dominates the cost, so scanning it once for 25 subjects beats
#: scanning it 25 times. Measured 2026-08-24: ten subjects against the live
#: 180-day pool returned in ~5s.
DEFAULT_SUBJECT_LIMIT = 50


# One statement, one pool scan, every subject. `{subject_selects}` is a
# UNION ALL of one bind per subject -- binds, not interpolated text, so a
# subject descriptor cannot change the statement's shape, and the guard sees
# the same template the client is handed.
COVERAGE_DETECTION_QUERY = """
WITH SUBJECTS AS (
{subject_selects}
),
SUBJECT_VECTORS AS (
    SELECT
        SUBJECT_DESCRIPTOR,
        SNOWFLAKE.CORTEX.EMBED_TEXT_768(%(embed_model)s, SUBJECT_DESCRIPTOR) AS SUBJECT_VECTOR
    FROM SUBJECTS
),
POOL AS (
    SELECT
        CONTENTID,
        HEADLINE,
        PUBLISHED_DATE,
        KEY_WORDS_VECTOR,
        TRIM(REGEXP_REPLACE(LOWER(HEADLINE), '[^0-9a-z]+', ' ')) AS HEADLINE_FOLD
    FROM {content_vectors}
    WHERE PUBLISHED_DATE >= DATEADD('day', -%(window_days)s, CURRENT_DATE())
      AND KEY_WORDS_VECTOR IS NOT NULL
      AND HEADLINE IS NOT NULL
      AND ARRAY_SIZE(KEYWORDS) > 0
      AND LENGTH(TRIM(HEADLINE)) >= %(min_headline_chars)s
),
FOLDED AS (
    SELECT
        s.SUBJECT_DESCRIPTOR,
        p.HEADLINE_FOLD,
        MIN(p.CONTENTID)      AS CONTENT_ID,
        MIN(p.HEADLINE)       AS HEADLINE,
        MIN(p.PUBLISHED_DATE) AS FIRST_PUBLISHED_DATE,
        MAX(p.PUBLISHED_DATE) AS LAST_PUBLISHED_DATE,
        COUNT(*)              AS SYNDICATED_COPIES,
        MAX(VECTOR_COSINE_SIMILARITY(s.SUBJECT_VECTOR, p.KEY_WORDS_VECTOR)::FLOAT) AS SIMILARITY
    FROM POOL p
    CROSS JOIN SUBJECT_VECTORS s
    GROUP BY s.SUBJECT_DESCRIPTOR, p.HEADLINE_FOLD
)
SELECT
    SUBJECT_DESCRIPTOR,
    CONTENT_ID,
    HEADLINE,
    FIRST_PUBLISHED_DATE,
    LAST_PUBLISHED_DATE,
    SYNDICATED_COPIES,
    ROUND(SIMILARITY, 4) AS SIMILARITY
FROM FOLDED
WHERE SIMILARITY >= %(min_similarity)s
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY SUBJECT_DESCRIPTOR ORDER BY SIMILARITY DESC, CONTENT_ID ASC
) <= %(detection_limit)s
ORDER BY SUBJECT_DESCRIPTOR ASC, SIMILARITY DESC, CONTENT_ID ASC
"""

#: Why a reading holds nothing. Spelled out rather than left as an empty
#: list, because "we looked and found nothing" and "we could not look" are
#: different facts and only the first one is evidence.
MISS_NOT_CONFIGURED = "no coverage detector is wired for this service"
MISS_LOOKUP_FAILED = "the coverage detection query failed"
MISS_NO_SUBJECTS = "no subjects were submitted for detection"


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def bounded_cosine(name: str, value: Any) -> float:
    """Coerce a cosine bound to a float in [0, 1], or refuse.

    The connector's ``pyformat`` paramstyle substitutes numeric binds into
    the statement text client-side, so forcing this to a float is what makes
    substitution incapable of changing the statement's shape after
    ``assert_coverage_sql`` has looked at it -- the same argument
    ``matching.isolation.positive_int`` makes for the integer bounds.
    """
    coerced = float(value)
    if not 0.0 <= coerced <= 1.0:
        raise ValueError(f"{name} must be a cosine in [0, 1], got {coerced}")
    return coerced


def fold_headline(headline: str) -> str:
    """The dedupe key, in Python.

    The same fold the SQL does, kept here so the rule can be read and tested
    without a warehouse (AC1) and so a fixture-backed detector dedupes the
    way the deployed one does. Deliberately the coarse ASCII fold the SQL
    expression performs -- not ``matching.subject.fold``, which also strips
    accents and plurals. Two headlines that differ by an accent are two
    headlines; two that differ by punctuation or case are one story.
    """
    kept = "".join(ch if ch.isalnum() and ch.isascii() else " " for ch in headline.lower())
    return " ".join(kept.split())


@dataclass(frozen=True)
class CoverageDetection:
    """One McClatchy story, deduped across its syndicated copies."""

    headline: str
    similarity: float
    content_id: str | None = None
    first_published_date: str | None = None
    last_published_date: str | None = None
    #: How many ``CUE_CONTENT_VECTORS`` rows folded into this one story.
    #: 1 means it ran on one site; 12 means the same story ran on twelve and
    #: is still one piece of coverage.
    syndicated_copies: int = 1

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> CoverageDetection:
        def get(name: str) -> Any:
            return row[name] if name in row else row.get(name.lower())

        return cls(
            headline=_text(get("HEADLINE")) or "",
            similarity=_float(get("SIMILARITY")) or 0.0,
            content_id=_text(get("CONTENT_ID")),
            first_published_date=_text(get("FIRST_PUBLISHED_DATE")),
            last_published_date=_text(get("LAST_PUBLISHED_DATE")),
            syndicated_copies=max(1, _int(get("SYNDICATED_COPIES"), 1)),
        )

    def as_evidence(self) -> dict[str, Any]:
        return {
            "content_id": self.content_id,
            "headline": self.headline,
            "first_published_date": self.first_published_date,
            "last_published_date": self.last_published_date,
            "syndicated_copies": self.syndicated_copies,
            "similarity": round(self.similarity, 4),
        }


@dataclass(frozen=True)
class CoverageReading:
    """What one subject's detection pass found -- or why it found nothing.

    ``available`` is the difference between a reading and a miss.
    ``available=True`` with no detections means "we looked at every McClatchy
    story in the window and none of them is about this", which is a fact
    worth having. ``available=False`` means "we could not look", which is
    not, and which ``coverage_demotes`` treats as no reason to demote.
    """

    subject: str
    available: bool = False
    detections: tuple[CoverageDetection, ...] = ()
    min_similarity: float = DEFAULT_MIN_SIMILARITY
    window_days: int = DEFAULT_WINDOW_DAYS
    miss_reason: str | None = None
    error: str | None = None

    @property
    def detected(self) -> bool:
        """Whether McClatchy has published on this subject inside the window."""
        return self.available and bool(self.detections)

    @property
    def story_count(self) -> int:
        """Distinct stories -- syndicated copies already counted once."""
        return len(self.detections)

    @property
    def syndicated_rows(self) -> int:
        """Rows that folded into those stories. Recorded next to
        ``story_count`` so a reader can see the dedupe having done something
        rather than take it on trust."""
        return sum(detection.syndicated_copies for detection in self.detections)

    @property
    def top_similarity(self) -> float | None:
        return max((d.similarity for d in self.detections), default=None)


class CoverageDetector(Protocol):
    """The one external seam. Implementations must not raise: an outage is a
    miss, and a miss must not stop the pillar writing verdicts."""

    def detect(self, subjects: Sequence[str]) -> list[CoverageReading]:
        """One reading per subject, in the order given."""
        ...


@dataclass(frozen=True)
class StaticCoverageDetector:
    """A detector that consults nobody.

    What a caller who did not wire the deployed detector gets -- tests, the
    local loop, and any ``create_app`` that omits ``coverage``. Deliberately
    not a silent no-op: every reading says which oracle was not consulted, so
    a ledger row written by an unwired service reads as one. ``readings`` lets
    a test hand back a prepared answer per subject.
    """

    readings: Mapping[str, CoverageReading] = field(default_factory=dict)
    default_miss_reason: str = MISS_NOT_CONFIGURED

    def detect(self, subjects: Sequence[str]) -> list[CoverageReading]:
        return [
            self.readings.get(
                subject,
                CoverageReading(
                    subject=subject, available=False, miss_reason=self.default_miss_reason
                ),
            )
            for subject in subjects
        ]


class CoverageQueryRunner(Protocol):
    def query(
        self, sql: str, params: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]: ...


def build_detection_sql(
    subject_count: int, *, content_vectors: str = CONTENT_VECTORS_TABLE
) -> str:
    """The statement for ``subject_count`` subjects, binds and all.

    Public so ``sql/prediction_coverage_detection.sql`` and the tests can
    read the exact text the service issues rather than a paraphrase of it.
    """
    if subject_count < 1:
        raise ValueError(f"subject_count must be at least 1, got {subject_count}")
    selects = ["    SELECT %(subject_0)s AS SUBJECT_DESCRIPTOR"]
    selects += [
        f"    UNION ALL SELECT %(subject_{position})s"
        for position in range(1, subject_count)
    ]
    return COVERAGE_DETECTION_QUERY.format(
        subject_selects="\n".join(selects), content_vectors=content_vectors
    )


@dataclass(frozen=True)
class SnowflakeCoverageDetector:
    """The deployed detector: one statement, one pool scan, every subject.

    Every knob is a construction argument, so re-tuning the threshold is a
    visible change at the call site rather than a monkeypatch, and every
    value in force is written into the reading it produced.
    """

    client: CoverageQueryRunner
    content_vectors: str = CONTENT_VECTORS_TABLE
    embed_model: str = EMBED_MODEL
    min_similarity: float = DEFAULT_MIN_SIMILARITY
    window_days: int = DEFAULT_WINDOW_DAYS
    min_headline_chars: int = DEFAULT_MIN_HEADLINE_CHARS
    detection_limit: int = DEFAULT_DETECTION_LIMIT
    subject_limit: int = DEFAULT_SUBJECT_LIMIT

    def detect(self, subjects: Sequence[str]) -> list[CoverageReading]:
        wanted = list(subjects)
        if not wanted:
            return []

        # Distinct, because two live predictions can share a subject
        # descriptor and the statement groups by it -- and capped, because
        # the bind list grows with the subject count.
        unique = list(dict.fromkeys(subject for subject in wanted if subject.strip()))
        over_cap = unique[self.subject_limit :]
        unique = unique[: self.subject_limit]

        rows_by_subject: dict[str, list[dict[str, Any]]] = {}
        failure: str | None = None
        if unique:
            sql = build_detection_sql(len(unique), content_vectors=self.content_vectors)
            assert_coverage_sql(sql, allowed_tables=(CONTENT_VECTORS_OBJECT,))
            params: dict[str, Any] = {
                "embed_model": self.embed_model,
                "window_days": positive_int("window_days", self.window_days),
                "min_headline_chars": positive_int(
                    "min_headline_chars", self.min_headline_chars
                ),
                "min_similarity": bounded_cosine("min_similarity", self.min_similarity),
                "detection_limit": positive_int("detection_limit", self.detection_limit),
            }
            for position, subject in enumerate(unique):
                params[f"subject_{position}"] = subject
            try:
                for row in self.client.query(sql, params):
                    key = _text(
                        row["SUBJECT_DESCRIPTOR"]
                        if "SUBJECT_DESCRIPTOR" in row
                        else row.get("subject_descriptor")
                    )
                    if key is not None:
                        rows_by_subject.setdefault(key, []).append(row)
            except Exception as err:  # noqa: BLE001 - an outage is a miss, not a failed run
                # Never re-raised. Coverage can only ever demote, so losing a
                # detection pass costs a posture change, never a verdict --
                # and failing the sweep over it would cost every row.
                log.warning("coverage detection failed; every subject reads unlooked: %s", err)
                failure = f"{type(err).__name__}: {err}"

        return [self._reading(subject, rows_by_subject, failure, over_cap) for subject in wanted]

    def _reading(
        self,
        subject: str,
        rows_by_subject: Mapping[str, list[dict[str, Any]]],
        failure: str | None,
        over_cap: Sequence[str],
    ) -> CoverageReading:
        base = {
            "subject": subject,
            "min_similarity": self.min_similarity,
            "window_days": self.window_days,
        }
        if failure is not None:
            return CoverageReading(
                **base, available=False, miss_reason=MISS_LOOKUP_FAILED, error=failure
            )
        if not subject.strip():
            return CoverageReading(**base, available=False, miss_reason=MISS_NO_SUBJECTS)
        if subject in over_cap:
            return CoverageReading(
                **base,
                available=False,
                miss_reason=(
                    f"past this run's subject cap of {self.subject_limit}; not looked up, "
                    "which changes nothing about this call's posture"
                ),
            )
        detections = tuple(
            CoverageDetection.from_row(row) for row in rows_by_subject.get(subject, ())
        )
        return CoverageReading(**base, available=True, detections=detections)
