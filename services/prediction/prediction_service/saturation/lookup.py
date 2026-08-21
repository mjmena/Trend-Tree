"""The two external lookups behind ``EVIDENCE.saturation`` (CRMA-765).

Saturation is *evidence*, so this module's whole job is to come back with
something the model can read -- never to decide anything. Two oracles:

* **Exploding Topics** (``SaturationOracle``) -- the corroboration oracle
  ADR-0004 already runs at the promotion gate, re-used here in its second
  documented role. Looked up by the prediction's subject descriptor, which is
  the ``descriptor.query`` register ADR-0003 specifies: an atomic,
  consumer-vernacular term, the string shape ET rewards (~67% match vs ~6%
  for a compound topic).
* **GDELT article breadth** (``BreadthReader``) -- how many US-English news
  articles, across how many distinct publishers, mention the subject in the
  recent window. Breadth in this repo means *cross-publisher* breadth
  (CONTEXT.md, [heat index]), so the distinct-domain count is the headline
  number and the article count rides alongside it.

**Every failure is a miss, and a miss is never a penalty.** The PRD lists ET
access as "an assumption with an owner (a miss is never a penalty)", and the
strategy adds that ET's catalog skews away from local and news topics -- so
absence from it is not evidence against a claim. Neither adapter here raises:
a 403, a timeout, a rate-limited body, an unparseable payload and a genuine
"not in the catalog" all come back as a ``SaturationLookup`` /
``ArticleBreadth`` that says so in ``miss_reason`` / ``error``. The distinction
between "we looked and found nothing" and "we could not look" is preserved
because it is worth saying out loud in the evidence, not because the two are
weighed differently.

Both are Protocols first and adapters second, matching ``PredictionLLM`` and
``SignalReader``: tests run fully offline against the static flavors at the
bottom of this file, so an ET outage is an ordinary tested path.
"""

from __future__ import annotations

import http.client
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

log = logging.getLogger(__name__)

# --- Exploding Topics ------------------------------------------------------

#: Base URL, browser User-Agent and the two HTTP-200 miss sentinels all come
#: from ``agents/lib/exploding_topics.mjs``, the repo's canonical ET adapter
#: (ADR-0004), which in turn cites docs/exploding-topics-api.md. This is the
#: same contract in Python, not a second opinion about it: ET sits behind
#: Cloudflare and silently 403s a default library User-Agent, and it answers
#: both miss shapes with HTTP 200 and a ``message`` field.
ET_BASE_URL = "https://api.explodingtopics.com/api/v1"
ET_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
ET_MISS_MESSAGES = ("No meta trends found.", "No topic found.")

#: ET returns ``classifications`` per timeframe (keys "3", "6", "12", "24",
#: "60", "120", "180", "forecast_12"). The 12-month verdict is the headline
#: one -- it is the window the strategy's saturation reading is about ("the
#: world has piled on"), and it is the timeframe ADR-0004's decision record
#: snapshots. The whole map still reaches the evidence and the prompt, so a
#: subject that is ``peaked`` at 3 months and ``exploding`` at 24 is readable
#: as exactly that rather than flattened into one word.
ET_HEADLINE_TIMEFRAME = "12"

ET_DEFAULT_TIMEFRAME = "last_12_months"
#: Lowered from 20s with the phase-level lookup budget (see run.py): the two
#: lookups run per surviving subject, so the per-call ceiling is what decides
#: how many subjects a stalling provider can eat before the budget expires and
#: the rest degrade to explicit misses. ET answers a search in well under a
#: second when it answers at all.
ET_DEFAULT_TIMEOUT_S = 12.0

#: How many of ET's fuzzy results ride along as candidates. Same slice
#: ``normalizeEtResponse`` takes in agents/lib/exploding_topics.mjs, and for
#: the same reason: /database-search is fuzzy, so the near-misses are what let
#: the agent judge whether the top match is genuinely the same concept.
ET_CANDIDATE_LIMIT = 5

