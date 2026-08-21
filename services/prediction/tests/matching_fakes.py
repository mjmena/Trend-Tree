"""Fakes for the matching phase (CRMA-764).

Kept out of tests/fakes.py on purpose: the compare step issues four
*different* statements in one run, so it needs a warehouse stand-in that
answers by statement rather than one that returns the same rows to every
query.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from prediction_service.matching.trends import TrendCandidate, TrendContext

from .fakes import RecordedCall

#: The fixture trend the route tests match against.
TREND_ID = "3956205c-8896-4184-9e2c-f4b70f8e9b9c"
OTHER_TREND_ID = "b6a1f0d2-4c3e-4b7a-9f11-2d8c5e6a7b40"

DESCRIPTOR_ROWS: list[dict[str, Any]] = [
    {
        "TREND_ID": TREND_ID,
        "TREND_TOPIC": "Rucking as everyday exercise",
        "DESCRIPTOR_QUERY": "rucking vest",
        "DESCRIPTOR_STATEMENT": "Adults wear weighted vests on ordinary walks.",
    },
    {
        "TREND_ID": OTHER_TREND_ID,
        "TREND_TOPIC": "Probiotic body sprays",
        "DESCRIPTOR_QUERY": "probiotic body spray",
        "DESCRIPTOR_STATEMENT": "Live-culture sprays replace conventional cleansers.",
    },
]

#: What the cosine leg returns per subject, best first. Keyed on the exact
#: subject string the prediction carries.
CANDIDATE_ROWS: dict[str, list[dict[str, Any]]] = {
    "rucking vests": [
        {**DESCRIPTOR_ROWS[0], "SIMILARITY": 0.7421},
        {**DESCRIPTOR_ROWS[1], "SIMILARITY": 0.0912},
    ],
    "probiotic nasal spray": [
        {**DESCRIPTOR_ROWS[1], "SIMILARITY": 0.5699},
        {**DESCRIPTOR_ROWS[0], "SIMILARITY": 0.1204},
    ],
}

CONTEXT_ROW: dict[str, Any] = {
    "TREND_ID": TREND_ID,
    "TREND_TOPIC": "Rucking as everyday exercise",
    "LIFECYCLE_STATUS": "GROWING",
    "HEAT_INDEX": 46.0,
    "HEAT_7D_AGO": 41.0,
    "HEAT_14D_AGO": 39.0,
    "ACCELERATION": 3.0,
    "LINKED_SIGNALS_TOTAL": 11,
    "LINKED_SIGNALS_ADDED_7D": 4,
    "DISTINCT_SOURCES_TOTAL": 5,
    "DISTINCT_SOURCES_ADDED_7D": 2,
    "AGE_DAYS": 31,
}


def open_prediction_row(
    *,
    prediction_id: str = "814a38cb-3935-4ce2-b640-b3154bfa84f4",
    subject: str = "rucking vests",
    confidence: float = 68.0,
    status: str = "ACTIVE",
    evidence: dict[str, Any] | None = None,
    reasoning: str = "Four independent sources converge on the same behaviour.",
) -> dict[str, Any]:
    return {
        "PREDICTION_ID": prediction_id,
        "PREDICTION_EVAL_ID": f"prior-{prediction_id}",
        "SUBJECT_DESCRIPTOR": subject,
        "DIRECTIONAL_CLAIM": "mainstream retail adoption expands beyond specialty fitness",
        "HORIZON_BAND": "emerging_3_6mo",
        "HORIZON_AT": "2027-02-14 00:00:00.000",
        "OBSERVABLE_CHECK": "house-label listings at two of three mass retailers",
        "CONFIDENCE": confidence,
        "PREDICTION_STATUS": status,
        "MATCHED_TREND_ID": None,
        # The connector hands a VARIANT back as JSON text; the fake does too.
        "EVIDENCE": json.dumps(
            evidence
            if evidence is not None
            else {
                "source_signals": ["bluesky:3lqz7a2xk4d2m"],
                "saturation": None,
                "trend_context": None,
                "coverage": None,
            }
        ),
        "REASONING": reasoning,
        "EVALUATED_AT": "2026-08-20 14:02:00.000",
    }


@dataclass
class RoutingFakeSnowflake:
    """A warehouse stand-in that answers by which statement it was handed.

    Matching on a table name rather than on call order: the compare step
    reads the descriptor index once and then one candidate query per
    prediction, so an ordered script would encode the loop's shape into every
    test.
    """

    predictions: list[dict[str, Any]] = field(default_factory=list)
    descriptors: list[dict[str, Any]] = field(default_factory=lambda: list(DESCRIPTOR_ROWS))
    candidates: dict[str, list[dict[str, Any]]] = field(
        default_factory=lambda: {k: list(v) for k, v in CANDIDATE_ROWS.items()}
    )
    contexts: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {TREND_ID: dict(CONTEXT_ROW)}
    )
    calls: list[RecordedCall] = field(default_factory=list)
    fail_with: Exception | None = None
    rowcount: int = 1

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        self.calls.append(RecordedCall(sql, params, kind="query"))
        upper = sql.upper()
        if "FCT_PREDICTION_VERDICT_LEDGER" in upper:
            return list(self.predictions)
        if "EMBED_TEXT_1024" in upper:
            subject = (params or {}).get("subject", "")
            return list(self.candidates.get(str(subject), []))
        if "PAYLOAD:DESCRIPTOR:QUERY" in upper:
            return list(self.descriptors)
        if "DATEDIFF" in upper:
            trend_id = str((params or {}).get("trend_id", ""))
            row = self.contexts.get(trend_id)
            return [dict(row)] if row else []
        raise AssertionError(f"unexpected statement: {sql[:160]}")

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        self.calls.append(RecordedCall(sql, params, kind="execute"))
        if self.fail_with:
            raise self.fail_with
        return self.rowcount

    @property
    def writes(self) -> list[RecordedCall]:
        return [call for call in self.calls if call.kind == "execute"]

    @property
    def reads(self) -> list[RecordedCall]:
        return [call for call in self.calls if call.kind == "query"]


@dataclass
class RecordingTrendReader:
    """A ``TrendReader`` that records the order it was asked in.

    The compare step's central claim is that a match is decided before any
    context is read, so "which call came first" is the assertion, not an
    implementation detail.
    """

    descriptors: Sequence[TrendCandidate] = ()
    candidates: Mapping[str, Sequence[TrendCandidate]] = field(default_factory=dict)
    contexts: Mapping[str, TrendContext] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)

    def descriptor_index(self) -> list[TrendCandidate]:
        self.calls.append(("descriptor_index", ""))
        return list(self.descriptors)

    def candidates_for(self, subject: str, *, limit: int = 10) -> list[TrendCandidate]:
        self.calls.append(("candidates_for", subject))
        return list(self.candidates.get(subject, ()))[:limit]

    def context_for(self, trend_id: str) -> TrendContext | None:
        self.calls.append(("context_for", trend_id))
        return self.contexts.get(trend_id)
