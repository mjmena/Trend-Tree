"""Coverage detection: the statement, the dedupe rule, the threshold
(CRMA-767 AC1, AC6).

The detection is deterministic SQL, so it is testable without the warehouse
in two halves: the statement's *shape* and its binds (asserted here against a
fake client), and its *results* (asserted against the live pool -- see the
standalone verification recorded in ``sql/prediction_coverage_detection.sql``
and repeated in ``coverage/detect.py``'s calibration note).

This file also holds the two files to the same constants. The .sql is what a
human runs in a worksheet; detect.py is what the service issues. A threshold
changed in one and forgotten in the other is the drift this catches.
"""

from __future__ import annotations

import pathlib

import pytest

from prediction_service.coverage import (
    CONTENT_VECTORS_TABLE,
    DEFAULT_DETECTION_LIMIT,
    DEFAULT_MIN_HEADLINE_CHARS,
    DEFAULT_MIN_SIMILARITY,
    DEFAULT_WINDOW_DAYS,
    EMBED_MODEL,
    CoverageDetection,
    SnowflakeCoverageDetector,
    StaticCoverageDetector,
    build_detection_sql,
)
from prediction_service.coverage.detect import (
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    bounded_cosine,
)

from .fakes import FakeSnowflake

REPO_SQL = (
    pathlib.Path(__file__).resolve().parents[3] / "sql" / "prediction_coverage_detection.sql"
)

# The row the live pool returns for 'protein coffee' at the shipped
# threshold, recorded from the 2026-08-24 run of the standalone .sql. Used as
# a known-good literal rather than recomputed.
PROTEIN_COFFEE_ROW = {
    "SUBJECT_DESCRIPTOR": "protein coffee",
    "CONTENT_ID": 316520398,
    "HEADLINE": "Protein coffee: How the trending drink is changing the way Americans "
    "fuel their mornings",
    "FIRST_PUBLISHED_DATE": "2026-07-15",
    "LAST_PUBLISHED_DATE": "2026-07-15",
    "SYNDICATED_COPIES": 1,
    "SIMILARITY": 0.8172,
}

# The syndication case, from the same live pool: one story, two publications.
SYNDICATED_ROW = {
    "SUBJECT_DESCRIPTOR": "functional beer",
    "CONTENT_ID": 314918259,
    "HEADLINE": "A relaxed weekend hangout featuring friendly pickleball matches, cold "
    "beer, and good company",
    "FIRST_PUBLISHED_DATE": "2026-03-04",
    "LAST_PUBLISHED_DATE": "2026-04-01",
    "SYNDICATED_COPIES": 2,
    "SIMILARITY": 0.7401,
}


def detector(client, **overrides) -> SnowflakeCoverageDetector:
    return SnowflakeCoverageDetector(client=client, **overrides)


# --- the statement it issues ----------------------------------------------


def test_a_detection_pass_is_one_read_of_the_content_embeddings():
    snowflake = FakeSnowflake()
    detector(snowflake).detect(["protein coffee", "urolithin A"])

    assert len(snowflake.calls) == 1
    call = snowflake.calls[0]
    assert call.kind == "query"
    assert CONTENT_VECTORS_TABLE in call.sql
    # One statement for the whole sweep -- the pool scan dominates the cost.
    assert call.params["subject_0"] == "protein coffee"
    assert call.params["subject_1"] == "urolithin A"


def test_every_tuned_value_is_bound_not_baked_into_the_text():
    snowflake = FakeSnowflake()
    detector(
        snowflake,
        min_similarity=0.5,
        window_days=30,
        min_headline_chars=12,
        detection_limit=2,
    ).detect(["protein coffee"])

    params = snowflake.calls[0].params
    assert params["min_similarity"] == 0.5
    assert params["window_days"] == 30
    assert params["min_headline_chars"] == 12
    assert params["detection_limit"] == 2
    assert params["embed_model"] == EMBED_MODEL


def test_the_subject_is_embedded_in_the_space_the_stored_vectors_live_in():
    # 768 dims, arctic-embed-m-v1.5 -- the model KEY_WORDS_VECTOR was written
    # with. Embedding in the trend space's 1024-dim model would produce a
    # number that looks like a similarity and means nothing.
    sql = build_detection_sql(1)
    assert "SNOWFLAKE.CORTEX.EMBED_TEXT_768" in sql
    assert EMBED_MODEL == "snowflake-arctic-embed-m-v1.5"


