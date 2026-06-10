// Discovery — canonicalize_and_validate
//
// GET-fetches each proposal's evidence_url, parses ~64KB of HTML head
// to extract og:title + published date, applies freshness/relevance
// filters, dedupes within-batch, and emits signals_json ready for
// MERGE_EXTERNAL_SIGNALS.
//
// Drops a proposal if any of these hold:
//   - URL is hard-bad (404, 410, malformed)
//   - Article publish date is older than max_age_days (default 30)
//   - drop_if_no_date=true AND no date could be extracted
//   - drop_if_title_irrelevant=true AND article title shares zero
//     ≥4-char nonstop words with the proposed topic
//
// Soft-keeps (URL passes through unverified):
//   - 401/403/406/451 (paywall, bot block, geofence)
//   - 429 (rate limit)
//   - 5xx (server temporarily down)
//   - Fetch timeouts/network errors
// These get an `unverified: true` flag in METADATA. Lots of news sites
// block scraping; assuming the LLM's citation is real is the lesser
// evil compared to silently dropping every Bloomberg/NYT/WSJ URL.
//
// Each surviving proposal becomes one row:
//   SIGNAL_ID  = canonical URL
//   METADATA   = adds article_title, published_date, days_since_published, unverified
//
// =====================================================================
// Inlined helpers (canonical: agents/lib/url_canon.mjs)
// =====================================================================

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_brand", "utm_social",
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "referrer",
  "_ga", "_gl", "_gac",
  "yclid", "wbraid", "gbraid",
  "igshid", "twclid",
]);

const PER_DOMAIN_STRIP = {
  "amazon.com": new Set(["psc", "th", "linkCode", "linkId", "tag", "ref_", "qid", "sr"]),
  "youtube.com": new Set(["si", "feature"]),
  "youtu.be":    new Set(["si"]),
};

function stripAndNormalize(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const domainParams = PER_DOMAIN_STRIP[u.hostname] || PER_DOMAIN_STRIP[u.hostname.replace(/^[^.]+\./, "")];
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k) || (domainParams && domainParams.has(k))) u.searchParams.delete(k);
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  s = s.replace(/\?$/, "");
  return s;
}

const TITLE_PATTERNS = [
  /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
  /<title[^>]*>([^<]+)<\/title>/i,
];

const DATE_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+property=["']og:article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']parsely-pub-date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
];

function extractFirst(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function extractDateFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const blob = m[1].trim();
      if (!blob) continue;
      const parsed = JSON.parse(blob);
      const arr = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
      for (const obj of arr) {
        const d = obj?.datePublished || obj?.dateCreated || obj?.uploadDate;
        if (d) return d;
      }
    } catch { /* ignore parse errors */ }
  }
  return null;
}

function extractTitleFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const blob = m[1].trim();
      if (!blob) continue;
      const parsed = JSON.parse(blob);
      const arr = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
      for (const obj of arr) {
        const t = obj?.headline || obj?.name;
        if (typeof t === "string" && t.trim()) return t.trim();
      }
    } catch { /* ignore parse errors */ }
  }
  return null;
}

function parseDateLoose(s) {
  if (!s || typeof s !== "string") return null;
  const dt = new Date(s);
  if (!isNaN(dt)) return dt;
  return null;
}

// Topic↔title overlap: lowercase, strip punctuation, drop common
// stopwords + trend filler. "PFAS-free ceramic cookware" vs "Best
// 2026 furniture trends" → ceramic/cookware vs furniture (no overlap → drop).
const STOPWORDS = new Set([
  "trends","trend","top","best","new","rising","emerging","consumer",
  "the","a","an","and","or","of","in","on","for","with","to","from",
  "is","are","was","were","be","been","by","as","at","this","that",
  "rise","what","why","how","who","one","more","less","most","very",
  "into","over","than","then","just","also","only","like","such",
  "your","their","them","they","its","it's","2024","2025","2026",
]);

