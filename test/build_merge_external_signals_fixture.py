"""Emit the temporary-table fixture used by run_merge_external_signals_tests.sh."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROCEDURE = "MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS"


def build_fixture() -> str:
    ddl = (ROOT / "sql/proc_merge_external_signals.sql").read_text()
    statement = ddl[ddl.index(f"CREATE OR REPLACE PROCEDURE {PROCEDURE}") :].strip()
    if not statement.endswith("$$;") or statement.count("$$") != 2:
        raise ValueError("Expected a single dollar-quoted procedure statement")

    # Anonymous procedures exercise the real handler without deploying a procedure.
    procedure = statement[:-1].replace(
        f"CREATE OR REPLACE PROCEDURE {PROCEDURE}",
        "WITH merge_signals_fixture AS PROCEDURE",
        1,
    )
    procedure = re.sub(r" DEFAULT (NULL|500|'STG_EXTERNAL_SIGNALS')", "", procedure)
    procedure = procedure.replace("EXECUTE AS CALLER\n", "")
    procedure = procedure.replace("MCC_RAW.MARKETING_DEV.${targetTable}", "${targetTable}")
    procedure = procedure.replace("MCC_RAW.MARKETING_DEV.RESOLVE_ARTICLE_SIGNALS", "FIX_TH_RESOLVE_ARTICLE_SIGNALS")
    if re.search(r"\bMCC_[A-Z_]+\.", procedure):
        raise ValueError("Fixture procedure still references a production database")

    fixture = (ROOT / "test/merge_external_signals.test.sql").read_text()
    return fixture.replace("-- PROCEDURE_UNDER_TEST", procedure)


if __name__ == "__main__":
    print(build_fixture())
