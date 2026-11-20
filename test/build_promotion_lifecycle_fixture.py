"""Build anonymous procedure calls that write only to temporary fixture tables."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TABLES = {
    "MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES": "_zz_apply_candidates",
    "MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS": "_zz_apply_trends",
    "MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER": "_zz_apply_audit",
    "MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER": "_zz_apply_lifecycle",
    "MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER": "_zz_apply_enrichment",
    "MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ET_LEDGER": "_zz_apply_et",
    "MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATION_MUTEX": "_zz_apply_mutex",
    "MCC_RAW.MARKETING_DEV.STG_EDITORIAL_NOMINATIONS": "_zz_apply_nominations",
}


def anonymous_procedure(kind: str) -> str:
    source = (ROOT / f"sql/proc_{kind}_apply.sql").read_text()
    name = f"MCC_RAW.MARKETING_DEV.PROC_{kind.upper()}_APPLY"
    statement = source[source.index(f"CREATE OR REPLACE PROCEDURE {name}"):].strip()
    if not statement.endswith("$$;") or statement.count("$$") != 2:
        raise ValueError("Expected one dollar-quoted procedure definition")
    statement = statement[:-1].replace(
        f"CREATE OR REPLACE PROCEDURE {name}", f"WITH {kind}_fixture AS PROCEDURE", 1,
    )
    statement = statement.replace("COPY GRANTS\n", "").replace("EXECUTE AS CALLER\n", "")
    for table, fixture in TABLES.items():
        statement = statement.replace(table, fixture)
    # Model generation is outside the transaction/ledger contract under test.
    statement = statement.replace("SNOWFLAKE.CORTEX.COMPLETE", "_zz_apply_complete")
    statement = statement.replace("SNOWFLAKE.CORTEX.EMBED_TEXT_1024", "_zz_apply_embed")
    if re.search(r"\b(?:MCC_[A-Z_]+|SNOWFLAKE)\.", statement):
        raise ValueError("Fixture procedure still references a production database")
    return statement


def build_fixture() -> str:
    tables = "\n".join(
        f"CREATE OR REPLACE TEMPORARY TABLE {fixture} LIKE {table};"
        for table, fixture in TABLES.items()
    )
    fixture = (ROOT / "test/promotion_lifecycle.test.sql").read_text()
    fixture = fixture.replace("-- FIXTURE_TABLES", tables)
    for kind in ("promotion", "lifecycle"):
        fixture = fixture.replace(f"-- {kind.upper()}_UNDER_TEST", anonymous_procedure(kind))
    return fixture


if __name__ == "__main__":
    print(build_fixture())
