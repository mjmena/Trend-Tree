"""Translates a Verdict into the write against FCT_PREDICTION_VERDICT_LEDGER
(sql/fct_prediction_verdict_ledger.sql). Pure string/dict construction -- no
I/O; the caller supplies the SnowflakeClient (see routes/run.py).
"""

from __future__ import annotations

import json
from typing import Any

from .claim import Verdict

# Bump when the verdict/evidence contract changes -- the DDL's
# COMPUTATION_VERSION column exists for exactly this lineage, and defaulting
# it server-side made every row's provenance a property of when it was
# inserted rather than of the code that produced it. Written explicitly.
COMPUTATION_VERSION = "v1"

# MERGE, not INSERT, and on a caller-supplied PREDICTION_EVAL_ID.
#
# The shared Snowflake client retries a call whose failure looks
# transport-shaped -- including the case where the statement *committed* and
# only the response was lost. A plain INSERT with the ledger's
# `DEFAULT UUID_STRING()` primary key then lands a second row for the same
# verdict, under a new id; Snowflake's PRIMARY KEY is informational and
# enforces nothing, so nothing downstream would catch it. Matching on an id
# the caller minted once makes the retry a no-op instead: exactly one row
# either way, and the affected-row count tells the caller which happened.
MERGE_VERDICT = """
MERGE INTO {table} AS ledger
USING (SELECT %(prediction_eval_id)s AS PREDICTION_EVAL_ID) AS incoming
  ON ledger.PREDICTION_EVAL_ID = incoming.PREDICTION_EVAL_ID
WHEN NOT MATCHED THEN INSERT (
  PREDICTION_EVAL_ID, PREDICTION_ID, CHAIN_ID,
  SUBJECT_DESCRIPTOR, DIRECTIONAL_CLAIM, HORIZON_AT, HORIZON_BAND,
  OBSERVABLE_CHECK, CONFIDENCE, PREDICTION_STATUS, MATCHED_TREND_ID, EVIDENCE,
  REASONING, WHAT_CHANGED, COMPUTATION_VERSION
) VALUES (
  %(prediction_eval_id)s, %(prediction_id)s, %(chain_id)s,
  %(subject_descriptor)s, %(directional_claim)s, %(horizon_at)s, %(horizon_band)s,
  %(observable_check)s, %(confidence)s, %(status)s,
  %(matched_trend_id)s, PARSE_JSON(%(evidence)s), %(reasoning)s, %(what_changed)s,
  %(computation_version)s
)
"""


def insert_params(verdict: Verdict) -> dict[str, Any]:
    return {
        "prediction_eval_id": verdict.prediction_eval_id,
        "prediction_id": verdict.prediction_id,
        "chain_id": verdict.chain_id,
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
        "computation_version": COMPUTATION_VERSION,
    }
