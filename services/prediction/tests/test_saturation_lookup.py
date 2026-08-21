"""The two external saturation seams (CRMA-765).

Everything here runs offline: both adapters take an injectable transport, the
same way generation/llm.py's Gemini client does. The property under test is
mostly one sentence -- **neither oracle ever raises** -- because the PRD makes
an Exploding Topics miss "never a penalty" and an outage has to degrade to
"we could not look", not to a failed run.
"""

from __future__ import annotations

import json
import urllib.error

from prediction_service.saturation.lookup import (
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    MISS_NOT_IN_CATALOG,
    ExplodingTopicsOracle,
    GdeltBreadthReader,
    StaticBreadthReader,
    StaticSaturationOracle,
    load_saturation_fixture,
    normalize_et_response,
    normalize_gdelt_response,
)

HIT_BODY = {
    "total": 3,
    "result": [
        {
            "keyword": "rucking vest",
            "path": "rucking-vest",
            "absolute_volume": 40500,
            "classifications": {"3": "exploding", "6": "peaked", "12": "peaked"},
            "growth": {"12": "+318%"},
        },
        {"keyword": "weighted vest", "path": "weighted-vest", "absolute_volume": 90500},
    ],
}


# --- Exploding Topics ------------------------------------------------------


def test_a_hit_carries_the_twelve_month_classification_and_the_raw_map():
    lookup = normalize_et_response("rucking vests", status=200, body=HIT_BODY)

    assert lookup.matched is True
    assert lookup.classification == "peaked"
    assert lookup.classifications == {"3": "exploding", "6": "peaked", "12": "peaked"}
    assert lookup.keyword == "rucking vest"
    assert lookup.absolute_volume == 40500
    assert lookup.total == 3
    assert lookup.miss_reason is None


def test_the_headline_falls_back_to_the_shortest_timeframe_et_reported():
    # Reporting "no classification" for a topic ET classified at 3 and 6
    # months would understate what the oracle said.
    body = {"total": 1, "result": [{"keyword": "head spa", "classifications": {"6": "exploding"}}]}

    assert normalize_et_response("head spa", status=200, body=body).classification == "exploding"


def test_the_two_miss_sentinels_come_back_as_not_in_catalog():
    # Both are HTTP 200 with a message field -- ET does not 404 a miss.
    for message in ("No meta trends found.", "No topic found."):
        lookup = normalize_et_response("head spa", status=200, body={"message": message})
        assert lookup.matched is False
        assert lookup.miss_reason == MISS_NOT_IN_CATALOG
        assert lookup.error is None


def test_an_empty_result_set_is_a_catalog_miss_not_a_failure():
    lookup = normalize_et_response("head spa", status=200, body={"total": 0, "result": []})

    assert lookup.miss_reason == MISS_NOT_IN_CATALOG
    assert lookup.error is None


def test_a_non_200_is_a_lookup_failure_distinct_from_a_catalog_miss():
    lookup = normalize_et_response("head spa", status=403, body=None)

    assert lookup.matched is False
    assert lookup.miss_reason == MISS_LOOKUP_FAILED
    assert lookup.error == "http_403"


def test_no_api_key_is_an_explicit_not_configured_miss():
    # Not a boot failure and not an exception: the PRD lists ET access as an
    # assumption with an owner, so an unwired oracle still lets verdicts land.
    lookup = ExplodingTopicsOracle("").classify("head spa")

    assert lookup.miss_reason == MISS_NOT_CONFIGURED


def test_the_api_key_never_appears_in_the_loggable_target():
    oracle = ExplodingTopicsOracle("SECRET-KEY")

    url, log_target = oracle._request("rucking vests")

    assert "SECRET-KEY" in url
    assert "SECRET-KEY" not in log_target
    assert "rucking+vests" in log_target


def test_an_outage_degrades_to_a_miss_rather_than_raising():
    def dead(**_kwargs):
        raise TimeoutError("read timed out")

    lookup = ExplodingTopicsOracle("k", transport=dead).classify("rucking vests")

    assert lookup.matched is False
    assert lookup.miss_reason == MISS_LOOKUP_FAILED
    assert lookup.error == "TimeoutError"