#: The classification the strategy singles out: "``peaked`` argues against
#: high confidence; nothing is mechanically excluded". Named here so the
#: prompt builder and the tests can both say the word without spelling it
#: twice -- and deliberately NOT used in any comparison that changes a number
#: or drops a candidate. Grep for it: the only readers are prompt text and
#: test assertions.
CLASSIFICATION_PEAKED = "peaked"

#: Why a lookup came back without a classification. All three are misses and
#: all three carry the same weight, which is none. They are distinguished
#: because the evidence should say which happened, not because anything
#: downstream treats them differently.
MISS_NOT_IN_CATALOG = "not_in_catalog"
MISS_NOT_CONFIGURED = "not_configured"
MISS_LOOKUP_FAILED = "lookup_failed"

#: ``error`` on a lookup the phase never got to: the run spent its lookup
#: budget on earlier subjects (see run.py). A miss, like every other one here,
#: and it carries no penalty -- it says "we did not get to look", which is the
#: honest reading and is exactly what an outage says.
ERROR_DEADLINE_EXCEEDED = "deadline_exceeded"


@dataclass(frozen=True)
class SaturationLookup:
    """What Exploding Topics said about one subject descriptor.

    ``matched`` is ET's transport-level hit (``total > 0``) and nothing more.
    ``/database-search`` is fuzzy and returns near-matches, so ``keyword`` is
    carried alongside the subject we asked about and the *model* judges
    whether they are the same concept -- the same division of labour ADR-0004
    draws at the promotion gate, where "deciding is this the same concept is
    a judgment the agent should own" was the reason a deterministic
    ``total > 0`` check was rejected.
    """

    query: str
    matched: bool
    classification: str | None = None
    #: Which timeframe ``classification`` actually came from ("12" normally;
    #: the shortest window ET reported when it had no 12-month verdict). Kept
    #: because a 3-month ``peaked`` and a 12-month ``peaked`` are materially
    #: different claims about how far along the world is, and the prompt and
    #: the ledger both have to say which one they are showing.
    classification_timeframe: str | None = None
    classifications: Mapping[str, Any] | None = None
    growth: Mapping[str, Any] | None = None
    keyword: str | None = None
    path: str | None = None
    absolute_volume: int | None = None
    #: Up to ``ET_CANDIDATE_LIMIT`` of the fuzzy results, top one included --
    #: what agents/lib/exploding_topics.mjs calls ``candidates``, carried for
    #: the same reason: the model is asked to judge whether ET matched the
    #: same concept, and it can only do that if it sees what else ET offered.
    candidates: tuple[Mapping[str, Any], ...] = ()
    total: int = 0
    #: Set on every non-match. See the MISS_* constants.
    miss_reason: str | None = None
    #: Set only when the lookup could not be performed (transport, auth,
    #: unparseable body). Always accompanied by ``miss_reason`` =
    #: ``lookup_failed``.
    error: str | None = None


class SaturationOracle(Protocol):
    """Exploding Topics, as the rest of this service sees it. One method, no
    exceptions: a failed lookup is a ``SaturationLookup`` that says so."""

    def classify(self, query: str) -> SaturationLookup: ...


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _headline_classification(classifications: Any) -> tuple[str | None, str | None]:
    """``(classification, timeframe)`` -- the 12-month verdict, or the shortest
    timeframe ET did return, **and which one it was**.

    Falling back to the shortest available window rather than to None is the
    honest default: a topic ET classified at 3 and 6 months but not at 12 has
    a classification, and reporting "no classification" would understate what
    the oracle actually said. But the fallback has to travel with its
    timeframe: "peaked at 3 months" and "peaked at 12 months" are different
    claims about how far along the world is, and ``peaked`` is the exact word
    the weighing prompt says argues against high confidence. Rendering a
    3-month reading as the 12-month one would put a claim in the model's --
    and the ledger's -- mouth that the oracle never made.
    """
    if not isinstance(classifications, Mapping):
        return None, None
    headline = classifications.get(ET_HEADLINE_TIMEFRAME)
    if isinstance(headline, str) and headline.strip():
        return headline.strip(), ET_HEADLINE_TIMEFRAME
    numeric = sorted(
        (int(k), str(k), v)
        for k, v in classifications.items()
        if str(k).isdigit() and isinstance(v, str) and v.strip()
    )
    if not numeric:
        return None, None
    _, timeframe, value = numeric[0]
    return value.strip(), timeframe


