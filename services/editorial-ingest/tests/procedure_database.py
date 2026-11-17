"""Run the deployed receipt procedure against a transactional local SQL engine.

This covers procedure state and rollback through the production adapter. Native
Snowflake lock behavior is a separate isolated-schema release check.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

SQL_PATH = Path(__file__).resolve().parents[3] / "sql" / "stg_editorial_nominations.sql"


class Row(dict):
    def as_dict(self):
        return dict(self)

    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


class Statement:
    def __init__(self, conn, sql, params):
        self.conn, self.sql, self.params = conn, sql, params

    def collect(self):
        if "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS" in self.sql:
            return [Row(result={"signals": len(json.loads(self.params[0]))})]
        sql = self.sql.replace("MCC_RAW.MARKETING_DEV.", "")
        sql = sql.replace("MCC_PRESENTATION.TREND_AGENT.", "")
        sql = sql.replace("CURRENT_TIMESTAMP()", "CURRENT_TIMESTAMP")
        sql = re.sub(
            r"DATEADD\(second, (\d+), CURRENT_TIMESTAMP\)",
            r"datetime(CURRENT_TIMESTAMP, '+\1 seconds')",
            sql,
        )
        cursor = self.conn.execute(sql, self.params)
        if cursor.description:
            return [
                Row(zip([c[0] for c in cursor.description], row, strict=True)) for row in cursor
            ]
        return [Row(affected=max(0, cursor.rowcount))]


class Session:
    def __init__(self, conn):
        self.conn = conn

    def sql(self, sql, params=None):
        return Statement(self.conn, sql, params or [])


class ProcedureDatabase:
    def __init__(self, path):
        self.path = path
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE STG_EDITORIAL_NOMINATION_MUTEX (LOCK_ID INTEGER, REVISION INTEGER);
                INSERT INTO STG_EDITORIAL_NOMINATION_MUTEX VALUES (1, 0);
                CREATE TABLE STG_EDITORIAL_NOMINATIONS (
                    NOMINATION_ID TEXT, REQUEST TEXT, DROPPED_URLS TEXT,
                    STATUS TEXT DEFAULT 'pending', RESULT TEXT, PLAN TEXT,
                    CREATED_AT TEXT DEFAULT CURRENT_TIMESTAMP,
                    UPDATED_AT TEXT DEFAULT CURRENT_TIMESTAMP,
                    OWNER TEXT, LEASE_UNTIL TEXT, QUEUE_CONFIRMED_AT TEXT,
                    ATTEMPT_COUNT INTEGER DEFAULT 0
                );
                CREATE TABLE FCT_TREND_LIFECYCLE_LEDGER (
                    TREND_ID TEXT, AGENT_SESSION_ID TEXT, CHAIN_ID TEXT,
                    PRIOR_STATUS TEXT, NEW_STATUS TEXT, PRIOR_HEAT REAL, NEW_HEAT REAL,
                    NEW_HEAT_SMOOTHED REAL, HEAT_BASE REAL, HEAT_MODIFIER_PCT REAL,
                    REASONING TEXT, DECISION_PAYLOAD TEXT, MODEL_USED TEXT,
                    NEXT_EVAL_AT TEXT, EVALUATED_AT TEXT DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE STG_TREND_CANDIDATES (
                    CANDIDATE_ID TEXT, TOPIC TEXT, PROMOTED_AT TEXT,
                    PROMOTED_TO TEXT, DEDUP_OF_TREND_ID TEXT,
                    AGENT_SESSION_ID TEXT, CHAIN_ID TEXT, ITERATION INTEGER,
                    SUPPORTING_SIGNAL_IDS TEXT, SOURCE_BREAKDOWN TEXT, REASONING TEXT,
                    CONFIDENCE REAL
                );
            """)

    def connect(self):
        conn = sqlite3.connect(self.path, isolation_level=None, timeout=10)
        conn.create_function("PARSE_JSON", 1, lambda value: value)
        conn.create_function(
            "ARRAY_SIZE", 1, lambda value: len(json.loads(value)) if value else None
        )
        conn.create_function(
            "OBJECT_KEYS", 1, lambda value: json.dumps(list(json.loads(value))) if value else None
        )
        return conn

    def query(self, sql, params=None):
        namespace = {}
        if "PROC_PROMOTION_APPLY" in sql:
            path = SQL_PATH.with_name("proc_promotion_apply.sql")
            exec(path.read_text().split("$$")[1], namespace)
            with self.connect() as conn:
                result = namespace["run"](
                    Session(conn),
                    json.loads(params["decisions"]),
                    params["chain"],
                    1,
                )
            return [{"PROC_PROMOTION_APPLY": result}]
        exec(SQL_PATH.read_text().split("$$")[1], namespace)
        with self.connect() as conn:
            result = namespace["run"](
                Session(conn),
                params["operation"],
                params["id"],
                json.loads(params["data"]),
            )
        return [{"PROC_EDITORIAL_NOMINATION": result}]
