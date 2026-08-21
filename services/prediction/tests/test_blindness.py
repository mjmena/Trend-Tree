"""Generation-phase blindness to trend, heat and lifecycle state (CRMA-763 AC5).

The PRD calls this "a code-structure guarantee ... not a prompt instruction",
so nothing here is satisfied by a comment. Three layers get their own
assertions:

1. **The statements actually issued.** A full generation run through the real
   route, with the fake warehouse recording every statement, then an assertion
   over those statements: the reads name FCT_SIGNALS and nothing trend-shaped.
2. **The guard is not vacuous.** It rejects the queries a regression would
   introduce -- and rejects a write, since generation reads only.
3. **The capability boundary.** ``generate_predictions`` cannot be handed a
   warehouse client at all; its data collaborator is a ``SignalReader``, and
   no source file in the generation package names a forbidden object outside
   the denylist itself.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.generation import blindness
from prediction_service.generation import run as generation_run
from prediction_service.generation.blindness import (
    FORBIDDEN_TABLE_TOKENS,
    BlindnessViolation,
    assert_generation_sql,
)
from prediction_service.generation.signals import SIGNAL_QUERY, SnowflakeSignalReader

from .fakes import FakePredictionLLM, FakeSnowflake

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SIGNAL_ROWS = json.loads((FIXTURES / "signals.sample.json").read_text())
MODEL_REPLY = (FIXTURES / "generation_reply.sample.json").read_text()

#: The one object generation is allowed to name.
ALLOWED_TABLE = "FCT_SIGNALS"
#: What the *write* phase names. It runs after generation has returned, with
#: the route's own client -- outside the blind region.
LEDGER_TABLE = "FCT_PREDICTION_VERDICT_LEDGER"


GOOGLE_ISSUER = "https://accounts.google.com"


def _verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _client(snowflake: FakeSnowflake, llm) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    return TestClient(
        create_app(settings=settings, snowflake=snowflake, verify_token=_verify_ok, llm=llm)
    )


# --- 1. the statements a real run issues ----------------------------------


def test_a_generation_run_reads_only_the_signal_corpus():
    # The load-bearing assertion for AC5: not "we did not intend to read
    # trends" but "here is every statement the run issued, and none of them
    # could have."
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post("/generate", json={"max_predictions": 5}, headers=AUTH_HEADERS)
    assert resp.status_code == 200

    reads = [call for call in snowflake.calls if call.kind == "query"]
    assert reads, "the run must have read the signal corpus"
    for call in reads:
        assert ALLOWED_TABLE in call.sql.upper()

    # And across the WHOLE run -- reads and the ledger writes alike -- nothing
    # named a trend, heat, lifecycle, candidate or dashboard object.
    for call in snowflake.calls:
        upper = call.sql.upper()
        offending = [token for token in FORBIDDEN_TABLE_TOKENS if token in upper]
        assert offending == [], f"{call.kind} statement named {offending}: {call.sql[:120]}"


def test_the_only_statement_before_the_first_write_is_the_signal_read():
    # Ordering matters: everything the generation phase does happens before
    # the first MERGE. If a trend read ever appeared, it would appear here.
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    client.post("/generate", json={}, headers=AUTH_HEADERS)

    kinds = [call.kind for call in snowflake.calls]
    first_write = kinds.index("execute")
    before = snowflake.calls[:first_write]
    assert len(before) == 1
    assert before[0].kind == "query"
    assert ALLOWED_TABLE in before[0].sql.upper()
    # The writes that follow are the verdict ledger, nothing else.
    for call in snowflake.calls[first_write:]:
        assert LEDGER_TABLE in call.sql.upper()


def test_a_dry_run_issues_no_write_at_all():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post("/generate", json={"dry_run": True}, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert [call.kind for call in snowflake.calls] == ["query"]


def test_the_corpus_read_is_bounded_by_the_run_scope():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    client.post(
        "/generate",
        json={"lookback_hours": 48, "signal_limit": 25, "dry_run": True},
        headers=AUTH_HEADERS,
    )

    read = snowflake.calls[0]
    assert read.params == {"lookback_hours": 48, "signal_limit": 25}


# --- 2. the guard is not vacuous ------------------------------------------


def test_the_allowed_signal_query_passes_the_guard():
    # Guard the guard: the schema is literally called TREND_AGENT, so a
    # careless denylist entry would reject the one query generation needs.
    assert_generation_sql(
        SIGNAL_QUERY.format(table="MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS")
    )


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT TREND_ID, HEAT_INDEX FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS",
        "SELECT * FROM MCC_PRESENTATION.TREND_AGENT.DT_TREND_DASHBOARD",
        "SELECT LIFECYCLE_STATUS FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER",
        "SELECT * FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS",
        "SELECT * FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_CANDIDATES",
        "SELECT * FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER",
        # The join a well-meaning regression would actually write: the signal
        # corpus, enriched with "just a little" trend context.
        """
        SELECT s.SIGNAL_ID, t.HEAT_INDEX
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
        JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS l ON l.SIGNAL_ID = s.SIGNAL_ID
        JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = l.TREND_ID
        """,
    ],
)
def test_the_guard_rejects_trend_heat_and_lifecycle_reads(sql):
    with pytest.raises(BlindnessViolation, match="structurally blind"):
        assert_generation_sql(sql)


def test_a_comment_cannot_smuggle_a_forbidden_table_past_the_guard():
    # The mirror of the case above: a *comment* mentioning FCT_TRENDS is not
    # a read of it, and must not fail a legitimate query.
    assert_generation_sql(
        "-- deliberately does not join FCT_TRENDS\n"
        "SELECT SIGNAL_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS"
    )


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS (SIGNAL_ID) VALUES ('x')",
        "UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS SET SIGNAL_TITLE = 'x'",
        "MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS AS s USING (SELECT 1) AS i ON 1=1",
        "DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS",
    ],
)
def test_the_guard_rejects_any_write_from_the_generation_phase(sql):
    # Evidence purity (CONTEXT.md): no prediction-derived row ever enters the
    # signal corpus. Generation reads; it does not write anything, anywhere.
    with pytest.raises(BlindnessViolation, match="reads only"):
        assert_generation_sql(sql)


def test_a_reader_pointed_at_a_trend_table_raises_before_touching_the_client():
    snowflake = FakeSnowflake()
    reader = SnowflakeSignalReader(snowflake, "MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS")

    with pytest.raises(BlindnessViolation):
        reader.recent_signals(lookback_hours=24, limit=10)

    # Not merely "it raised": the statement never reached the warehouse.
    assert snowflake.calls == []


def test_a_blindness_violation_aborts_the_run_with_a_500_and_writes_nothing(monkeypatch):
    # The regression this guards against, staged exactly as it would happen:
    # someone repoints the corpus constant at a trend table. The guard fires
    # inside the reader, the route turns it into a 500 (a bug in this
    # service, not a dependency failure), and no verdict is written -- a
    # violated run must never degrade into "we generated something anyway".
    from prediction_service.routes import generate as generate_route

    monkeypatch.setattr(generate_route, "SIGNALS_TABLE", "FCT_TRENDS")

    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 500
    assert "blindness" in resp.json()["detail"]
    assert snowflake.calls == []


# --- 3. the capability boundary -------------------------------------------


def test_generate_predictions_takes_no_warehouse_client():
    # The structural half of the guarantee: there is no parameter through
    # which a client that could read a trend table (or write anything) could
    # enter the generation call graph.
    params = inspect.signature(generation_run.generate_predictions).parameters
    assert set(params) == {"reader", "llm", "scope", "chain_id", "minted_at"}
    assert "snowflake" not in params
    assert "client" not in params
    assert "settings" not in params


def _executable_source(path: Path) -> str:
    """``path``'s source with comments and string literals removed -- so a
    docstring that *describes* the invariant ("blind to FCT_TRENDS") is not
    mistaken for code that violates it. Table names reach a warehouse as
    string literals or identifiers in code; both survive this stripping only
    when they are... string literals. Hence also the SQL-constant check
    below: any string in a generation module that names a forbidden object
    would still have to pass ``assert_generation_sql`` to be issued, and that
    is what tests_the_guard_rejects_* covers.
    """
    import io
    import tokenize

    kept: list[str] = []
    with open(path, "rb") as handle:
        for token in tokenize.tokenize(io.BytesIO(handle.read()).readline):
            if token.type in (tokenize.COMMENT, tokenize.STRING):
                continue
            kept.append(token.string)
    return " ".join(kept)


def test_no_generation_code_names_a_forbidden_object():
    # blindness.py owns the denylist, so it is the one file allowed to spell
    # the tokens out. Any other module in the package naming one *in code*
    # (an identifier, an f-string interpolation target, a constant) would
    # mean the phase gained a way to reach trend state. Prose that describes
    # the invariant is stripped first -- see _executable_source.
    package = Path(generation_run.__file__).parent
    offenders: dict[str, list[str]] = {}
    for path in sorted(package.glob("*.py")):
        if path.name == Path(blindness.__file__).name:
            continue
        source = _executable_source(path).upper()
        hits = [token for token in FORBIDDEN_TABLE_TOKENS if token in source]
        if hits:
            offenders[path.name] = hits
    assert offenders == {}


def test_the_only_sql_constant_in_the_generation_package_is_the_signal_read():
    # The complement of the check above: exactly one module in the package
    # contains SQL at all, and that SQL clears the guard. A second one
    # appearing is the review signal that the phase grew a new reach.
    package = Path(generation_run.__file__).parent
    with_sql = sorted(
        path.name
        for path in package.glob("*.py")
        if "SELECT" in path.read_text().upper() and path.name != Path(blindness.__file__).name
    )
    assert with_sql == ["signals.py"]
    assert_generation_sql(SIGNAL_QUERY.format(table="MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS"))