def _candidates(results: list[Mapping[str, Any]]) -> tuple[Mapping[str, Any], ...]:
    """ET's fuzzy result list, reduced to what the model needs to judge
    concept-sameness. Mirrors ``normalizeEtResponse``'s ``candidates``."""
    return tuple(
        {
            "keyword": str(r.get("keyword")) if r.get("keyword") else None,
            "path": str(r.get("path")) if r.get("path") else None,
            "absolute_volume": _as_int(r.get("absolute_volume")),
            "categories": r.get("categories") if r.get("categories") else None,
        }
        for r in results[:ET_CANDIDATE_LIMIT]
    )


def normalize_et_response(query: str, *, status: int | None, body: Any) -> SaturationLookup:
    """Pure. Turn a raw ``/database-search`` reply into a ``SaturationLookup``.

    Mirrors ``normalizeEtResponse`` in agents/lib/exploding_topics.mjs -- same
    miss sentinels, same "top result plus up to five candidates" reading (see
    ``candidates`` below), same refusal to treat ``total > 0`` as
    corroboration.
    """
    if status is not None and status != 200:
        return SaturationLookup(
            query=query,
            matched=False,
            miss_reason=MISS_LOOKUP_FAILED,
            error=f"http_{status}",
        )

    payload = body if isinstance(body, Mapping) else {}
    message = payload.get("message")
    if isinstance(message, str) and message.strip() in ET_MISS_MESSAGES:
        return SaturationLookup(query=query, matched=False, miss_reason=MISS_NOT_IN_CATALOG)

    raw_results = payload.get("result")
    results = [r for r in raw_results if isinstance(r, Mapping)] if isinstance(
        raw_results, list
    ) else []
    total = _as_int(payload.get("total"))
    if total is None:
        total = len(results)
    if total <= 0 or not results:
        return SaturationLookup(query=query, matched=False, miss_reason=MISS_NOT_IN_CATALOG)

    top = results[0]
    classifications = top.get("classifications")
    growth = top.get("growth")
    classification, timeframe = _headline_classification(classifications)
    return SaturationLookup(
        query=query,
        matched=True,
        classification=classification,
        classification_timeframe=timeframe,
        classifications=classifications if isinstance(classifications, Mapping) else None,
        growth=growth if isinstance(growth, Mapping) else None,
        keyword=str(top.get("keyword")) if top.get("keyword") else None,
        path=str(top.get("path")) if top.get("path") else None,
        absolute_volume=_as_int(top.get("absolute_volume")),
        candidates=_candidates(results),
        total=total,
    )


