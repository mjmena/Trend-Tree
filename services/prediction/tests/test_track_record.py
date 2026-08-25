"""The track record: Correct / Early–Late / Incorrect, derived in SQL (CRMA-771).

The grading rule has exactly one home -- ``sql/v_prediction_track_record.sql``
-- and these tests execute **that file**, verbatim, against fixture ledger
rows. Nothing here restates the rule in Python; a Python copy of it would be
a second definition able to disagree with the shipped one, which is the
failure mode the story exists to avoid.

**How the shipped SQL runs offline.** The suite had no way to execute SQL
against fixtures before this story: every prior SQL test asserts on statement
*text* (tests/test_matching_isolation.py) or on the DDL's shape
(tests/test_sweep_direction.py). So the harness is deliberately the smallest
thing that runs the real file -- an in-memory DuckDB catalog named
``MCC_PRESENTATION`` with a ``TREND_AGENT`` schema, so the view's
fully-qualified references resolve unchanged. No stubs, no rewriting, no
substitutions: the bytes that ship are the bytes that run.

That is possible because the view reads no clock and calls no warehouse
built-in. Its whole vocabulary is ``ROW_NUMBER``, ``CASE`` and ``+ INTERVAL
'<n> days'``, which both engines mean the same thing by. The residual dialect
gap is narrow and would fail loudly rather than mis-grade quietly, and the
same fixtures were run through live Snowflake to close it -- see the story's
report.

**Time is a ledger fact here, not an ambient one.** A grade becomes final
because a row was appended saying so, so every test that moves a prediction
through its life does it by appending rows, which is exactly what the sweep
does. There is nothing to freeze or monkeypatch.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
import pytest

from prediction_service.domain.claim import (
    HORIZON_BANDS,
    REQUIRED_EVIDENCE_KEYS,
    VALID_STATUSES,
    Claim,
    build_verdict,
)
from prediction_service.domain.ledger import insert_params
from prediction_service.sweep.lifecycle import (
    TERMINAL_STATUSES,
    grace_ends_at,
    is_past_grace,
)

VIEW_SQL = Path(__file__).resolve().parents[3] / "sql" / "v_prediction_track_record.sql"
SQL_DIR = VIEW_SQL.parent
LEDGER = "MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER"
VIEW = "MCC_PRESENTATION.TREND_AGENT.V_PREDICTION_TRACK_RECORD"

#: The columns the view reads off the ledger. Checked against the shipped DDL
#: below, so this fixture cannot drift into describing a table that does not
#: exist.
LEDGER_COLUMNS = (
    ("PREDICTION_EVAL_ID", "VARCHAR"),
    ("PREDICTION_ID", "VARCHAR"),
    ("EVALUATED_AT", "TIMESTAMP"),
    ("SUBJECT_DESCRIPTOR", "VARCHAR"),
    ("DIRECTIONAL_CLAIM", "VARCHAR"),
    ("HORIZON_AT", "TIMESTAMP"),
    ("HORIZON_BAND", "VARCHAR"),
    ("PREDICTION_STATUS", "VARCHAR"),
    ("MATCHED_TREND_ID", "VARCHAR"),
)

HORIZON = "2026-04-01 00:00:00"
#: One near-term horizon length past HORIZON, i.e. where its grace window
#: closes. Spelled out rather than computed so the fixtures read as dates.
GRACE_CLOSES = "2026-06-30 00:00:00"


def at(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M:%S")


def row(
    *,
    prediction_id: str,
    eval_id: str,
    evaluated_at: str,
    status: str,
    horizon_at: str = HORIZON,
    band: str = "near_term_1_3mo",
    subject: str = "rucking vests",
    claim: str = "mainstream retail adoption expands beyond specialty fitness",
    matched_trend_id: str | None = None,
) -> dict[str, str | None]:
    """One ledger row, keyed by column name.

    Keyed rather than positional on purpose: this suite's whole subject is
    which prediction a ledger row belongs to, and a positional fixture that
    fell out of step with LEDGER_COLUMNS would bind an eval id to the wrong
    PREDICTION_ID silently -- a fixture reproducing the exact defect it exists
    to catch.
    """
    return {
        "PREDICTION_EVAL_ID": eval_id,
        "PREDICTION_ID": prediction_id,
        "EVALUATED_AT": evaluated_at,
        "SUBJECT_DESCRIPTOR": subject,
        "DIRECTIONAL_CLAIM": claim,
        "HORIZON_AT": horizon_at,
        "HORIZON_BAND": band,
        "PREDICTION_STATUS": status,
        "MATCHED_TREND_ID": matched_trend_id,
    }


class TrackRecord:
    """The shipped view, running over fixture ledger rows."""

    def __init__(self, rows: list[dict[str, str | None]]) -> None:
        self.db = duckdb.connect()
        self.db.execute('ATTACH \':memory:\' AS "MCC_PRESENTATION"')
        self.db.execute("CREATE SCHEMA MCC_PRESENTATION.TREND_AGENT")
        columns = ", ".join(f"{name} {sql_type}" for name, sql_type in LEDGER_COLUMNS)
        self.db.execute(f"CREATE TABLE {LEDGER} ({columns})")
        self.append(*rows)
        self.db.execute(VIEW_SQL.read_text())

    def append(self, *rows: dict[str, str | None]) -> None:
        """Add ledger rows. The ledger is append-only, so this is the only way
        fixture state ever changes -- and it is how a prediction is moved
        through its life here: append the row the sweep would have written,
        re-read the grade."""
        if not rows:
            return
        names = [name for name, _ in LEDGER_COLUMNS]
        placeholders = ", ".join(["?"] * len(names))
        self.db.executemany(
            f"INSERT INTO {LEDGER} ({', '.join(names)}) VALUES ({placeholders})",
            [[fixture[name] for name in names] for fixture in rows],
        )

    def grades(self) -> dict[str, tuple[str | None, str]]:
        """``{PREDICTION_ID: (grade, state)}`` -- keyed on the id, never on
        subject text."""
        return {
            prediction_id: (grade, state)
            for prediction_id, grade, state in self.db.execute(
                f"SELECT PREDICTION_ID, TRACK_RECORD_GRADE, TRACK_RECORD_STATE FROM {VIEW}"
            ).fetchall()
        }

    def query(self, sql: str) -> list[tuple]:
        return self.db.execute(sql).fetchall()


# --- the grading table, one test per arm (AC1, AC2) ------------------------


def test_a_truth_inside_the_horizon_window_reads_correct():
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-01 00:00:00",
                status="ACTIVE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-2",
                evaluated_at="2026-03-10 00:00:00",
                status="RESOLVED_TRUE",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": ("CORRECT", "GRADED")}


def test_a_truth_arriving_far_ahead_of_its_horizon_still_reads_correct():
    # "Early" is not separately reachable: the horizon window has an upper
    # bound and no lower one, so arriving sooner than the band suggested is
    # inside the window, which §7.6 grades Correct. Asserted so the choice is
    # visible rather than incidental -- the grade's NAME promises a
    # distinction the schema cannot draw.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-03 00:00:00",
                status="RESOLVED_TRUE",
                horizon_at="2028-01-01 00:00:00",
                band="longer_range_12_24mo",
            )
        ]
    )

    assert track.grades() == {"p-rucking": ("CORRECT", "GRADED")}


def test_a_truth_arriving_after_the_horizon_reads_early_late():
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-01 00:00:00",
                status="ACTIVE",
            ),
            # Inside the grace window, which is the whole point of re-checking
            # an EXPIRED prediction.
            row(
                prediction_id="p-rucking",
                eval_id="e-2",
                evaluated_at="2026-05-02 00:00:00",
                status="RESOLVED_TRUE",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": ("EARLY_LATE", "GRADED")}


def test_a_check_settled_against_the_claim_reads_incorrect():
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-02-01 00:00:00",
                status="RESOLVED_FALSE",
            )
        ]
    )

    assert track.grades() == {"p-rucking": ("INCORRECT", "GRADED")}


def test_an_expired_prediction_still_in_its_grace_window_has_no_grade_yet():
    # The sweep is still re-checking it. Publishing INCORRECT here would be a
    # grade the next evaluation could overturn.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-04-02 00:00:00",
                status="EXPIRED",
            )
        ]
    )

    assert track.grades() == {"p-rucking": (None, "PENDING")}


def test_an_expired_prediction_freezes_incorrect_only_on_its_final_row():
    """The freeze is a ledger fact, not an elapsed-time one.

    lifecycle.py's is_reevaluable() selects an EXPIRED prediction **one more
    time** after its grace window closes, so that a truth visible at the
    boundary can still resolve it. Between the close and that evaluation the
    call is not settled, and a view grading on elapsed time alone would
    publish INCORRECT for a prediction the very next row can still flip to
    EARLY_LATE. So the grade waits for the row lifecycle.py owes it.
    """
    expired = row(
        prediction_id="p-rucking",
        eval_id="e-1",
        evaluated_at="2026-04-02 00:00:00",
        status="EXPIRED",
    )
    track = TrackRecord([expired])
    assert track.grades() == {"p-rucking": (None, "PENDING")}

    # The final row lands: the sweep looked once more at the close, and the
    # observable check was still unmet.
    track.append(
        row(
            prediction_id="p-rucking",
            eval_id="e-2",
            evaluated_at=GRACE_CLOSES,
            status="EXPIRED",
        )
    )

    assert track.grades() == {"p-rucking": ("INCORRECT", "GRADED")}


def test_a_truth_inside_the_grace_window_flips_the_grade_to_early_late():
    """The story's named path: the same PREDICTION_ID, graded twice.

    Before the truth lands the prediction is EXPIRED and PENDING. The sweep
    re-checks it, appends RESOLVED_TRUE inside the grace window, and the grade
    settles at EARLY_LATE -- not the INCORRECT it would have frozen into had
    nobody looked again.
    """
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-04-02 00:00:00",
                status="EXPIRED",
            )
        ]
    )
    assert track.grades() == {"p-rucking": (None, "PENDING")}

    track.append(
        row(
            prediction_id="p-rucking",
            eval_id="e-2",
            evaluated_at="2026-05-02 00:00:00",
            status="RESOLVED_TRUE",
        )
    )

    assert track.grades() == {"p-rucking": ("EARLY_LATE", "GRADED")}


def test_a_withdrawn_prediction_is_excluded_and_still_visible():
    # Excluded from the accuracy measure, not filtered out of the view: a
    # reader has to be able to see how many calls a human withdrew.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-01 00:00:00",
                status="ACTIVE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-2",
                evaluated_at="2026-02-01 00:00:00",
                status="WITHDRAWN",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": (None, "EXCLUDED")}


def test_an_active_prediction_is_pending_however_long_it_has_been_open():
    # ACTIVE past its own grace window is a sweep that stopped running, not a
    # graded call. lifecycle.py still owes it one final EXPIRED row.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-01 00:00:00",
                status="ACTIVE",
            )
        ]
    )

    assert track.grades() == {"p-rucking": (None, "PENDING")}
    (final_row_written,) = track.query(f"SELECT FINAL_ROW_WRITTEN FROM {VIEW}")[0]
    assert final_row_written is False


# --- identity: everything keys on PREDICTION_ID ----------------------------


def test_two_predictions_sharing_a_subject_are_graded_separately():
    """The epic's recurring defect, in one test.

    Three times on this epic a ledger row has been bound to the wrong
    prediction, once permanently closing the wrong call as RESOLVED_TRUE. The
    obvious way to reintroduce it here is to group or join on the readable
    column. Two live predictions about "rucking vests" with opposite outcomes
    have to come back as two grades -- each carrying its own claim and its own
    matched trend.
    """
    track = TrackRecord(
        [
            row(
                prediction_id="p-retail",
                eval_id="e-1",
                evaluated_at="2026-03-01 00:00:00",
                status="RESOLVED_TRUE",
                subject="rucking vests",
                claim="mass-retail listings expand beyond specialty fitness",
                matched_trend_id="trend-retail",
            ),
            row(
                prediction_id="p-search",
                eval_id="e-2",
                evaluated_at="2026-03-01 00:00:00",
                status="RESOLVED_FALSE",
                subject="rucking vests",
                claim="search interest sustains above its January peak",
                matched_trend_id="trend-search",
            ),
        ]
    )

    assert track.grades() == {
        "p-retail": ("CORRECT", "GRADED"),
        "p-search": ("INCORRECT", "GRADED"),
    }
    assert track.query(
        f"SELECT PREDICTION_ID, DIRECTIONAL_CLAIM, MATCHED_TREND_ID FROM {VIEW} "
        "ORDER BY PREDICTION_ID"
    ) == [
        ("p-retail", "mass-retail listings expand beyond specialty fitness", "trend-retail"),
        ("p-search", "search interest sustains above its January peak", "trend-search"),
    ]


def test_only_the_latest_row_decides_and_an_older_one_cannot_resurrect_a_call():
    # The ledger is append-only: an ACTIVE row under a since-resolved
    # prediction must not read as still open, and the earlier row's timestamp
    # must not be mistaken for the resolving one.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-3",
                evaluated_at="2026-05-02 00:00:00",
                status="RESOLVED_TRUE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-01-01 00:00:00",
                status="ACTIVE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-2",
                evaluated_at="2026-04-02 00:00:00",
                status="EXPIRED",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": ("EARLY_LATE", "GRADED")}
    # The whole partition was seen, in the right order, whatever order the
    # rows arrived in.
    assert track.query(
        f"SELECT FIRST_EVALUATED_AT, LATEST_EVALUATED_AT, LATEST_EVAL_ID FROM {VIEW}"
    ) == [(datetime(2026, 1, 1), datetime(2026, 5, 2), "e-3")]


def test_a_redundant_later_truth_does_not_relabel_a_call_that_resolved_in_time():
    # "The resolving verdict's timestamp" is when the call was FIRST settled.
    # A duplicate RESOLVED_TRUE appended after the horizon must not turn a
    # CORRECT call into EARLY_LATE.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2026-03-10 00:00:00",
                status="RESOLVED_TRUE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-2",
                evaluated_at="2026-05-02 00:00:00",
                status="RESOLVED_TRUE",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": ("CORRECT", "GRADED")}


def test_rows_written_in_the_same_tick_resolve_to_one_deterministic_latest():
    # Same EVALUATED_AT, opposite verdicts. The tie-break on
    # PREDICTION_EVAL_ID is the same one matching/predictions.py applies, so
    # "latest" means the same row to the reader and to the writer.
    same_tick = "2026-03-01 00:00:00"
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-a",
                evaluated_at=same_tick,
                status="RESOLVED_FALSE",
            ),
            row(
                prediction_id="p-rucking",
                eval_id="e-b",
                evaluated_at=same_tick,
                status="RESOLVED_TRUE",
            ),
        ]
    )

    assert track.grades() == {"p-rucking": ("CORRECT", "GRADED")}


def test_an_unrecognised_horizon_band_never_freezes_into_a_grade():
    # A row this service did not write can carry anything. With no defined
    # window there is no instant at which the grade is final, so it stays
    # PENDING rather than being called INCORRECT on a window nobody defined.
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at="2029-04-02 00:00:00",
                status="EXPIRED",
                band="next_tuesday",
            )
        ]
    )

    assert track.grades() == {"p-rucking": (None, "PENDING")}
    (grace,) = track.query(f"SELECT GRACE_ENDS_AT FROM {VIEW}")[0]
    assert grace is None


# --- the view and the status machine agree ---------------------------------


@pytest.mark.parametrize("band", HORIZON_BANDS)
def test_the_views_grace_window_is_the_one_lifecycle_py_enforces(band):
    """The rule now has two homes -- ``grace_ends_at()`` in Python, the
    per-band INTERVALs in the view -- and they decide different halves of one
    question: Python decides which predictions the sweep re-evaluates, SQL
    decides when their grade is final. If they disagree, a prediction freezes
    as INCORRECT while the sweep can still resolve it, or stays PENDING after
    the last row it will ever get. So the boundary is asserted equal, per
    band, rather than trusted to stay in step.
    """
    horizon_at = datetime(2026, 4, 1, tzinfo=UTC)
    closes_at = grace_ends_at(horizon_at, band)

    # One second early: lifecycle.py would re-evaluate, so this is not the
    # final row and the grade is not final either.
    just_inside = closes_at - timedelta(seconds=1)
    assert is_past_grace(horizon_at, band, just_inside) is False
    track = TrackRecord(
        [
            row(
                prediction_id="p-rucking",
                eval_id="e-1",
                evaluated_at=at(just_inside),
                status="EXPIRED",
                horizon_at=at(horizon_at),
                band=band,
            )
        ]
    )
    assert track.grades() == {"p-rucking": (None, "PENDING")}
    (grace,) = track.query(f"SELECT GRACE_ENDS_AT FROM {VIEW}")[0]
    assert grace.replace(tzinfo=UTC) == closes_at

    # At the instant itself: lifecycle.py calls it past grace and writes its
    # final row, and the view grades that row.
    assert is_past_grace(horizon_at, band, closes_at) is True
    track.append(
        row(
            prediction_id="p-rucking",
            eval_id="e-2",
            evaluated_at=at(closes_at),
            status="EXPIRED",
            horizon_at=at(horizon_at),
            band=band,
        )
    )
    assert track.grades() == {"p-rucking": ("INCORRECT", "GRADED")}


def test_every_ledger_status_gets_a_disposition_and_none_is_filtered_out():
    """No gating. The pillar permits exactly one mechanical gate (CRMA-765's
    mint-time data-quality floor); a derived read adds none. Every
    PREDICTION_ID in the ledger comes back with an explicit state, including
    the WITHDRAWN ones the track record excludes -- exclusion is a label here,
    not a disappearance.
    """
    rows = [
        row(
            prediction_id=f"p-{status.lower()}",
            eval_id=f"e-{status.lower()}",
            evaluated_at="2026-03-01 00:00:00",
            status=status,
        )
        for status in sorted(VALID_STATUSES)
    ]
    track = TrackRecord(rows)

    grades = track.grades()
    assert set(grades) == {f"p-{status.lower()}" for status in VALID_STATUSES}
    assert all(state for _, state in grades.values())
    assert grades["p-withdrawn"] == (None, "EXCLUDED")

    # Terminal statuses are graded or excluded immediately -- the sweep will
    # never append another row for them, so nothing is left to wait for.
    for status in TERMINAL_STATUSES:
        _, state = grades[f"p-{status.lower()}"]
        assert state in ("GRADED", "EXCLUDED"), status


# --- AC4: aggregate accuracy in one query ----------------------------------


def test_grade_counts_by_horizon_band_are_answerable_in_one_query():
    rows = [
        row(
            prediction_id="p-near-correct",
            eval_id="e-1",
            evaluated_at="2026-03-10 00:00:00",
            status="RESOLVED_TRUE",
        ),
        row(
            prediction_id="p-near-late",
            eval_id="e-2",
            evaluated_at="2026-05-02 00:00:00",
            status="RESOLVED_TRUE",
        ),
        row(
            prediction_id="p-near-wrong",
            eval_id="e-3",
            evaluated_at="2026-03-01 00:00:00",
            status="RESOLVED_FALSE",
        ),
        row(
            prediction_id="p-emerging-correct",
            eval_id="e-4",
            evaluated_at="2026-03-10 00:00:00",
            status="RESOLVED_TRUE",
            band="emerging_3_6mo",
        ),
        # None of these counts: one is still open, one a human withdrew, and
        # one is expired but still inside its grace window.
        row(
            prediction_id="p-open",
            eval_id="e-5",
            evaluated_at="2026-03-01 00:00:00",
            status="ACTIVE",
        ),
        row(
            prediction_id="p-dismissed",
            eval_id="e-6",
            evaluated_at="2026-03-01 00:00:00",
            status="WITHDRAWN",
        ),
        row(
            prediction_id="p-in-grace",
            eval_id="e-7",
            evaluated_at="2026-04-02 00:00:00",
            status="EXPIRED",
        ),
    ]
    track = TrackRecord(rows)

    # The query shipped in the view file's header, trimmed to the two columns
    # this test needs to distinguish.
    accuracy = track.query(
        f"""
        SELECT HORIZON_BAND,
               COUNT(*) AS GRADED,
               SUM(CASE WHEN TRACK_RECORD_GRADE = 'CORRECT' THEN 1 ELSE 0 END) AS CORRECT
        FROM {VIEW}
        WHERE TRACK_RECORD_STATE = 'GRADED'
        GROUP BY HORIZON_BAND
        ORDER BY HORIZON_BAND
        """
    )

    assert accuracy == [("emerging_3_6mo", 1, 1), ("near_term_1_3mo", 3, 1)]


# --- AC3: nothing is stored, and re-deriving changes nothing ---------------

#: Name segments that would mark a column as holding a track-record grade.
#: Matched against a column name's ``_``-separated parts, so an unrelated
#: ``CORRECTED_URL`` is not a hit and a future ``PREDICTION_GRADE`` is.
GRADE_SEGMENTS = frozenset({"GRADE", "GRADED", "GRADES", "CORRECT", "INCORRECT"})
GRADE_SUBSTRINGS = ("TRACK_RECORD", "EARLY_LATE")

# Deliberately a broader relative of tests/test_sweep_direction.py's column
# regex rather than a shared helper: that one reads one DDL file for one
# forbidden concept, this one sweeps every file in sql/ and has to survive
# their varied type spellings (TIMESTAMP_NTZ, VECTOR, ARRAY). Folding them
# together would tie the narrow check's fate to this one's reach.
COLUMN_DECLARATION = re.compile(
    r"^\s{2,}([A-Z][A-Z0-9_]*)\s+"
    r"(?:VARCHAR|NUMBER|TIMESTAMP(?:_[A-Z]+)?|VARIANT|BOOLEAN|FLOAT|TEXT|DATE|ARRAY"
    r"|OBJECT|INT|VECTOR)\b",
    re.M,
)


def looks_like_a_stored_grade(name: str) -> bool:
    return bool(GRADE_SEGMENTS & set(name.split("_"))) or any(
        token in name for token in GRADE_SUBSTRINGS
    )


def test_no_shipped_table_declares_a_grade_column():
    """The structural half of "never stored".

    The arithmetic half is easy to keep right; the absence of a column is what
    a later change adds back by accident -- someone puts TRACK_RECORD_GRADE on
    the ledger "because a dashboard wants it", the writer starts binding it,
    and there are two copies of a fact that can now disagree. Same shape as
    tests/test_sweep_direction.py's check on the derived confidence direction.
    """
    offenders = []
    columns = 0
    for path in sorted(SQL_DIR.glob("*.sql")):
        if path == VIEW_SQL:
            continue  # a view's SELECT list is derivation, not storage
        declared = set(COLUMN_DECLARATION.findall(path.read_text()))
        columns += len(declared)
        offenders += [(path.name, name) for name in declared if looks_like_a_stored_grade(name)]

    assert columns > 100, "the DDL parse found almost no columns -- the regex has rotted"
    assert offenders == [], (
        f"{offenders} looks like a stored track-record grade. Correct / Early-Late / "
        "Incorrect is derived from the ledger by sql/v_prediction_track_record.sql and "
        "must not be a column -- a stored grade is a second copy of a fact the ledger "
        "already implies, and it can disagree with it."
    )


def test_the_service_binds_no_grade_parameter():
    verdict = build_verdict(
        Claim(
            subject_descriptor="rucking vests",
            directional_claim="mainstream retail adoption expands",
            horizon_band="emerging_3_6mo",
            observable_check="house-label listings at two of three mass retailers",
        ),
        confidence=74.0,
        reasoning="because",
        # Built from the required-key list rather than spelled out, so a
        # story that adds a key does not fail this test for a reason that
        # has nothing to do with grades.
        evidence={key: None for key in REQUIRED_EVIDENCE_KEYS},
        status="RESOLVED_TRUE",
        minted_at=datetime(2026, 8, 21, tzinfo=UTC),
    )

    bound = [key for key in insert_params(verdict) if looks_like_a_stored_grade(key.upper())]
    assert bound == [], f"{bound} writes a grade to the ledger; the grade is derived"


def test_the_view_only_reads():
    # A derived read cannot be a gate, and cannot be a store. Both properties
    # are the same property here: the file contains one CREATE VIEW and no DML.
    # Comments are stripped first -- the header explains why this is a view
    # and not a dynamic table, and naming the alternative is not doing it.
    sql = re.sub(r"--[^\n]*", " ", VIEW_SQL.read_text()).upper()
    assert "CREATE OR REPLACE VIEW" in sql
    for statement in ("INSERT ", "UPDATE ", "DELETE ", "MERGE ", "CREATE TABLE", "DYNAMIC TABLE"):
        assert statement not in sql, f"the track-record view must not {statement.strip()}"


def test_the_derivation_reads_no_clock():
    """Idempotence over time, asserted where it can actually be broken.

    A grade that consulted the wall clock would move without a row being
    written -- the same query, the same ledger, a different answer tomorrow --
    and would settle a call before the sweep had written the row that settles
    it. Every instant the view compares against comes off a ledger row.
    """
    sql = re.sub(r"--[^\n]*", " ", VIEW_SQL.read_text()).upper()
    for clock in ("SYSDATE", "CURRENT_TIMESTAMP", "CURRENT_DATE", "LOCALTIMESTAMP", "GETDATE"):
        assert clock not in sql, f"{clock} makes the grade a property of when you asked"


def test_re_deriving_the_same_ledger_state_returns_the_same_grades():
    rows = [
        row(
            prediction_id="p-resolved",
            eval_id="e-1",
            evaluated_at="2026-03-10 00:00:00",
            status="RESOLVED_TRUE",
        ),
        row(
            prediction_id="p-frozen",
            eval_id="e-2",
            evaluated_at=GRACE_CLOSES,
            status="EXPIRED",
        ),
        row(
            prediction_id="p-withdrawn",
            eval_id="e-3",
            evaluated_at="2026-02-01 00:00:00",
            status="WITHDRAWN",
        ),
    ]
    track = TrackRecord(rows)
    everything = f"SELECT * FROM {VIEW} ORDER BY PREDICTION_ID"

    first = track.query(everything)
    assert track.query(everything) == first
    # Re-running the derivation -- including re-creating the view itself --
    # is a no-op: it reads, it does not accumulate.
    track.db.execute(VIEW_SQL.read_text())
    assert track.query(everything) == first
    assert track.query(f"SELECT COUNT(*) FROM {LEDGER}") == [(len(rows),)]


def test_every_column_the_view_reads_exists_on_the_shipped_ledger():
    # The fixture table above is hand-written, so it could drift into
    # describing a ledger that does not exist. Anchored to the real DDL.
    ddl = (SQL_DIR / "fct_prediction_verdict_ledger.sql").read_text()
    declared = set(COLUMN_DECLARATION.findall(ddl))
    missing = [name for name, _ in LEDGER_COLUMNS if name not in declared]
    assert missing == [], f"{missing} is not a column of FCT_PREDICTION_VERDICT_LEDGER"