function topicTokens(text) {
  if (!text) return new Set();
  return new Set(
    String(text).toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

function titleOverlapsTopic(topic, title) {
  const t = topicTokens(topic);
  const a = topicTokens(title);
  for (const w of t) if (a.has(w)) return true;
  return false;
}

// HTTP status taxonomy for our purposes:
//   "ok"     — 2xx/3xx, body fetched, metadata extractable
//   "denied" — site blocked us (paywall/bot/geo), URL probably real
//   "dead"   — URL definitively gone (404/410)
//   "transient" — server hiccup (5xx), URL probably real
const HARD_DEAD_CODES = new Set([400, 404, 408, 410, 414]);
const ACCESS_DENIED_CODES = new Set([401, 403, 405, 406, 429, 451]);

function classifyStatus(code) {
  if (code >= 200 && code < 400) return "ok";
  if (HARD_DEAD_CODES.has(code)) return "dead";
  if (ACCESS_DENIED_CODES.has(code)) return "denied";
  if (code >= 500) return "transient";
  return "dead"; // unknown 4xx — err on side of dropping
}

async function fetchArticleMeta(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 65536;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(rawUrl, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Trend-Tree/1.0; +https://github.com/mjmena/Trend-Tree)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const finalUrl = resp.url || rawUrl;
    const canonical = stripAndNormalize(finalUrl);
    // 2048 is a junk-URL sanity cap (STG.SIGNAL_ID is no longer VARCHAR(255)
    // — see sql/alter_signal_id_widen.sql); matches the google-trends ingester
    // and the TASK_PROMOTE_TREND_SIGNALS link filter.
    if (!canonical || canonical.length > 2048 || canonical.includes('vertexaisearch.cloud.google.com')) {
      return { canonical: null, http_status: 0, status_class: 'dead', error: 'url_too_long_or_redirect' };
    }
    const status_class = classifyStatus(resp.status);
    if (!resp.ok) {
      // Body likely unavailable on non-2xx — return what we know, classify upstream.
      return { canonical, http_status: resp.status, status_class };
    }

    // Read up to maxBytes of body (head usually fits)
    const chunks = [];
    let total = 0;
    if (resp.body && resp.body.getReader) {
      const reader = resp.body.getReader();
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");

    const article_title = (extractFirst(html, TITLE_PATTERNS) || extractTitleFromJsonLd(html))?.slice(0, 300) || null;
    const dateRaw = extractFirst(html, DATE_PATTERNS) || extractDateFromJsonLd(html);
    let published_date = parseDateLoose(dateRaw);
    if (!published_date) {
      const lm = resp.headers.get("last-modified");
      published_date = parseDateLoose(lm);
    }

    return {
      canonical,
      http_status: resp.status,
      status_class,
      article_title,
      published_date: published_date ? published_date.toISOString() : null,
    };
  } catch (e) {
    // Network errors (DNS, timeout, conn reset) — treat as transient, soft-keep
    // with the original URL stripped/normalized so dedup still works.
    const rawCanonical = stripAndNormalize(rawUrl);
    return {
      canonical: (rawCanonical && rawCanonical.length <= 2048 && !rawCanonical.includes('vertexaisearch.cloud.google.com'))
        ? rawCanonical : null,
      http_status: 0,
      status_class: "transient",
      error: e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Step entrypoint
// =====================================================================

export default defineComponent({
  props: {
    proposals: { type: "any", label: "rerank_claude output" },
    max_age_days: {
      type: "integer",
      label: "Max article age (days)",
      description: "Drop proposals citing articles older than this. The discovery LLMs sometimes cite year-old explainers as evidence of current trends — this filter cuts those.",
      default: 30,
    },
    drop_if_no_date: {
      type: "boolean",
      label: "Drop proposals with no extractable publish date",
      description: "Strict mode. False (default) keeps undated articles since many small/personal sites omit metadata. Set true if you only trust mainstream-press sources.",
      default: false,
    },
    drop_if_title_irrelevant: {
      type: "boolean",
      label: "Drop if article title doesn't share words with topic",
      description: "Catches the 'cited a Lululemon-clothing PFAS article as evidence of ceramic cookware trend' failure. Permissive (any 4+ char nonstop word overlap keeps).",
      default: true,
    },
  },
  async run({ $ }) {
    const kept = this.proposals?.kept_proposals || [];
    if (kept.length === 0) {
      console.log("No proposals to canonicalize");
      $.export("$summary", "0 proposals → 0 signals");
      return { signals_json: "[]", signal_count: 0 };
    }
    const maxAgeDays = this.max_age_days ?? 30;
    const dropIfNoDate = this.drop_if_no_date ?? false;
    const dropIfTitleIrrelevant = this.drop_if_title_irrelevant ?? true;
    const nowMs = Date.now();

    // GET each URL in parallel (8s timeout, 64KB body cap).
    const resolved = await Promise.all(kept.map(async (p) => {
      if (!p.evidence_url) return { ...p, _drop_reason: "missing_url" };
      const r = await fetchArticleMeta(p.evidence_url, { timeoutMs: 8000 });
      if (!r.canonical) {
        return { ...p, _drop_reason: "no_canonical" };
      }

      // Hard-dead URLs are dropped. Access-denied / transient / 5xx
      // soft-keep — the URL is probably real, we just couldn't peek.
      if (r.status_class === "dead") {
        return { ...p, _canonical: r.canonical, _http_status: r.http_status, _drop_reason: `dead_${r.http_status || "x"}` };
      }
      const unverified = r.status_class !== "ok";

      const enriched = {
        ...p,
        _canonical: r.canonical,
        _http_status: r.http_status,
        _status_class: r.status_class,
        _unverified: unverified,
        _article_title: r.article_title || null,
        _published_date: r.published_date || null,
        _days_since_published: r.published_date
          ? Math.round((nowMs - new Date(r.published_date).getTime()) / 86400000)
          : null,
      };

      // Freshness filter — only applies when we actually got the article.
      // Unverified URLs skip date checks (we have nothing to check).
      if (!unverified) {
        if (enriched._days_since_published != null && enriched._days_since_published > maxAgeDays) {
          return { ...enriched, _drop_reason: `stale_${enriched._days_since_published}d` };
        }
        if (!enriched._published_date && dropIfNoDate) {
          return { ...enriched, _drop_reason: "no_date" };
        }

        // Title-relevance filter — same: only when we have a title.
        if (dropIfTitleIrrelevant && enriched._article_title
            && !titleOverlapsTopic(p.topic, enriched._article_title)) {
          return { ...enriched, _drop_reason: "title_irrelevant" };
        }
      }

      return { ...enriched, _drop_reason: null };
    }));

    // Aggregate drop reasons
    const drops = { dead: 0, stale: 0, no_date: 0, title_irrelevant: 0, dupe: 0, invalid: 0 };
    let kept_unverified = 0;
    const byUrl = new Map();
    for (const r of resolved) {
      if (r._drop_reason) {
        if (r._drop_reason.startsWith("dead_")) drops.dead++;
        else if (r._drop_reason.startsWith("stale_")) drops.stale++;
        else if (r._drop_reason === "no_date") drops.no_date++;
        else if (r._drop_reason === "title_irrelevant") drops.title_irrelevant++;
        else drops.invalid++;
        continue;
      }
      if (r._unverified) kept_unverified++;
      const existing = byUrl.get(r._canonical);
      if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
        if (existing) drops.dupe++;
        byUrl.set(r._canonical, r);
      } else {
        drops.dupe++;
      }
    }

    const now = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
    const signals = [];
    for (const r of byUrl.values()) {
      signals.push({
        SIGNAL_ID: r._canonical,
        SOURCE_NAME: `agent_${r.source_model}_discovery`,
        SIGNAL_TIMESTAMP: r._published_date
          ? r._published_date.replace("T", " ").replace(/\..+$/, "").slice(0, 19)
          : now,
        SIGNAL_TITLE: r.topic,
        SIGNAL_TEXT: `${r.topic} — ${r.why_now}`,
        URL: r._canonical,
        METADATA: JSON.stringify({
          source_model: r.source_model,
          source_model_full: r.source_model_full,
          rerank_score: r.score,
          rerank_reasoning: r.reasoning,
          why_now: r.why_now,
          vertical: r.vertical || null,
          original_url: r.evidence_url,
          canonical_url: r._canonical,
          http_status: r._http_status,
          status_class: r._status_class,
          unverified: r._unverified || false,
          article_title: r._article_title,
          article_published_date: r._published_date,
          days_since_published: r._days_since_published,
        }),
      });
    }

    const dropSummary = Object.entries(drops).filter(([, v]) => v > 0).map(([k, v]) => `${v}${k}`).join(" ");
    const verifiedSummary = kept_unverified ? ` (${kept_unverified} unverified)` : "";
    console.log(
      `Canonicalize: ${kept.length} kept → ${signals.length} signals${verifiedSummary} (${dropSummary || "no drops"})`,
    );
    $.export("$summary", `${signals.length} signals${verifiedSummary} (${kept.length}→ ${dropSummary || "no drops"})`);

    return {
      signals_json: JSON.stringify(signals),
      signal_count: signals.length,
      kept_unverified,
      drops,
      // Legacy keys for backward compatibility with respond step
      dropped_404: drops.dead,
      dropped_dupe: drops.dupe,
      dropped_invalid: drops.invalid + drops.stale + drops.no_date + drops.title_irrelevant,
    };
  },
});
