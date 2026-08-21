"""The ``EVIDENCE.saturation`` payload -- pure construction, no I/O (CRMA-765).

The strategy's evidence contract names ``saturation`` as one of four required
keys: "Exploding Topics classification via ``descriptor.query`` + GDELT
article breadth". CRMA-763 shipped the key present-and-null because presence
is the contract; this module fills it in.

Two properties this module exists to hold:

* **It is additive.** ``attach_saturation`` returns a new evidence dict with
  ``saturation`` set and every other key -- ``source_signals``,
  ``trend_context``, ``coverage``, the ``generation`` provenance block --
  passed through untouched. A matched verdict and a white-space verdict carry
  saturation identically, because nothing here looks at whether the
  prediction matched a trend (AC1).
* **It records, it does not judge.** Every field is a reading. Nothing here
  computes a score, a penalty, or a flag derived from a classification.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .floor import FloorAssessment
from .lookup import ArticleBreadth, SaturationLookup

#: The evidence key this story owns. Named so the tests and the route can
#: refer to it without a bare string, and so grepping finds every writer.
SATURATION_KEY = "saturation"


def _jsonable(value: Any) -> Any:
    """ET returns nested maps of its own shape; keep them, but as plain
    JSON-safe containers so ``json.dumps`` in domain/ledger.py cannot fail on
    a live payload."""
    if isinstance(value, Mapping):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def et_evidence(lookup: SaturationLookup) -> dict[str, Any]:
    """One Exploding Topics reading, as the ledger records it.

    A miss is spelled out (``matched: false`` plus a ``miss_reason``) rather
    than left as an absent key: "ET does not know this subject" is a fact
    about the world worth reading, and the PRD is explicit that it is never a
    penalty.
    """
    return {
        "provider": "exploding_topics",
        "query": lookup.query,
        "matched": lookup.matched,
        "classification": lookup.classification,
        "classifications": _jsonable(lookup.classifications),
        "growth": _jsonable(lookup.growth),
        "matched_keyword": lookup.keyword,
        "path": lookup.path,
        "absolute_volume": lookup.absolute_volume,
        "result_count": lookup.total,
        "miss_reason": lookup.miss_reason,
        "error": lookup.error,
        # Said in the payload itself, so anyone reading a ledger row does not
        # have to know the strategy doc to read a miss correctly.
        "miss_carries_no_penalty": True,
    }


def breadth_evidence(reading: ArticleBreadth) -> dict[str, Any]:
    """One GDELT reading. ``available: false`` means "we could not look" --
    distinct from an available reading of zero articles, which means "we
    looked and nobody has written about this"."""
    return {
        "provider": "gdelt",
        "query": reading.query,
        "available": reading.available,
        "article_count": reading.article_count if reading.available else None,
        "distinct_domains": reading.distinct_domains if reading.available else None,
        "top_domains": list(reading.top_domains),
        "window_days": reading.window_days,
        "error": reading.error,
    }


def build_saturation_evidence(
    *,
    lookup: SaturationLookup,
    reading: ArticleBreadth,
    floor: FloorAssessment | None = None,
    weighing: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The whole ``EVIDENCE.saturation`` value for one verdict."""
    payload: dict[str, Any] = {
        "query": lookup.query or reading.query,
        "exploding_topics": et_evidence(lookup),
        "gdelt": breadth_evidence(reading),
    }
    if floor is not None:
        payload["data_quality_floor"] = floor.as_evidence()
    if weighing is not None:
        payload["weighing"] = dict(weighing)
    return payload


def attach_saturation(
    evidence: Mapping[str, Any], saturation: Mapping[str, Any]
) -> dict[str, Any]:
    """``evidence`` with ``saturation`` filled in and nothing else disturbed.

    Written as a merge rather than an edit to the evidence builder so that the
    matching phase's ``trend_context`` and the coverage detector's
    ``coverage`` can land in the same dict without either story having to
    reorganise the others' keys.
    """
    merged = dict(evidence)
    merged[SATURATION_KEY] = dict(saturation)
    return merged