class ExplodingTopicsOracle:
    """The deployed ET adapter. ``transport`` is injectable so the wire
    handling is exercised without a network."""

    def __init__(
        self,
        api_key: str,
        *,
        timeout_s: float = ET_DEFAULT_TIMEOUT_S,
        response_timeframe: str = ET_DEFAULT_TIMEFRAME,
        transport: Any = None,
    ) -> None:
        self._api_key = api_key
        self._timeout_s = timeout_s
        self._response_timeframe = response_timeframe
        self._transport = transport

    def _request(self, query: str) -> tuple[str, str]:
        """``(url, log_target)``. The api_key rides in the query string, so
        ``url`` is SECRET and is never logged -- ``log_target`` is the same
        endpoint without it."""
        params = {"keyword": query, "response_timeframe": self._response_timeframe}
        safe = urllib.parse.urlencode(params)
        secret = urllib.parse.urlencode({"api_key": self._api_key, **params})
        return (
            f"{ET_BASE_URL}/database-search?{secret}",
            f"{ET_BASE_URL}/database-search?{safe}",
        )

    def classify(self, query: str) -> SaturationLookup:
        subject = (query or "").strip()
        if not subject:
            return SaturationLookup(
                query=query, matched=False, miss_reason=MISS_NOT_IN_CATALOG
            )
        if not self._api_key.strip():
            return SaturationLookup(
                query=subject, matched=False, miss_reason=MISS_NOT_CONFIGURED
            )

        url, log_target = self._request(subject)
        try:
            if self._transport is not None:
                status, body = self._transport(url=url, timeout_s=self._timeout_s)
            else:
                request = urllib.request.Request(  # noqa: S310 - fixed https endpoint
                    url, headers={"User-Agent": ET_BROWSER_UA}, method="GET"
                )
                with urllib.request.urlopen(  # noqa: S310
                    request, timeout=self._timeout_s
                ) as resp:
                    status, body = resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            return SaturationLookup(
                query=subject,
                matched=False,
                miss_reason=MISS_LOOKUP_FAILED,
                error=f"http_{err.code}",
            )
        except (OSError, http.client.HTTPException, json.JSONDecodeError, ValueError) as err:
            # An outage is a miss, not a failed run. Never re-raise: the
            # verdict is still worth writing, it just carries "we could not
            # look" instead of a classification.
            log.warning("exploding topics lookup failed for %s: %s", log_target, err)
            return SaturationLookup(
                query=subject,
                matched=False,
                miss_reason=MISS_LOOKUP_FAILED,
                error=type(err).__name__,
            )
        return normalize_et_response(subject, status=status, body=body)


# --- GDELT article breadth -------------------------------------------------

GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

#: GDELT silently drops requests carrying undici's or urllib's default
#: User-Agent -- the same class of gotcha as ET's Cloudflare 403. The string
#: is the one this repo's own GDELT tool already sends
#: (ingestion/tools/search-gdelt-p_WxCppoa).
GDELT_UA = "Mozilla/5.0 (compatible; TrendTreeBot/1.0; +https://mcclatchy.com)"

#: 75 matches the repo's existing GDELT callers; above ~150 the API reliably
#: 429s. Breadth here is a shape, not a census -- what matters is whether
#: three publishers or thirty have written about the subject.
GDELT_MAX_RECORDS = 75
GDELT_DEFAULT_WINDOW_DAYS = 7
#: Lowered from 25s alongside ET's, for the reason in ET_DEFAULT_TIMEOUT_S:
#: the phase-level budget (run.py) is what protects the request, and a lower
#: per-call ceiling is what lets more subjects fit inside it when GDELT starts
#: stalling rather than answering.
GDELT_DEFAULT_TIMEOUT_S = 15.0

#: Characters GDELT's DOC query language treats as syntax. The phrase we build
#: comes from a model-authored descriptor, so they are stripped rather than
#: escaped -- the API has no escape form for a double quote inside a phrase,
#: and a subject containing one would otherwise close the phrase early
#: (``"head "spa""``) and turn the reading into garbage.
GDELT_QUERY_SYNTAX_CHARS = '"()'

#: Longest phrase we will send. GDELT rejects an over-long query outright, and
#: truncating a phrase mid-subject would search for something the model never
#: proposed -- so an over-long descriptor is an explicit "we could not look"
#: rather than a reading of a different string. A descriptor this long is
#: already outside ADR-0003's atomic-term register.
GDELT_MAX_PHRASE_CHARS = 120