def test_a_repeated_subject_is_embedded_once():
    snowflake = FakeSnowflake()
    detector(snowflake).detect(["protein coffee", "protein coffee"])

    params = snowflake.calls[0].params
    assert params["subject_0"] == "protein coffee"
    assert "subject_1" not in params


def test_two_predictions_on_the_same_subject_both_get_the_reading():
    snowflake = FakeSnowflake(rows=[PROTEIN_COFFEE_ROW])
    readings = detector(snowflake).detect(["protein coffee", "protein coffee"])

    assert [reading.detected for reading in readings] == [True, True]


def test_subjects_past_the_cap_are_reported_as_unlooked_not_dropped():
    snowflake = FakeSnowflake()
    readings = detector(snowflake, subject_limit=1).detect(["a subject", "another"])

    assert len(readings) == 2
    assert readings[1].available is False
    assert "subject cap" in readings[1].miss_reason


# --- what it makes of the rows --------------------------------------------


def test_a_known_published_story_reads_as_coverage_above_the_threshold():
    snowflake = FakeSnowflake(rows=[PROTEIN_COFFEE_ROW])
    reading = detector(snowflake).detect(["protein coffee"])[0]

    assert reading.available is True
    assert reading.detected is True
    assert reading.story_count == 1
    assert reading.top_similarity == pytest.approx(0.8172)
    assert reading.detections[0].content_id == "316520398"
    assert reading.detections[0].headline.startswith("Protein coffee:")


def test_a_subject_with_no_matching_story_is_a_reading_not_a_miss():
    snowflake = FakeSnowflake(rows=[PROTEIN_COFFEE_ROW])
    reading = detector(snowflake).detect(["protein coffee", "urolithin A"])[1]

    # "We looked at every McClatchy story in the window and none is about
    # this" is a fact worth having; it is not the same as "we could not look".
    assert reading.available is True
    assert reading.detected is False
    assert reading.miss_reason is None


def test_syndicated_duplicates_count_as_one_story():
    snowflake = FakeSnowflake(rows=[SYNDICATED_ROW])
    reading = detector(snowflake, min_similarity=0.70).detect(["functional beer"])[0]

    assert reading.story_count == 1
    # ...and the rows that folded into it stay visible, so the dedupe is
    # readable off the ledger rather than taken on trust.
    assert reading.syndicated_rows == 2
    assert reading.detections[0].first_published_date == "2026-03-04"
    assert reading.detections[0].last_published_date == "2026-04-01"


def test_a_row_the_reader_cannot_place_is_ignored_rather_than_misfiled():
    # The recurring bug class on this epic is a result bound to the wrong
    # domain object. A row whose SUBJECT_DESCRIPTOR is missing belongs to
    # nobody and is dropped, never assigned by position.
    snowflake = FakeSnowflake(rows=[{**PROTEIN_COFFEE_ROW, "SUBJECT_DESCRIPTOR": None}])
    readings = detector(snowflake).detect(["protein coffee", "urolithin A"])

    assert [reading.detected for reading in readings] == [False, False]


def test_rows_are_bound_to_the_subject_they_name_not_to_their_position():
    snowflake = FakeSnowflake(rows=[SYNDICATED_ROW, PROTEIN_COFFEE_ROW])
    first, second = detector(snowflake, min_similarity=0.70).detect(
        ["protein coffee", "functional beer"]
    )

    assert first.detections[0].content_id == "316520398"
    assert second.detections[0].content_id == "314918259"


# --- it cannot fail a run -------------------------------------------------


def test_a_warehouse_outage_is_a_miss_not_an_exception():
    class Broken:
        def query(self, sql, params=None):
            raise RuntimeError("Error contacting database")

    readings = detector(Broken()).detect(["protein coffee"])

    assert readings[0].available is False
    assert readings[0].miss_reason == MISS_LOOKUP_FAILED
    assert "Error contacting database" in readings[0].error


