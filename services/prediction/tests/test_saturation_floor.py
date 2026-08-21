"""The data-quality floor -- the pillar's one permitted mechanical gate
(CRMA-765 AC4, and half of AC5).

Two things get asserted here and nowhere else:

1. **What it skips.** Too young and too sparse, measured on the observation
   record behind a subject, with a reason a human can read.
2. **What it cannot see.** ``assess_floor``'s parameter list is asserted the
   way tests/test_blindness.py asserts ``generate_predictions``' -- there is
   no parameter through which an Exploding Topics classification, a GDELT
   reading or a confidence could enter the one place in this pillar that is
   allowed to drop a candidate.
"""

from __future__ import annotations

import inspect
import io
import tokenize
from datetime import UTC, datetime, timedelta
from pathlib import Path

from prediction_service.saturation import floor as floor_module
from prediction_service.saturation.floor import (
    MIN_EVIDENCE_CHARS,
    MIN_OBSERVATION_AGE_HOURS,
    TOO_SPARSE,
    TOO_YOUNG,
    DataQualityFloor,
    assess_floor,
    build_evidence_record,
    parse_timestamp,
)

NOW = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)
RICH = "x" * 400


def _at(hours_ago: float) -> str:
    return (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%d %H:%M:%S.%f")


def test_a_week_old_multi_signal_record_clears_the_floor():
    corpus = {"a": (_at(72), RICH), "b": (_at(120), RICH)}

    assessment = assess_floor("rucking vests", ["a", "b"], corpus, now=NOW)

    assert assessment.passes is True
    assert assessment.reason is None
    assert assessment.record.cited_signals == 2
    assert assessment.record.oldest_age_hours == 120


def test_one_substantive_signal_clears_the_floor():
    # Load-bearing: the strategy's "high-potential single signal" emergence
    # path says one strong signal is emittable, so the floor is a floor on
    # SUBSTANCE, never on count. A count-based floor would silently contradict
    # the generation prompt.
    corpus = {"a": (_at(96), RICH)}

    assert assess_floor("head spa", ["a"], corpus, now=NOW).passes is True


def test_a_record_of_query_strings_is_too_sparse_to_judge():
    # The thin end of the live corpus: google_trends_explore rows run to a
    # 34-character minimum and a 64-character median. A claim resting on a
    # handful of those is unjudgeable on data-quality grounds.
    corpus = {"a": (_at(96), "rucking vest | breakout"), "b": (_at(120), "rucking | rising")}

    assessment = assess_floor("rucking vests", ["a", "b"], corpus, now=NOW)

    assert assessment.passes is False
    assert TOO_SPARSE in assessment.reason
    assert str(MIN_EVIDENCE_CHARS) in assessment.reason


def test_a_record_entirely_inside_one_day_is_too_young_to_judge():
    # The corpus read stratifies by (source x calendar day), so a record whose
    # oldest row is under 24 hours old sits in a single source-day cell by
    # construction and cannot show persistence across even two days.
    corpus = {"a": (_at(2), RICH), "b": (_at(9), RICH)}

    assessment = assess_floor("rucking vests", ["a", "b"], corpus, now=NOW)

    assert assessment.passes is False
    assert TOO_YOUNG in assessment.reason


def test_one_older_signal_is_enough_for_the_record_not_to_be_young():
    corpus = {"a": (_at(2), RICH), "b": (_at(30), RICH)}

    assert assess_floor("rucking vests", ["a", "b"], corpus, now=NOW).passes is True


def test_an_unreadable_timestamp_reads_as_unknown_never_as_young():
    # The floor fails open on what it cannot measure. A gate that dropped
    # candidates because of a defect in its own inputs would be a gate
    # wearing a floor's clothes.
    corpus = {"a": (None, RICH), "b": ("not a timestamp", RICH)}

    assessment = assess_floor("rucking vests", ["a", "b"], corpus, now=NOW)

    assert assessment.passes is True
    assert assessment.record.oldest_age_hours is None


def test_a_cited_id_the_corpus_does_not_carry_contributes_nothing():
    corpus = {"a": (_at(96), RICH)}

    record = build_evidence_record(["a", "ghost"], corpus, now=NOW)

    assert record.cited_signals == 1


def test_the_thresholds_are_settings_not_constants():
    corpus = {"a": (_at(2), "short")}

    assert assess_floor("x", ["a"], corpus, now=NOW).passes is False
    relaxed = DataQualityFloor(min_observation_age_hours=0, min_evidence_chars=0)
    assert assess_floor("x", ["a"], corpus, floor=relaxed, now=NOW).passes is True


def test_the_defaults_are_the_documented_ones():
    floor = DataQualityFloor()

    assert floor.min_observation_age_hours == MIN_OBSERVATION_AGE_HOURS == 24.0
    assert floor.min_evidence_chars == MIN_EVIDENCE_CHARS == 120


def test_the_floor_records_what_it_measured_for_the_ledger():
    corpus = {"a": (_at(96), RICH)}

    evidence = assess_floor("head spa", ["a"], corpus, now=NOW).as_evidence()

    assert evidence == {
        "passes": True,
        "reason": None,
        "cited_signals": 1,
        "evidence_chars": 400,
        "oldest_evidence_age_hours": 96.0,
    }


def test_the_gate_cannot_see_saturation_confidence_or_a_claim():
    # The structural half of AC5. This is the pillar's ONE mechanical gate,
    # so what it is able to look at is the whole question. Widening this
    # signature is a visible diff and a failing test.
    params = inspect.signature(assess_floor).parameters

    assert set(params) == {"subject", "cited_signal_ids", "corpus", "floor", "now"}
    assert set(inspect.signature(DataQualityFloor.assess).parameters) == {
        "self",
        "subject",
        "record",
    }
    assert set(inspect.signature(floor_module.EvidenceRecord).parameters) == {
        "cited_signals",
        "evidence_chars",
        "oldest_age_hours",
    }


def _executable_source(path: Path) -> str:
    """``path``'s source with comments and string literals removed, so prose
    that *describes* the invariant is not mistaken for code that violates it.
    Same technique tests/test_blindness.py uses on the generation package."""
    kept: list[str] = []
    with open(path, "rb") as handle:
        for token in tokenize.tokenize(io.BytesIO(handle.read()).readline):
            if token.type in (tokenize.COMMENT, tokenize.STRING):
                continue
            kept.append(token.string)
    return " ".join(kept)


def test_the_floor_module_never_names_the_oracles_it_must_not_consult():
    # The complement of the signature check: not just "no parameter for it"
    # but "no mention of it in code at all". The module docstring explains at
    # length WHY the floor must not weigh saturation; that prose is stripped
    # first, so only executable text is measured.
    body = _executable_source(Path(floor_module.__file__)).lower()

    for forbidden in ("exploding", "gdelt", "classification", "confidence", "breadth"):
        assert forbidden not in body, forbidden


def test_timestamps_parse_in_the_shapes_the_corpus_actually_produces():
    for raw in (
        "2026-08-21 12:00:00.000",
        "2026-08-21 12:00:00",
        "2026-08-21T12:00:00+00:00",
        "2026-08-21T12:00:00Z",
    ):
        assert parse_timestamp(raw) == NOW
    assert parse_timestamp(None) is None
    assert parse_timestamp("  ") is None
    assert parse_timestamp("last tuesday") is None