#: The two ways a 200 can come back as prose instead of JSON. GDELT answers
#: its own rate limit that way, and it answers a malformed or unsupported
#: query that way too -- recording the second as the first would put "we were
#: throttled" in the ledger for what was really our own bad query.
GDELT_ERROR_RATE_LIMITED = "rate_limited"
GDELT_ERROR_NON_JSON = "non_json_response"
GDELT_ERROR_QUERY_TOO_LONG = "query_too_long"
GDELT_ERROR_EMPTY_QUERY = "empty_query"

#: Substrings that identify the throttle reply. GDELT has worded it several
#: ways ("Your query rate is too high", "rate limit exceeded"); anything else
#: non-JSON is our query's problem, not our request rate's.
_GDELT_RATE_LIMIT_MARKERS = ("rate limit", "query rate", "too many requests", "throttl")

#: The GDELT-side "we were not consulted" string. Deliberately not ET's
#: ``MISS_LOOKUP_FAILED``: the two providers have unrelated vocabularies and a
#: reader of a ledger row should not have to know they were ever shared.
BREADTH_NOT_CONSULTED = "not_consulted"


def gdelt_phrase(query: str) -> str:
    """The subject as a GDELT phrase term -- syntax stripped, whitespace
    collapsed. Pure, and the only place the query string is built."""
    cleaned = "".join(" " if ch in GDELT_QUERY_SYNTAX_CHARS else ch for ch in query)
    return " ".join(cleaned.split())


def gdelt_non_json_error(text: str) -> str:
    """Which of the two non-JSON 200s this is. See the constants above."""
    lowered = text.lower()
    if any(marker in lowered for marker in _GDELT_RATE_LIMIT_MARKERS):
        return GDELT_ERROR_RATE_LIMITED
    return GDELT_ERROR_NON_JSON

#: How many publisher domains the evidence names. The rest are counted, not
#: listed -- the model needs the shape of the coverage, not a directory.
GDELT_TOP_DOMAINS = 8


@dataclass(frozen=True)
class ArticleBreadth:
    """How broadly the news world is already talking about a subject.

    ``distinct_domains`` is the headline: breadth in this repo means
    cross-publisher breadth (CONTEXT.md, [heat index]), and one wire story
    syndicated forty times is one publisher's judgment repeated, not forty.
    """

    query: str
    available: bool
    article_count: int = 0
    distinct_domains: int = 0
    top_domains: tuple[str, ...] = ()
    window_days: int = GDELT_DEFAULT_WINDOW_DAYS
    #: Set when the lookup could not be performed. ``available`` is then
    #: False and the counts are zero -- which the evidence renders as "we
    #: could not look", never as "nobody is writing about this".
    error: str | None = None


class BreadthReader(Protocol):
    """GDELT article breadth, as the rest of this service sees it. Like
    ``SaturationOracle``, it never raises."""

    def breadth(self, query: str) -> ArticleBreadth: ...


