"""Run the production selection SQL over synthetic rows in Snowflake.

Set PREDICTION_TEST_SNOWFLAKE_CONNECTION to a configured Snowflake CLI connection.
The ledger name is shadowed by a CTE; these tests read no production tables.
"""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from prediction_service.matching.predictions import (
    LIVE_STATUSES,
    VERDICT_LEDGER_TABLE,
    SnowflakeOpenPredictionReader,
)

from .matching_fakes import open_prediction_row

CONNECTION = os.environ.get("PREDICTION_TEST_SNOWFLAKE_CONNECTION")
pytestmark = pytest.mark.skipif(not CONNECTION, reason="requires a Snowflake test connection")


class SyntheticLedger:
    def __init__(self, rows):
        self.rows = [{**row, "EVIDENCE": json.loads(row["EVIDENCE"])} for row in rows]

    def query(self, sql, params=None):
        assert sql.count("WITH LATEST AS") == 1
        assert f"FROM {VERDICT_LEDGER_TABLE}\n" in sql
        columns = {
            **{column: "STRING" for column in open_prediction_row()},
            "CONFIDENCE": "FLOAT",
            "HORIZON_AT": "TIMESTAMP_NTZ",
            "EVALUATED_AT": "TIMESTAMP_NTZ",
            "EVIDENCE": "VARIANT",
            "ANGLE": "STRING",
            "AUDIENCE_QUESTION": "STRING",
        }
        projection = ", ".join(
            f"VALUE:{column}::{kind} AS {column}" for column, kind in columns.items()
        )
        payload = json.dumps(self.rows).replace("'", "''")
        fixture = (
            f"{VERDICT_LEDGER_TABLE} AS (SELECT {projection} "
            f"FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{payload}')))),"
        )
        statement = sql.replace("WITH LATEST AS", f"WITH {fixture} LATEST AS", 1)
        statement %= {
            key: "NULL" if value is None else (
                str(value) if isinstance(value, int) else "'" + value.replace("'", "''") + "'"
            )
            for key, value in (params or {}).items()
        }
        result = subprocess.run(
            ["snow", "sql", "-c", CONNECTION, "-q", statement,
             "--format", "json", "--enable-templating", "NONE"],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        return json.loads(result.stdout)


def _selected(rows, *, limit=50):
    reader = SnowflakeOpenPredictionReader(SyntheticLedger(rows), statuses=LIVE_STATUSES)
    selected = reader.open_predictions(limit=limit)
    assert not reader.unreadable
    return [prediction.prediction_id for prediction in selected]


def test_fifty_final_expired_predictions_do_not_starve_an_active_prediction():
    final_rows = [
        open_prediction_row(
            prediction_id=f"final-{index}",
            status="EXPIRED",
            evidence={"reevaluation": {"final_evaluation": True}},
        )
        for index in range(50)
    ]
    active = open_prediction_row(prediction_id="active")
    active["EVALUATED_AT"] = "2026-08-21 14:02:00.000"

    assert _selected([*final_rows, active]) == ["active"]


def test_expired_predictions_without_a_final_grade_still_get_evaluated():
    evidence = [
        {},
        {"reevaluation": {}},
        {"reevaluation": {"final_evaluation": None}},
        {"reevaluation": {"final_evaluation": False}},
    ]
    rows = [
        open_prediction_row(prediction_id=f"eligible-{index}", status="EXPIRED", evidence=value)
        for index, value in enumerate(evidence)
    ]

    assert _selected(rows) == [f"eligible-{index}" for index in range(len(rows))]


def test_a_final_latest_row_does_not_resurrect_an_older_active_grade():
    older = open_prediction_row(prediction_id="finished")
    final = open_prediction_row(
        prediction_id="finished",
        status="EXPIRED",
        evidence={"reevaluation": {"final_evaluation": True}},
    )
    final["EVALUATED_AT"] = "2026-08-21 14:02:00.000"

    assert _selected([older, final]) == []