def test_an_unwired_detector_says_so_rather_than_reading_as_no_coverage():
    reading = StaticCoverageDetector().detect(["protein coffee"])[0]

    assert reading.available is False
    assert reading.miss_reason == MISS_NOT_CONFIGURED


def test_no_subjects_is_no_statement():
    snowflake = FakeSnowflake()
    assert detector(snowflake).detect([]) == []
    assert snowflake.calls == []


# --- the binds cannot change the statement's shape ------------------------


def test_a_cosine_bound_is_coerced_before_it_reaches_a_statement():
    assert bounded_cosine("min_similarity", "0.78") == pytest.approx(0.78)
    with pytest.raises(ValueError, match="cosine in"):
        bounded_cosine("min_similarity", 1.5)
    with pytest.raises(ValueError):
        bounded_cosine("min_similarity", "0.7 OR 1=1")


def test_the_statement_needs_at_least_one_subject():
    with pytest.raises(ValueError, match="at least 1"):
        build_detection_sql(0)


# --- the .sql file and the served statement agree -------------------------


def test_the_standalone_sql_file_exists_and_is_a_query_not_a_migration():
    text = REPO_SQL.read_text()
    upper = text.upper()
    for ddl in ("CREATE ", "ALTER ", "DROP ", "INSERT ", "MERGE ", "UPDATE ", "DELETE "):
        assert ddl not in upper, f"the detection file must stay a read; it contains {ddl!r}"


@pytest.mark.parametrize(
    "fragment",
    [
        "SNOWFLAKE.CORTEX.EMBED_TEXT_768",
        CONTENT_VECTORS_TABLE,
        "TRIM(REGEXP_REPLACE(LOWER(",
        "'[^0-9a-z]+', ' ')",
        "SYNDICATED_COPIES",
        "ARRAY_SIZE(",
    ],
)
def test_the_standalone_sql_uses_the_same_mechanism_as_the_served_statement(fragment):
    served = build_detection_sql(1)
    text = REPO_SQL.read_text()
    assert fragment in text
    assert fragment in served or fragment in "".join(served.split())


@pytest.mark.parametrize(
    ("literal", "constant"),
    [
        ("0.78", DEFAULT_MIN_SIMILARITY),
        ("180", DEFAULT_WINDOW_DAYS),
        ("30", DEFAULT_MIN_HEADLINE_CHARS),
        ("5", DEFAULT_DETECTION_LIMIT),
    ],
)
def test_the_standalone_sql_records_the_calibration_the_service_runs(literal, constant):
    # AC6: "similarity threshold and dedupe rule are recorded where
    # implementation tuned them" -- and recorded in ONE place, so the
    # worksheet copy cannot drift from the deployed one.
    assert str(constant) == literal
    assert literal in REPO_SQL.read_text()


def test_a_detection_row_renders_the_calibration_it_was_found_under():
    payload = CoverageDetection.from_row(PROTEIN_COFFEE_ROW).as_evidence()

    assert payload["content_id"] == "316520398"
    assert payload["syndicated_copies"] == 1
    assert payload["similarity"] == pytest.approx(0.8172)


# --- a bad bound fails once, at construction, not silently per sweep ------


def test_a_threshold_written_as_a_percentage_is_refused_at_construction():
    # 78 instead of 0.78. Checked at query time this loaded fine, raised on
    # every sweep, and was swallowed into "an outage is a miss" -- coverage
    # silently dead for every row.
    with pytest.raises(ValueError, match="cosine in"):
        SnowflakeCoverageDetector(client=FakeSnowflake(), min_similarity=78)
    with pytest.raises(ValueError, match="at least 1"):
        SnowflakeCoverageDetector(client=FakeSnowflake(), window_days=0)


def test_a_bad_bound_degrades_coverage_to_offline_rather_than_stopping_the_service():
    from prediction_service.config import settings_from_env
    from prediction_service.coverage import build_coverage_phase

    settings = settings_from_env({"PREDICTION_COVERAGE_MIN_SIMILARITY": "78"})
    phase = build_coverage_phase(settings, FakeSnowflake())

    # Coverage can only ever demote, so a broken setting must not be able to
    # stop the pillar writing verdicts.
    reading = phase.readings(["protein coffee"])[0]
    assert reading.available is False
    assert reading.miss_reason == MISS_NOT_CONFIGURED