def normalize_gdelt_response(
    query: str, *, body: Any, window_days: int = GDELT_DEFAULT_WINDOW_DAYS
) -> ArticleBreadth:
    """Pure. Count articles and distinct publisher domains in a DOC API
    ``ArtList`` reply, deduplicating by URL first."""
    payload = body if isinstance(body, Mapping) else {}
    raw = payload.get("articles")
    articles = [a for a in raw if isinstance(a, Mapping)] if isinstance(raw, list) else []

    seen_urls: set[str] = set()
    domain_counts: dict[str, int] = {}
    for article in articles:
        url = str(article.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        domain = str(article.get("domain") or "").strip().lower()
        if domain:
            domain_counts[domain] = domain_counts.get(domain, 0) + 1

    ranked = sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return ArticleBreadth(
        query=query,
        available=True,
        article_count=len(seen_urls),
        distinct_domains=len(domain_counts),
        top_domains=tuple(domain for domain, _ in ranked[:GDELT_TOP_DOMAINS]),
        window_days=window_days,
    )


class GdeltBreadthReader:
    """The deployed GDELT adapter. ``transport`` is injectable, same as
    ``ExplodingTopicsOracle``."""

    def __init__(
        self,
        *,
        window_days: int = GDELT_DEFAULT_WINDOW_DAYS,
        timeout_s: float = GDELT_DEFAULT_TIMEOUT_S,
        transport: Any = None,
    ) -> None:
        self._window_days = max(1, int(window_days))
        self._timeout_s = timeout_s
        self._transport = transport

    def _url(self, phrase: str) -> str:
        """``phrase`` must already have been through ``gdelt_phrase``."""
        params = urllib.parse.urlencode(
            {
                # Quoted so a multi-word subject is one phrase, not an OR of
                # its words -- an unquoted "head spa" counts every article
                # containing "head". The phrase itself carries no quote or
                # bracket by then (gdelt_phrase), so the quoting cannot be
                # broken from inside by a model-authored descriptor.
                "query": f'"{phrase}" sourcelang:english',
                "mode": "ArtList",
                "format": "json",
                "maxrecords": str(GDELT_MAX_RECORDS),
                "timespan": f"{self._window_days}d",
            }
        )
        return f"{GDELT_DOC_URL}?{params}"

    def breadth(self, query: str) -> ArticleBreadth:
        subject = (query or "").strip()
        phrase = gdelt_phrase(subject)
        if not phrase:
            return ArticleBreadth(
                query=query,
                available=False,
                window_days=self._window_days,
                error=GDELT_ERROR_EMPTY_QUERY,
            )
        if len(phrase) > GDELT_MAX_PHRASE_CHARS:
            # Not a gate: an unreadable breadth reading is exactly as
            # penalty-free as an outage, and saying "we could not look" beats
            # searching for a truncated phrase the model never proposed.
            return ArticleBreadth(
                query=subject,
                available=False,
                window_days=self._window_days,
                error=GDELT_ERROR_QUERY_TOO_LONG,
            )
        url = self._url(phrase)
        try:
            if self._transport is not None:
                text = self._transport(url=url, timeout_s=self._timeout_s)
            else:
                request = urllib.request.Request(  # noqa: S310 - fixed https endpoint
                    url,
                    headers={"User-Agent": GDELT_UA, "Accept": "application/json"},
                    method="GET",
                )
                with urllib.request.urlopen(  # noqa: S310
                    request, timeout=self._timeout_s
                ) as resp:
                    text = resp.read().decode(errors="replace")
            stripped = text.lstrip()
            if not stripped.startswith(("{", "[")):
                # GDELT answers its own rate limit with HTTP 200 and a plain
                # sentence. Reading that as an empty article list would
                # report "nobody is covering this" for "we were throttled" --
                # and reading a rejected query as a throttle would blame the
                # provider for our own string. Both are unavailable; the
                # evidence says which.
                error = gdelt_non_json_error(stripped)
                log.warning("gdelt returned a non-JSON body for %r: %s", subject, error)
                return ArticleBreadth(
                    query=subject,
                    available=False,
                    window_days=self._window_days,
                    error=error,
                )
            body = json.loads(stripped)
        except urllib.error.HTTPError as err:
            return ArticleBreadth(
                query=subject,
                available=False,
                window_days=self._window_days,
                error=f"http_{err.code}",
            )
        except (OSError, http.client.HTTPException, json.JSONDecodeError, ValueError) as err:
            log.warning("gdelt breadth lookup failed for %r: %s", subject, err)
            return ArticleBreadth(
                query=subject,
                available=False,
                window_days=self._window_days,
                error=type(err).__name__,
            )
        return normalize_gdelt_response(subject, body=body, window_days=self._window_days)


# --- offline flavors -------------------------------------------------------


@dataclass
class StaticSaturationOracle:
    """Whatever the caller says, keyed by subject descriptor (case- and
    whitespace-insensitive). Anything not in the map is an explicit miss --
    which is the point: "absent from ET" is the normal path, not an error
    path, and it is what tests/AC2 exercise."""

    lookups: Mapping[str, SaturationLookup] = field(default_factory=dict)
    #: The miss recorded for a subject the map does not carry. Defaults to
    #: "ET does not have this", which is what an empty map means offline; a
    #: service with no ET key configured passes ``not_configured``.
    default_miss_reason: str = MISS_NOT_IN_CATALOG
    queries: list[str] = field(default_factory=list)

    def classify(self, query: str) -> SaturationLookup:
        self.queries.append(query)
        key = " ".join((query or "").split()).casefold()
        for name, lookup in self.lookups.items():
            if " ".join(name.split()).casefold() == key:
                return lookup
        return SaturationLookup(
            query=query, matched=False, miss_reason=self.default_miss_reason
        )


@dataclass
class StaticBreadthReader:
    """GDELT's offline flavor. Unknown subjects come back as a real,
    available reading of zero articles -- "we looked, nobody has written
    about it", which is a legitimate and informative state."""

    readings: Mapping[str, ArticleBreadth] = field(default_factory=dict)
    default_available: bool = True
    queries: list[str] = field(default_factory=list)

    def breadth(self, query: str) -> ArticleBreadth:
        self.queries.append(query)
        key = " ".join((query or "").split()).casefold()
        for name, reading in self.readings.items():
            if " ".join(name.split()).casefold() == key:
                return reading
        return ArticleBreadth(
            query=query,
            available=self.default_available,
            error=None if self.default_available else BREADTH_NOT_CONSULTED,
        )


def load_saturation_fixture(
    payload: Mapping[str, Any],
) -> tuple[StaticSaturationOracle, StaticBreadthReader]:
    """Build the offline pair from a recorded readings file.

    Shape: ``{subject: {"exploding_topics": {...}, "gdelt": {...}}}``. Keys
    beginning with ``_`` are comments and are skipped. A subject the file does
    not carry falls through to the static flavors' defaults -- an explicit ET
    miss and an available reading of zero articles.
    """
    lookups: dict[str, SaturationLookup] = {}
    readings: dict[str, ArticleBreadth] = {}
    for subject, entry in payload.items():
        if subject.startswith("_") or not isinstance(entry, Mapping):
            continue
        et = entry.get("exploding_topics")
        if isinstance(et, Mapping):
            classifications = et.get("classifications")
            classification, timeframe = _headline_classification(classifications)
            raw_candidates = et.get("candidates")
            lookups[subject] = SaturationLookup(
                query=subject,
                matched=bool(et.get("matched")),
                classification=classification,
                classification_timeframe=timeframe,
                classifications=classifications if isinstance(classifications, Mapping) else None,
                growth=et.get("growth") if isinstance(et.get("growth"), Mapping) else None,
                keyword=et.get("keyword"),
                path=et.get("path"),
                absolute_volume=_as_int(et.get("absolute_volume")),
                candidates=_candidates(
                    [c for c in raw_candidates if isinstance(c, Mapping)]
                    if isinstance(raw_candidates, list)
                    else []
                ),
                total=_as_int(et.get("total")) or 0,
                miss_reason=et.get("miss_reason")
                or (None if et.get("matched") else MISS_NOT_IN_CATALOG),
                error=et.get("error"),
            )
        gdelt = entry.get("gdelt")
        if isinstance(gdelt, Mapping):
            readings[subject] = ArticleBreadth(
                query=subject,
                available=bool(gdelt.get("available", True)),
                article_count=_as_int(gdelt.get("article_count")) or 0,
                distinct_domains=_as_int(gdelt.get("distinct_domains")) or 0,
                top_domains=tuple(str(d) for d in gdelt.get("top_domains") or ()),
                window_days=_as_int(gdelt.get("window_days")) or GDELT_DEFAULT_WINDOW_DAYS,
                error=gdelt.get("error"),
            )
    return StaticSaturationOracle(lookups=lookups), StaticBreadthReader(readings=readings)
