"""The data-quality floor -- the pillar's one permitted mechanical gate
(CRMA-765).

The strategy is explicit about how much mechanism this pillar is allowed:

    "The **only mechanical gate** anywhere in the pillar is the data-quality
    floor: no verdict is requested on trends/subjects too young or sparse to
    judge. Any new mechanical gate, discount, or eviction rule contradicts the
    strategy and requires a decision, not a commit."

So this module is deliberately the *only* place in the prediction path where
code decides that something does not get a verdict on grounds other than
structure. Two things follow, and both are load-bearing:

1. **It judges the observation record, never the claim.** The question is
   "do we have enough of a record to judge this at all", not "is this
   promising". Nothing here reads confidence, an emergence path, an Exploding
   Topics classification, or GDELT breadth -- and ``assess_floor``'s
   signature has no parameter through which any of them could arrive. A test
   asserts that signature, the same way test_blindness.py asserts
   ``generate_predictions``'.
2. **It fails open on what it cannot measure.** A cited signal with no usable
   timestamp does not count as young; it counts as unknown, and unknown never
   drops a candidate. A floor that skipped subjects because of a defect in
   its own inputs would be a gate wearing a floor's clothes.

**Where the thresholds come from.** The strategy anchors the floor at
"~ the old 14-day rule" -- the deterministic scorer's
``days_since_promotion >= 14`` (prediction-agent-p_QPCkLP1/commit_to_ledger),
which measured a *trend's* age since promotion. Generation has no trend: it
proposes subjects straight out of the signal corpus, and the record behind
one is the corpus rows the model cited. So the floor is translated onto that
record, and measured against it:

* ``MIN_OBSERVATION_AGE_HOURS = 24``. The corpus read stratifies by
  (source x calendar day) -- generation/signals.py -- so a subject whose
  entire cited record is under 24 hours old sits inside a single source-day
  cell by construction, and cannot show persistence across even two days.
  There is nothing there to judge a direction from. Measured against the
  live default run on 2026-08-21 (168-hour window, 200-row stratified
  sample): 45 of 200 rows were under 24 hours old, so this bites on a
  candidate only when *every* row it cited is that new -- a floor, not a
  filter.
* ``MIN_EVIDENCE_CHARS = 120``. Total title+text across the cited rows. The
  thin end of the corpus is real: ``google_trends_explore`` rows run to a
  minimum of 34 characters and a median of 64 (same measurement), which is a
  query string, not an observation. 23 of the same 200 rows fell under 120
  characters. A claim whose whole evidence base is a handful of query strings
  is unjudgeable on data-quality grounds, and this is deliberately a floor on
  *substance*, not on *count*: one rich signal clears it, which keeps the
  strategy's "high-potential single signal" emergence path emittable.

Both are constructor arguments with these as defaults, so re-tuning them is a
config change and a visible one.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

#: See the module docstring for how each number was arrived at.
MIN_OBSERVATION_AGE_HOURS = 24.0
MIN_EVIDENCE_CHARS = 120

#: The two reasons a subject can be skipped, in the strategy's own words.
TOO_YOUNG = "too young"
TOO_SPARSE = "too sparse"

_TIMESTAMP_FORMATS = (
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d",
)


def parse_timestamp(raw: str | None) -> datetime | None:
    """A corpus timestamp as a UTC datetime, or None when it cannot be read.

    None is a real answer here, not a failure: see the module docstring on
    failing open. ``FCT_SIGNALS.SIGNAL_TIMESTAMP`` arrives as a string
    through ``SignalRecord``, in whichever shape the connector or a fixture
    rendered it.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    candidate = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        parsed = None
        for fmt in _TIMESTAMP_FORMATS:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
    if parsed is None:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


@dataclass(frozen=True)
class EvidenceRecord:
    """The observation record behind one subject: the corpus rows the model
    cited, reduced to what the floor measures. Text only -- deliberately not
    the claim, the confidence, or anything about how promising the subject
    looks."""

    cited_signals: int
    evidence_chars: int
    #: Age of the OLDEST cited row. None when no cited row carried a readable
    #: timestamp, which reads as "unknown", never as "young".
    oldest_age_hours: float | None