def test_a_cloudflare_403_degrades_to_a_miss_rather_than_raising():
    def blocked(**_kwargs):
        raise urllib.error.HTTPError("https://x", 403, "Forbidden", {}, None)

    lookup = ExplodingTopicsOracle("k", transport=blocked).classify("rucking vests")

    assert lookup.miss_reason == MISS_LOOKUP_FAILED
    assert lookup.error == "http_403"


def test_a_live_shaped_reply_reaches_the_normalizer_through_the_transport():
    seen: dict[str, object] = {}

    def transport(*, url, timeout_s):
        seen["url"] = url
        seen["timeout_s"] = timeout_s
        return 200, HIT_BODY

    oracle = ExplodingTopicsOracle("k", timeout_s=3.0, transport=transport)

    lookup = oracle.classify("rucking vests")

    assert lookup.classification == "peaked"
    assert seen["timeout_s"] == 3.0
    assert "api_key=k" in str(seen["url"])


# --- GDELT -----------------------------------------------------------------


def test_breadth_counts_distinct_publishers_and_deduplicates_by_url():
    body = {
        "articles": [
            {"url": "https://a.com/1", "domain": "a.com"},
            {"url": "https://a.com/1", "domain": "a.com"},
            {"url": "https://a.com/2", "domain": "a.com"},
            {"url": "https://b.com/1", "domain": "b.com"},
        ]
    }

    reading = normalize_gdelt_response("rucking vests", body=body)

    assert reading.available is True
    assert reading.article_count == 3
    assert reading.distinct_domains == 2
    assert reading.top_domains == ("a.com", "b.com")


def test_a_rate_limit_sentence_is_unavailable_not_a_reading_of_zero():
    # GDELT answers its own rate limit with HTTP 200 and plain prose. Reading
    # that as an empty article list would report "nobody is covering this".
    reader = GdeltBreadthReader(transport=lambda **_kw: "Your query rate is too high.")

    reading = reader.breadth("rucking vests")

    assert reading.available is False
    assert reading.error == "rate_limited"
    assert reading.article_count == 0


def test_a_gdelt_outage_degrades_to_unavailable_rather_than_raising():
    def dead(**_kwargs):
        raise OSError("connection reset")

    reading = GdeltBreadthReader(transport=dead).breadth("rucking vests")

    assert reading.available is False
    assert reading.error == "OSError"


def test_the_gdelt_query_is_phrase_quoted_and_window_bounded():
    reader = GdeltBreadthReader(window_days=3)

    url = reader._url("head spa")

    assert "%22head+spa%22" in url
    assert "timespan=3d" in url


def test_an_available_reading_of_zero_articles_is_a_real_answer():
    reader = GdeltBreadthReader(transport=lambda **_kw: json.dumps({"articles": []}))

    reading = reader.breadth("head spa")

    assert reading.available is True
    assert reading.article_count == 0
    assert reading.error is None


# --- offline flavors -------------------------------------------------------


def test_the_static_oracle_misses_a_subject_it_does_not_carry():
    oracle = StaticSaturationOracle()

    lookup = oracle.classify("head spa")

    assert lookup.matched is False
    assert lookup.miss_reason == MISS_NOT_IN_CATALOG
    assert oracle.queries == ["head spa"]


def test_the_static_flavors_match_a_subject_case_and_whitespace_insensitively():
    oracle, breadth = load_saturation_fixture(
        {
            "Rucking  Vests": {
                "exploding_topics": {
                    "matched": True,
                    "keyword": "rucking vest",
                    "total": 2,
                    "classifications": {"12": "peaked"},
                },
                "gdelt": {"available": True, "article_count": 44, "distinct_domains": 19},
            }
        }
    )

    assert oracle.classify("rucking vests").classification == "peaked"
    assert breadth.breadth("RUCKING VESTS").distinct_domains == 19


def test_the_fixture_loader_skips_comment_keys():
    oracle, _ = load_saturation_fixture({"_comment": ["not a subject"]})

    assert oracle.lookups == {}


def test_the_static_breadth_reader_can_model_a_provider_outage():
    reading = StaticBreadthReader(default_available=False).breadth("head spa")

    assert reading.available is False
