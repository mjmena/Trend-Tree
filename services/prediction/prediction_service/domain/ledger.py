"""Translates a Verdict into the INSERT against FCT_PREDICTION_VERDICT_LEDGER
(sql/fct_prediction_verdict_ledger.sql). Pure string/dict construction -- no
I/O; the caller supplies the SnowflakeClient (see routes/run.py).
"""

from __future__ import annotations

import json
from typing import Any

from .claim import Verdict

INSERT_VERDICT = """
INSERT INTO {table} (
  PREDICTION_ID, SUBJECT_DESCRIPTOR, DIRECTIONAL_CLAIM, HORIZON_AT, HORIZON_BAND,
  OBSERVABLE_CHECK, CONFIDENCE, PREDICTION_STATUS, MATCHED_TREND_ID, EVIDENCE,
  REASONING, WHAT_CHANGED
) SELECT
  %(prediction_id)s, %(subject_descriptor)s, %(directional_claim)s, %(horizon_at)s,
  %(horizon_band)s, %(observable_check)s, %(confidence)s, %(status)s,
  %(matched_trend_id)s, PARSE_JSON(%(evidence)s), %(reasoning)s, %(what_changed)s
"""


def insert_params(verdict: Verdict) -> dict[str, Any]:
    return {
        "prediction_id": verdict.prediction_id,
        "subject_descriptor": verdict.claim.subject_descriptor,
        "directional_claim": verdict.claim.directional_claim,
        "horizon_at": verdict.horizon_at,
        "horizon_band": verdict.claim.horizon_band,
        "observable_check": verdict.claim.observable_check,
        "confidence": verdict.confidence,
        "status": verdict.status,
        "matched_trend_id": verdict.matched_trend_id,
        "evidence": json.dumps(verdict.evidence),
        "reasoning": verdict.reasoning,
        "what_changed": verdict.what_changed,
    }
