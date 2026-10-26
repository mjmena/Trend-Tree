"""The dead-URL check: discovery's rule (discovery-p_5VCPP3N/canonicalize_and_validate,
canonical helpers in agents/lib/url_canon.mjs), ported to Python.

Only a provably dead or malformed URL drops. 401/403/405/406/429/451, 5xx and
a network error or timeout pass, marked ``unverified``. Discovery's freshness
and title-relevance filters do not apply (spec). HTTP 408 is dead, as in
discovery: the spec's "timeout" is a network timeout, which passes.
"""

from __future__ import annotations

import html
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "utm_name",
        "utm_brand",
        "utm_social",
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "ref",
        "ref_src",
        "ref_url",
        "referrer",
        "_ga",
        "_gl",
        "_gac",
        "yclid",
        "wbraid",
        "gbraid",
        "igshid",
        "twclid",
    }
)
PER_DOMAIN_STRIP = {
    "amazon.com": frozenset({"psc", "th", "linkCode", "linkId", "tag", "ref_", "qid", "sr"}),
    "youtube.com": frozenset({"si", "feature"}),
    "youtu.be": frozenset({"si"}),
}
HARD_DEAD_CODES = frozenset({400, 404, 408, 410, 414})
ACCESS_DENIED_CODES = frozenset({401, 403, 405, 406, 429, 451})
MAX_URL_LENGTH = 2048
USER_AGENT = "Mozilla/5.0 (compatible; Trend-Tree/1.0; +https://github.com/mjmena/Trend-Tree)"
FETCH_TIMEOUT_S = 8
MAX_BODY_BYTES = 65536
MAX_TITLE_CHARS = 300
_META_TITLE = re.compile(
    r"<meta[^>]+(?:property|name)=[\"'](?:og:title|twitter:title)[\"'][^>]*?"
    r"content=[\"']([^\"']+)",
    re.IGNORECASE,
)
_TITLE_TAG = re.compile(r"<title[^>]*>([^<]+)</title>", re.IGNORECASE)

# (url) -> (final url after redirects, HTTP status, page title or None).
# Raises on a network error or timeout, which the check treats as unverified,
# not dead. The title feeds the task handler's topic call (it never re-fetches).
Fetcher = Callable[[str], tuple[str, int, str | None]]


def strip_and_normalize(raw: str) -> str | None:
    """url_canon.mjs's stripAndNormalize: http(s) only, lowercase host minus
    ``www.``, tracking params stripped, no trailing slash (except the root)."""
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host:
        return None
    host = host.removeprefix("www.")
    domain = PER_DOMAIN_STRIP.get(host) or PER_DOMAIN_STRIP.get(host.partition(".")[2])
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k not in TRACKING_PARAMS and not (domain and k in domain)
    ]
    netloc = host if port is None else f"{host}:{port}"
    path = parts.path or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), netloc, path, urlencode(query), ""))


def classify_status(code: int) -> str:
    if 200 <= code < 400:
        return "ok"
    if code in HARD_DEAD_CODES:
        return "dead"
    if code in ACCESS_DENIED_CODES:
        return "denied"
    if code >= 500:
        return "transient"
    return "dead"  # unknown 4xx: discovery errs on the side of dropping


def _usable(canonical: str | None) -> bool:
    return (
        bool(canonical)
        and len(canonical) <= MAX_URL_LENGTH
        and ("vertexaisearch.cloud.google.com" not in canonical)
    )


def page_title(head: str) -> str | None:
    """og:title / twitter:title, else <title>, as discovery's fetchArticleMeta
    reads them (its JSON-LD headline fallback is not ported)."""
    match = _META_TITLE.search(head) or _TITLE_TAG.search(head)
    if not match:
        return None
    title = " ".join(html.unescape(match.group(1)).split())
    return title[:MAX_TITLE_CHARS] or None


def http_fetch(url: str) -> tuple[str, int, str | None]:
    """GET with redirects followed; on a 2xx, the first 64 KB give the title."""
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:  # noqa: S310
            try:
                title = page_title(resp.read(MAX_BODY_BYTES).decode("utf-8", errors="replace"))
            except OSError:  # a body read that times out still leaves a live URL
                title = None
            return resp.geturl(), resp.status, title
    except urllib.error.HTTPError as err:
        return err.geturl() or url, err.code, None


def check_url(raw: str, fetch: Fetcher) -> dict[str, Any]:
    """One URL's verdict: ``{url, reason}`` when dropped, else
    ``{url, canonical, http_status, status_class, unverified, title}``."""
    if not _usable(strip_and_normalize(raw)):
        return {"url": raw, "reason": "malformed"}  # never fetched
    try:
        final_url, status, title = fetch(raw)
    except Exception:  # noqa: BLE001 - network error / timeout: soft-keep, as discovery does
        canonical = strip_and_normalize(raw)
        return {
            "url": raw,
            "canonical": canonical,
            "http_status": 0,
            "status_class": "transient",
            "unverified": True,
            "title": None,
        }
    canonical = strip_and_normalize(final_url or raw)
    if not _usable(canonical):
        return {"url": raw, "reason": "url_too_long_or_redirect"}
    status_class = classify_status(status)
    if status_class == "dead":
        return {"url": raw, "reason": f"dead_{status}"}
    return {
        "url": raw,
        "canonical": canonical,
        "http_status": status,
        "status_class": status_class,
        "unverified": status_class != "ok",
        "title": title,
    }


def check_urls(urls: Iterable[str], fetch: Fetcher) -> tuple[list[dict], list[dict]]:
    """(kept, dropped), in request order; kept is deduped by canonical form."""
    urls = list(urls)
    with ThreadPoolExecutor(max_workers=max(1, len(urls))) as pool:
        verdicts = list(pool.map(lambda u: check_url(u, fetch), urls))
    kept, dropped, seen = [], [], set()
    for v in verdicts:
        if "reason" in v:
            dropped.append(v)
        elif v["canonical"] not in seen:
            seen.add(v["canonical"])
            kept.append(v)
    return kept, dropped
