"""Emit native Snowflake checks for an isolated schema; never execute SQL.

Run this script into a temporary file, then pass that file to Snowflake with
an explicit test database/schema. Only temporary fixture objects are created.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VIEW = "MCC_PRESENTATION.TREND_AGENT.V_EDITORIAL_NOMINATION_SIGNALS"
RECEIPTS = "MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATIONS"


def build_fixture() -> str:
    ddl = (ROOT / "sql/v_editorial_nomination_signals.sql").read_text()
    create = re.search(r"CREATE OR REPLACE SECURE VIEW\b[^;]+;", ddl, flags=re.DOTALL)
    if create is None:
        raise ValueError("Expected a secure view definition")

    # Reuse the deployed projection while isolating its objects and grants.
    fixture_view = create.group().replace(
        f"CREATE OR REPLACE SECURE VIEW {VIEW}",
        "CREATE OR REPLACE SECURE TEMPORARY VIEW _EDITORIAL_NOMINATION_SIGNALS_FIXTURE",
    )
    fixture_view = fixture_view.replace(RECEIPTS, "_EDITORIAL_NOMINATIONS_FIXTURE")
    fixture_view = re.sub(r"\bCOPY\s+GRANTS\b", "", fixture_view)
    if re.search(r"\bMCC_[A-Z_]+\.", fixture_view):
        raise ValueError("Fixture projection still references a production database")

    fixture = (ROOT / "test/editorial_nomination_signals.test.sql").read_text()
    return fixture.replace("-- VIEW_UNDER_TEST", fixture_view)


if __name__ == "__main__":
    print(build_fixture())