@dataclass(frozen=True)
class FloorAssessment:
    """Whether a subject has enough of a record to be judged, and why not."""

    subject: str
    passes: bool
    reason: str | None
    record: EvidenceRecord

    def as_evidence(self) -> dict[str, object]:
        """The floor's own reading, for the ledger. A skipped subject writes
        no row, so in practice this is the record of a subject that *passed*
        -- which is worth keeping: it says what the verdict was allowed to
        rest on."""
        return {
            "passes": self.passes,
            "reason": self.reason,
            "cited_signals": self.record.cited_signals,
            "evidence_chars": self.record.evidence_chars,
            "oldest_evidence_age_hours": (
                None
                if self.record.oldest_age_hours is None
                else round(self.record.oldest_age_hours, 2)
            ),
        }


def build_evidence_record(
    cited_signal_ids: Iterable[str],
    corpus: Mapping[str, tuple[str | None, str]],
    *,
    now: datetime | None = None,
) -> EvidenceRecord:
    """Reduce the cited corpus rows to the three numbers the floor measures.

    ``corpus`` maps signal id -> (timestamp string, text). Ids the corpus
    does not carry are skipped -- the parser has already dropped uncitable
    ids, so this only ever fires on a caller that built the index from a
    different slice.
    """
    moment = now or datetime.now(UTC)
    cited = 0
    chars = 0
    oldest: float | None = None
    for signal_id in cited_signal_ids:
        entry = corpus.get(signal_id)
        if entry is None:
            continue
        cited += 1
        raw_timestamp, text = entry
        chars += len(text.strip())
        when = parse_timestamp(raw_timestamp)
        if when is not None:
            age = (moment - when).total_seconds() / 3600.0
            oldest = age if oldest is None else max(oldest, age)
    return EvidenceRecord(cited_signals=cited, evidence_chars=chars, oldest_age_hours=oldest)


@dataclass(frozen=True)
class DataQualityFloor:
    """The gate itself. Frozen and parameterised so a run can say what floor
    it applied, and so a test can move a threshold without monkeypatching a
    module constant."""

    min_observation_age_hours: float = MIN_OBSERVATION_AGE_HOURS
    min_evidence_chars: int = MIN_EVIDENCE_CHARS

    def assess(self, subject: str, record: EvidenceRecord) -> FloorAssessment:
        # Sparseness first: it is measured directly, while youth depends on a
        # timestamp that may be unreadable. Order matters only for which
        # reason is reported, and reporting the measured one is more useful.
        if record.evidence_chars < self.min_evidence_chars:
            return FloorAssessment(
                subject=subject,
                passes=False,
                reason=(
                    f"{TOO_SPARSE} to judge: the cited evidence carries "
                    f"{record.evidence_chars} characters across {record.cited_signals} "
                    f"corpus row(s), under the {self.min_evidence_chars}-character "
                    "data-quality floor"
                ),
                record=record,
            )
        if (
            record.oldest_age_hours is not None
            and record.oldest_age_hours < self.min_observation_age_hours
        ):
            return FloorAssessment(
                subject=subject,
                passes=False,
                reason=(
                    f"{TOO_YOUNG} to judge: the whole cited record is "
                    f"{record.oldest_age_hours:.1f} hours old, under the "
                    f"{self.min_observation_age_hours:.0f}-hour data-quality floor"
                ),
                record=record,
            )
        return FloorAssessment(subject=subject, passes=True, reason=None, record=record)


def assess_floor(
    subject: str,
    cited_signal_ids: Sequence[str],
    corpus: Mapping[str, tuple[str | None, str]],
    *,
    floor: DataQualityFloor | None = None,
    now: datetime | None = None,
) -> FloorAssessment:
    """The floor, end to end, for one subject.

    Note the parameter list, which is the point of this module: a subject, the
    corpus rows it cited, the floor's thresholds, and a clock. There is no
    parameter for saturation, for confidence, or for anything else the model
    is supposed to weigh rather than have weighed for it.
    """
    active = floor or DataQualityFloor()
    return active.assess(subject, build_evidence_record(cited_signal_ids, corpus, now=now))
