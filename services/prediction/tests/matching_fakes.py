"""Fakes for the matching phase (CRMA-764).

Kept out of tests/fakes.py on purpose: the compare step issues four
*different* statements in one run, so it needs a warehouse stand-in that
answers by statement rather than one that returns the same rows to every
query.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from prediction_service.matching.trends import TrendCandidate, TrendContext
from prediction_service.strategist import LABEL_TABLE

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


@dataclass
class LedgerSimulator(RoutingFakeSnowflake):
    """A verdict ledger that actually behaves like one.

    ``RoutingFakeSnowflake`` returns a fixed list to every open-prediction
    read, which cannot show what happens across *runs*. This one keeps rows,
    appends what the route MERGEs, and answers the open-prediction read the
    way the ledger does: latest row per PREDICTION_ID, ACTIVE only, ordered
    and capped.

    The sort direction is read out of the statement rather than assumed, so a
    test written against it fails if the ORDER BY is flipped -- which is the
    whole point of the starvation test in tests/test_match_route.py.
    """

    rows: list[dict[str, Any]] = field(default_factory=list)
    #: LABEL_IDs already in the calibration label table, so a re-read of a
    #: standing decision MERGEs rather than appending a row per sweep.
    label_ids: set[str] = field(default_factory=set)
    fail_labels_with: Exception | None = None

    _ORDER_BY = re.compile(
        r"ORDER BY\s+EVALUATED_AT\s+(ASC|DESC)\s*,\s*PREDICTION_EVAL_ID\s+(ASC|DESC)\s*\n?LIMIT",
        re.IGNORECASE,
    )

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        if "FCT_PREDICTION_VERDICT_LEDGER" not in sql.upper():
            return super().query(sql, params)
        self.calls.append(RecordedCall(sql, params, kind="query"))

        match = self._ORDER_BY.search(sql)
        assert match, f"the open-prediction read must order before it caps: {sql[-200:]}"
        newest_first = match.group(1).upper() == "DESC"

        latest: dict[str, dict[str, Any]] = {}
        for row in self.rows:
            key = str(row["PREDICTION_ID"])
            current = latest.get(key)
            if current is None or _sort_key(row) > _sort_key(current):
                latest[key] = row

        # The statuses the reader asked for, read off the bind rather than
        # assumed: the compare step asks for ACTIVE, the re-evaluation sweep
        # asks for ACTIVE plus EXPIRED, and a simulator that always filtered
        # to ACTIVE would silently hide the grace window from every sweep
        # test.
        wanted = {
            str(status).upper()
            for status in json.loads(str((params or {}).get("statuses") or '["ACTIVE"]'))
        }
        # The capped-scope filter is in the STATEMENT (CRMA-766), so the
        # simulator has to honour it -- otherwise a route test asserting
        # single-prediction mode would be exercising a client-side backstop
        # rather than the read the deployed service issues.
        raw_ids = (params or {}).get("prediction_ids")
        wanted_ids = {str(pid) for pid in json.loads(str(raw_ids))} if raw_ids else None
        live = [
            row
            for row in latest.values()
            if str(row.get("PREDICTION_STATUS") or "").upper() in wanted
            and (wanted_ids is None or str(row["PREDICTION_ID"]) in wanted_ids)
        ]
        live.sort(key=_sort_key, reverse=newest_first)
        limit = int((params or {}).get("prediction_limit", len(live)))
        return [dict(row) for row in live[:limit]]

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        # The calibration label tier writes to its own table (CRMA-768) and
        # is not a verdict row -- routed before the append below, which reads
        # the verdict MERGE's bind names.
        if LABEL_TABLE in sql.upper():
            self.calls.append(RecordedCall(sql, params, kind="execute"))
            if self.fail_labels_with:
                raise self.fail_labels_with
            label_id = str((params or {}).get("label_id"))
            if label_id in self.label_ids:
                # WHEN NOT MATCHED THEN INSERT: a standing decision re-read on
                # a later sweep MERGEs into the row it already wrote.
                return 0
            self.label_ids.add(label_id)
            return 1
        rowcount = super().execute(sql, params)
        bound = dict(params or {})
        if rowcount == 0:
            # WHEN NOT MATCHED THEN INSERT: a MERGE that matched inserts
            # nothing. A simulator that appended anyway would hide exactly the
            # double-write a retry is supposed to be safe against.
            return rowcount
        self.rows.append(
            {
                "PREDICTION_ID": bound["prediction_id"],
                "PREDICTION_EVAL_ID": bound["prediction_eval_id"],
                "SUBJECT_DESCRIPTOR": bound["subject_descriptor"],
                "DIRECTIONAL_CLAIM": bound["directional_claim"],
                "HORIZON_BAND": bound["horizon_band"],
                "HORIZON_AT": bound["horizon_at"],
                "OBSERVABLE_CHECK": bound["observable_check"],
                "CONFIDENCE": bound["confidence"],
                "PREDICTION_STATUS": bound["status"],
                "MATCHED_TREND_ID": bound["matched_trend_id"],
                "EVIDENCE": bound["evidence"],
                "REASONING": bound["reasoning"],
                # The column this service now writes rather than defaults --
                # which is also what lets a later run see this evaluation.
                "EVALUATED_AT": bound["evaluated_at"],
            }
        )
        return rowcount


def _sort_key(row: Mapping[str, Any]) -> tuple[Any, str]:
    evaluated = row.get("EVALUATED_AT")
    if isinstance(evaluated, str):
        evaluated = datetime.fromisoformat(evaluated).replace(tzinfo=UTC)
    return (evaluated, str(row.get("PREDICTION_EVAL_ID") or ""))
