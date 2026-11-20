"""Exercise both deployed candidate INSERTs against session-local Snowflake tables."""

import json
import re
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def candidate_inserts():
    workflow = (ROOT / "distillation-p_mkCBBqb/workflow.yaml").read_text()
    step = workflow.split("- namespace: commit_candidates\n", 1)[1].split(
        "\n- namespace:", 1
    )[0]
    copies = re.findall(r"      (?:value|query): \|-\n((?:        .*\n)+)", step)
    if len(copies) != 2 or copies[0] != copies[1]:
        raise ValueError("Expected identical value/query copies of commit_candidates")
    yield "distillation", textwrap.dedent(copies[0]).strip()

    revisit = (
        ROOT / "distillation-revisit-p_o7CWWZl/commit_batch_result/entry.mjs"
    ).read_text()
    match = re.search(r"const INSERT_CANDIDATES_SQL = `([^`]+)`;", revisit)
    if match is None:
        raise ValueError("Missing revisit INSERT")
    yield "revisit", match[1].strip()


def build_fixture():
    fixture = """
CREATE OR REPLACE TEMPORARY TABLE _COMMIT_SIGNALS (
  SIGNAL_ID STRING, SOURCE_NAME STRING
);
INSERT INTO _COMMIT_SIGNALS VALUES ('signal-a', 'bluesky'), ('signal-b', 'gdelt');
CREATE OR REPLACE TEMPORARY TABLE _COMMIT_EXTERNAL_SIGNALS AS
SELECT * FROM _COMMIT_SIGNALS;
INSERT INTO _COMMIT_EXTERNAL_SIGNALS VALUES ('raw-only', 'bluesky');
CREATE OR REPLACE TEMPORARY TABLE _COMMIT_CANDIDATES (
  CANDIDATE_ID STRING, AGENT_SESSION_ID STRING, CHAIN_ID STRING, ITERATION NUMBER,
  TOPIC STRING, QUERY STRING, SUPPORTING_SIGNAL_IDS ARRAY, CONFIDENCE FLOAT,
  SPECIFICITY_SCORE FLOAT, SOURCE_BREAKDOWN OBJECT, BUCKET STRING, VERDICT STRING,
  EVIDENCE_ADDED VARIANT, REASONING STRING, REASONING_TRACE VARIANT,
  DEDUP_OF_TREND_ID STRING
);
CREATE OR REPLACE TEMPORARY TABLE _COMMIT_CHECKS (WRITER STRING, CHECK_NAME STRING, PASS BOOLEAN);
"""
    inputs = [
        {"candidate_id": "empty", "supporting_signal_ids": []},
        {"candidate_id": "null", "supporting_signal_ids": None},
        {"candidate_id": "missing"},
        {"candidate_id": "invalid", "supporting_signal_ids": ["invented"]},
        {"candidate_id": "raw", "supporting_signal_ids": ["raw-only"]},
        {"candidate_id": "mixed", "supporting_signal_ids": ["signal-a", "invented", "signal-a"]},
        {"candidate_id": "valid", "supporting_signal_ids": ["signal-b", "signal-a"]},
    ]
    for candidate in inputs:
        candidate.update(query="mushroom coffee", reasoning="Independent reports")
    payload = "'" + json.dumps(inputs).replace("'", "''") + "'"

    for name, sql in candidate_inserts():
        sql = sql.replace("MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES", "_COMMIT_CANDIDATES")
        sql = sql.replace("MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS", "_COMMIT_SIGNALS")
        sql = sql.replace("MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS", "_COMMIT_EXTERNAL_SIGNALS")
        if re.search(r"\bMCC_[A-Z_]+\.", sql):
            raise ValueError("Fixture still references a production database")

        fixture += "\nTRUNCATE TABLE _COMMIT_CANDIDATES;\n"
        fixture += sql.replace(":1", payload).replace("?", payload) + ";\n"
        fixture += f"""
INSERT INTO _COMMIT_CHECKS
SELECT '{name}', 'drops every candidate without resolvable evidence',
       (SELECT COUNT(*) FROM _COMMIT_CANDIDATES) = 2
       AND NOT EXISTS (SELECT 1 FROM _COMMIT_CANDIDATES WHERE CANDIDATE_ID NOT IN ('mixed', 'valid'))
UNION ALL
SELECT '{name}', 'keeps one surviving signal and removes invalid or duplicate IDs',
       (SELECT COUNT(*) FROM _COMMIT_CANDIDATES WHERE CANDIDATE_ID = 'mixed'
        AND SUPPORTING_SIGNAL_IDS = PARSE_JSON('["signal-a"]')
        AND SOURCE_BREAKDOWN = PARSE_JSON('{{"bluesky":1}}')) = 1
UNION ALL
SELECT '{name}', 'preserves valid evidence and recomputes source breakdown',
       (SELECT COUNT(*) FROM _COMMIT_CANDIDATES WHERE CANDIDATE_ID = 'valid'
        AND SUPPORTING_SIGNAL_IDS = PARSE_JSON('["signal-a","signal-b"]')
        AND SOURCE_BREAKDOWN = PARSE_JSON('{{"bluesky":1,"gdelt":1}}')
        AND QUERY = 'mushroom coffee' AND REASONING = 'Independent reports') = 1;
"""
        fixture += "TRUNCATE TABLE _COMMIT_CANDIDATES;\n"
        fixture += sql.replace(":1", "'[]'").replace("?", "'[]'") + ";\n"
        fixture += f"""
INSERT INTO _COMMIT_CHECKS
SELECT '{name}', 'empty batch is a no-op', (SELECT COUNT(*) FROM _COMMIT_CANDIDATES) = 0;
"""
    fixture += """
SELECT * FROM _COMMIT_CHECKS ORDER BY WRITER, CHECK_NAME;
SELECT 1 / IFF(COUNT_IF(NOT PASS OR PASS IS NULL) = 0, 1, 0) AS ALL_CHECKS_PASSED
FROM _COMMIT_CHECKS;
"""
    return fixture


if __name__ == "__main__":
    print(build_fixture())
