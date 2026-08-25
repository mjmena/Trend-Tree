"""The dashboard projection reads the verdict ledger, and only the verdict
ledger (CRMA-769).

``sql/dt_trend_dashboard.sql`` is the shipped artifact -- a human applies it
to Snowflake, so there is no import to call and no fake to inject. The seam
is the file itself, and it is the same seam ``test_sweep_direction.py``
already uses for the ledger DDL: the invariants that matter here are
structural properties of the SQL text, and the thing they guard against is a
later edit quietly putting them back.

Four of them are load-bearing enough to be worth freezing:

1. **White-space predictions reach no strategist surface** (CRMA-764 AC3,
   carried; CRMA-769 AC3). This dashboard is that surface, so the filter
   ``MATCHED_TREND_ID IS NOT NULL`` lives here or nowhere.
2. **Absence reads NULL** (AC1). The retired scorer coalesced
   ``PREDICTION_ELIGIBLE`` to FALSE, which dressed "no call" up as "a
   negative call". The re-point's whole point is that it stops doing that,
   and a stray ``COALESCE`` would silently undo it.
3. **No narrative field feeds a scored field** (AC9). Angle, audience
   question, reasoning, what-changed and the cited examples are readable
   context. If any of them appeared in the expression behind
   ``PREDICTION_SCORE`` / ``_FLAG`` / ``_ELIGIBLE``, or in the ordering that
   picks which verdict wins a trend, the pillar would have grown a new
   mechanical gate -- the one thing the strategy forbids.
4. **An empty cited-examples list is absent, not empty** (AC7). 2 of the 20
   live predictions carry no source signals; those cards render without an
   examples block rather than with a bare one, and are not dropped for it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DASHBOARD_SQL = Path(__file__).resolve().parents[3] / "sql" / "dt_trend_dashboard.sql"

#: Every field the verdict ledger carries for a human to read. None of these
#: may appear anywhere a scored field or a verdict-selection ordering can see
#: them (AC9).
NARRATIVE_FIELDS = (
    "ANGLE",
    "AUDIENCE_QUESTION",
    "REASONING",
    "WHAT_CHANGED",
    "SOURCE_SIGNALS",
    "CITED_EXAMPLES",
    "SUBJECT_DESCRIPTOR",
    "DIRECTIONAL_CLAIM",
    "OBSERVABLE_CHECK",
)


# --- reading the shipped SQL ----------------------------------------------
#
# Deliberately crude: strip comments and string literals, then split on
# top-level commas. Enough to name one CTE or one output expression without
# pulling in a SQL parser the service does not otherwise depend on.


def _strip_noise(sql: str) -> str:
    """Blank out ``--`` comments and single-quoted literals, preserving offsets."""
    out = list(sql)
    i, n = 0, len(sql)
    while i < n:
        if sql[i] == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] != "\n":
                out[i] = " "
                i += 1
        elif sql[i] == "'":
            out[i] = " "
            i += 1
            while i < n and sql[i] != "'":
                out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
                i += 1
        else:
            i += 1
    return "".join(out)


@pytest.fixture(scope="module")
def sql() -> str:
    return DASHBOARD_SQL.read_text()


@pytest.fixture(scope="module")
def bare(sql: str) -> str:
    """The SQL with comments and literals blanked out."""
    return _strip_noise(sql)


def _cte_span(bare_sql: str, name: str) -> tuple[int, int]:
    """Offsets of the named CTE's body, parens balanced.

    ``_strip_noise`` preserves offsets, so these index the raw SQL too --
    which is how a test can look at a string literal the blanked copy hides.
    """
    match = re.search(rf"\b{name}\s+AS\s*\(", bare_sql, re.IGNORECASE)
    assert match, f"no CTE named {name}"
    depth, start = 1, match.end()
    i = start
    while depth:
        if bare_sql[i] == "(":
            depth += 1
        elif bare_sql[i] == ")":
            depth -= 1
        i += 1
    return start, i - 1


def _cte(bare_sql: str, name: str) -> str:
    """The body of the named CTE, parens balanced."""
    start, end = _cte_span(bare_sql, name)
    return bare_sql[start:end]


def _final_select(bare_sql: str) -> str:
    """The outermost SELECT list -- everything the dashboard actually emits."""
    start = bare_sql.rindex("\nSELECT\n")
    end = bare_sql.index("\nFROM trend_base", start)
    return bare_sql[start + len("\nSELECT\n") : end]


def _output_expression(bare_sql: str, alias: str) -> str:
    """The expression the final SELECT emits under ``alias``."""
    depth, item, items = 0, [], []
    for ch in _final_select(bare_sql):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            items.append("".join(item))
            item = []
        else:
            item.append(ch)
    items.append("".join(item))

    for raw in items:
        text = raw.strip()
        if not text:
            continue
        head, sep, tail = text.rpartition(" AS ")
        if sep and tail.strip() == alias:
            return head.strip()
        if not sep and text.rpartition(".")[2].strip() == alias:
            return text
    raise AssertionError(f"the final SELECT emits no column aliased {alias}")


# --- AC3: white-space predictions surface nowhere --------------------------


def test_a_white_space_prediction_cannot_reach_the_dashboard(bare: str):
    # A white-space prediction matches no trend, so MATCHED_TREND_ID is NULL
    # (CONTEXT.md). Joining on it would drop those rows anyway -- but "anyway"
    # is not a guarantee, and this is the surface CRMA-764 AC3 was waiting on.
    # Say it out loud, where a reader and a regression test can both see it.
    queued = _cte(bare, "queued_prediction")
    assert re.search(r"MATCHED_TREND_ID\s+IS\s+NOT\s+NULL", queued, re.IGNORECASE)


# --- AC1: the three retained columns, and what absence reads ---------------

RETAINED = ("PREDICTION_SCORE", "PREDICTION_FLAG", "PREDICTION_ELIGIBLE")


@pytest.mark.parametrize("column", RETAINED)
def test_the_three_retained_columns_keep_their_names(bare: str, column: str):
    # The Insights Agent backend reads these by name through the semantics
    # change (user story 16). Renaming one is a breaking change dressed as a
    # cutover.
    assert _output_expression(bare, column)


@pytest.mark.parametrize("column", RETAINED)
def test_no_active_matched_prediction_reads_null_in_all_three(bare: str, column: str):
    # The projection is a LEFT JOIN, so a trend with no queued prediction
    # contributes no verdict row and every one of these reads NULL by
    # construction -- unless something defaults it. The retired scorer
    # defaulted PREDICTION_ELIGIBLE to FALSE, which is exactly the lie the
    # re-point exists to stop telling: "no call" is not "a negative call".
    expression = _output_expression(bare, column)
    assert "COALESCE" not in expression.upper(), (
        f"{column} defaults absence away; AC1 wants NULL"
    )
    assert "IFNULL" not in expression.upper()
    assert "NVL" not in expression.upper()


def test_the_score_is_the_calibrated_confidence(bare: str):
    # Not a re-derivation of it. The ledger's CONFIDENCE is NUMBER(5,1) and
    # PREDICTION_SCORE is NUMBER(5,1) -- same 0-100 range, so the column's
    # documented type and range survive the semantics change untouched.
    assert _output_expression(bare, "PREDICTION_SCORE") == "qp.CONFIDENCE"


def test_the_flag_bands_the_score_on_the_published_thresholds(bare: str):
    # Banding is part of the retained contract (docs/dashboard/data-contract.md):
    # High Potential 80+, Watchlist 65-80, Emerging 40-65, NULL below 40.
    # Consumers filter on these strings, so the boundaries move only
    # deliberately.
    flag = _output_expression(bare, "PREDICTION_FLAG")
    bands = re.findall(r">=\s*(\d+)\s*THEN\s+", flag, re.IGNORECASE)
    assert bands == ["80", "65", "40"]


def test_the_flag_keeps_the_width_the_live_column_has(bare: str):
    # DT_TREND_DASHBOARD.PREDICTION_FLAG is VARCHAR(32), inherited from the
    # retired ledger's column. A bare CASE over string literals types as
    # VARCHAR(16MB), so the cast is what keeps AC1's "types unchanged" true.
    assert "::VARCHAR(32)" in _output_expression(bare, "PREDICTION_FLAG")


def test_eligible_means_a_queued_prediction_exists(bare: str):
    # "Has an active queued prediction" -- so the only values it can take are
    # TRUE and NULL. A FALSE would mean the system looked and said no, and
    # nothing in the pillar says no: the one mechanical gate lives at mint
    # time, not here.
    eligible = _output_expression(bare, "PREDICTION_ELIGIBLE").upper()
    assert "TRUE" in eligible
    assert "FALSE" not in eligible


# --- AC2 / AC8: the additive narrative columns ------------------------------

ADDITIVE = (
    "PREDICTION_CLAIM",
    "PREDICTION_REASONING",
    "PREDICTION_WHAT_CHANGED",
    "PREDICTION_EVALUATED_AT",
    "PREDICTION_ANGLE",
    "PREDICTION_AUDIENCE_QUESTION",
    "PREDICTION_CITED_EXAMPLES",
)


@pytest.mark.parametrize("column", ADDITIVE)
def test_the_card_gets_the_story_not_just_the_score(bare: str, column: str):
    assert _output_expression(bare, column)


def test_the_rendered_claim_composes_all_four_claim_parts(bare: str):
    # Subject, directional claim, horizon, observable check -- the falsifiable
    # 4-part structure the ledger stores NOT NULL and frozen at mint. All four
    # are composed here, in the projection, so the card states an explicit
    # call rather than making a reader assemble one from columns.
    claim = _output_expression(bare, "PREDICTION_CLAIM")
    for part in ("SUBJECT_DESCRIPTOR", "DIRECTIONAL_CLAIM", "HORIZON_AT", "OBSERVABLE_CHECK"):
        assert part in claim, f"the rendered claim drops {part}"


def test_a_missing_angle_or_question_cannot_blank_the_rest_of_the_card(bare: str):
    # ANGLE and AUDIENCE_QUESTION are nullable, and concatenating a NULL in
    # SQL yields NULL for the whole string. So the rendered claim is built
    # from the four NOT NULL claim columns and nothing else, and the two
    # nullable narrative columns are projected on their own -- a run where the
    # model declined to narrate loses those two fields and keeps every other
    # one (AC8).
    claim = _output_expression(bare, "PREDICTION_CLAIM")
    assert "ANGLE" not in claim
    assert "AUDIENCE_QUESTION" not in claim

    for column in ("PREDICTION_ANGLE", "PREDICTION_AUDIENCE_QUESTION"):
        assert "||" not in _output_expression(bare, column), (
            f"{column} is concatenated; a NULL would swallow whatever it is joined to"
        )


# --- AC9: narrative is read, never used ------------------------------------


@pytest.mark.parametrize("column", RETAINED)
@pytest.mark.parametrize("field", NARRATIVE_FIELDS)
def test_no_narrative_field_feeds_a_scored_field(bare: str, column: str, field: str):
    assert field not in _output_expression(bare, column).upper()


@pytest.mark.parametrize("field", NARRATIVE_FIELDS)
def test_no_narrative_field_decides_which_verdict_wins_a_trend(bare: str, field: str):
    # The subtler half of AC9. A scored field could stay arithmetically clean
    # while a narrative field quietly chose *which* verdict got scored -- rank
    # the candidates for a trend by "has an angle" and you have built a
    # mechanical gate out of readable context. So the ordering that resolves
    # a trend to one verdict may only read the evaluation's own facts.
    ordering = _cte(bare, "queued_prediction")
    ordering = ordering[ordering.upper().index("ORDER BY") :]
    assert field not in ordering.upper()


def test_selection_turns_on_status_and_match_alone(bare: str):
    # Everything the WHERE clause is allowed to look at. Anything else here
    # would be a new mechanical gate, and the pillar permits exactly one --
    # the mint-time data-quality floor, which lives in the service.
    queued = _cte(bare, "queued_prediction")
    where = queued[queued.upper().index("WHERE") : queued.upper().index("QUALIFY")]
    assert set(re.findall(r"\b[A-Z_]{4,}\b", where)) == {
        "WHERE",
        "PREDICTION_STATUS",
        "MATCHED_TREND_ID",
        "NULL",
    }


# --- AC7: cited examples are absent, not empty -----------------------------


def test_a_prediction_that_cited_nothing_projects_no_examples_block(bare: str):
    # A non-OUTER FLATTEN is what makes this true: no source signals means no
    # group, means no row, means NULL downstream. `OUTER => TRUE` would emit a
    # single null-valued row per prediction and the aggregate would render an
    # array with a hole in it.
    examples = _cte(bare, "prediction_cited_examples")
    assert "OUTER" not in examples.upper()
    assert "ARRAY_COMPACT" not in examples.upper()


def test_citing_nothing_does_not_suppress_the_prediction(bare: str):
    # The row still projects; only the examples block is missing. A LEFT JOIN
    # is the whole guarantee -- an inner join here would silently drop every
    # card whose prediction cited nothing, which on live data is 2 in 20.
    assert re.search(r"LEFT JOIN\s+prediction_cited_examples\b", bare)


# --- the ledger boundary ----------------------------------------------------


def test_only_source_signals_escapes_the_evidence_json(bare: str):
    # saturation / trend_context / coverage are contracted EVIDENCE keys and
    # stay ledger-only. trend_context is the sharpest of the three: it holds
    # the four measures the retired scorer gated on, and projecting them onto
    # the dashboard is how they would find their way back into a filter.
    assert re.findall(r"EVIDENCE:(\w+)", bare) == ["source_signals"]


def test_the_retired_scorer_no_longer_feeds_the_dashboard(bare: str):
    # FCT_TREND_PREDICTION_LEDGER freezes as v1/v2 history: still queryable,
    # no longer read here. Two systems writing competing prediction state is
    # the failure this cutover exists to end.
    assert "FCT_TREND_PREDICTION_LEDGER" not in bare
    assert "FCT_PREDICTION_VERDICT_LEDGER" in bare


def test_a_cited_example_links_out_or_says_nothing(sql: str, bare: str):
    # EVIDENCE:source_signals holds FCT_SIGNALS ids, and the id IS the URL
    # only for rows written after sql/swap_signal_id_to_url.sql. Older
    # bluesky rows still carry an opaque `bsky_<hash>` -- 7 of the 41 cited
    # ids on 2026-08-24 -- and putting one in a `url` key would render a dead
    # link on the card. So a cited example either links somewhere real or
    # carries no url at all, and the reader sees an unlinked citation instead
    # of a broken one.
    start, end = _cte_span(bare, "prediction_cited_examples")
    cte = sql[start:end]
    url_expr = cte[cte.index("'url'") : cte.index("'title'")]

    assert "LIKE 'http%'" in url_expr, "an already-canonical id must pass through"
    # The one legacy shape worth resolving, using the same at:// -> web
    # expression sql/alter_stg_external_signals_url_migration.sql defined.
    assert "bsky.app" in url_expr
    assert re.search(r"ELSE\s+NULL", url_expr), (
        "an id that resolves to no link must drop the key, not emit a dead one"
    )
