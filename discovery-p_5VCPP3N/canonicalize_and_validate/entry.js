// Discovery — canonicalize_and_validate
//
// GET-fetches each proposal's evidence_url, parses ~64KB of HTML head
// to extract og:title + published date, applies freshness/relevance
// filters, dedupes within-batch, and emits signals_json ready for
// MERGE_EXTERNAL_SIGNALS.
//
// Drops a proposal if any of these hold:
//   - URL doesn't resolve / 4xx
//   - Article publish date is older than max_age_days (default 30)
//   - drop_if_no_date=true AND no date could be extracted
//   - drop_if_title_irrelevant=true AND article title shares zero
//     ≥4-char nonstop words with the proposed topic
//
// Each surviving proposal becomes one row:
//   SIGNAL_ID  = canonical URL
//   METADATA   = adds article_title, published_date, days_since_published
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
    if (!resp.ok) {
      return { canonical, http_status: resp.status };
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

    const article_title = extractFirst(html, TITLE_PATTERNS)?.slice(0, 300) || null;
    const dateRaw = extractFirst(html, DATE_PATTERNS) || extractDateFromJsonLd(html);
    let published_date = parseDateLoose(dateRaw);
    if (!published_date) {
      const lm = resp.headers.get("last-modified");
      published_date = parseDateLoose(lm);
    }

    return {
      canonical,
      http_status: resp.status,
      article_title,
      published_date: published_date ? published_date.toISOString() : null,
    };
  } catch (e) {
    return { canonical: null, http_status: 0, error: e.message };
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
        return { ...p, _drop_reason: r.error ? `error:${r.error}` : "no_canonical" };
      }
      if (r.http_status >= 400) {
        return { ...p, _canonical: r.canonical, _http_status: r.http_status, _drop_reason: `http_${r.http_status}` };
      }

      const enriched = {
        ...p,
        _canonical: r.canonical,
        _http_status: r.http_status,
        _article_title: r.article_title || null,
        _published_date: r.published_date || null,
        _days_since_published: r.published_date
          ? Math.round((nowMs - new Date(r.published_date).getTime()) / 86400000)
          : null,
      };

      // Freshness filter
      if (enriched._days_since_published != null && enriched._days_since_published > maxAgeDays) {
        return { ...enriched, _drop_reason: `stale_${enriched._days_since_published}d` };
      }
      if (!enriched._published_date && dropIfNoDate) {
        return { ...enriched, _drop_reason: "no_date" };
      }

      // Title-relevance filter
      if (dropIfTitleIrrelevant && enriched._article_title
          && !titleOverlapsTopic(p.topic, enriched._article_title)) {
        return { ...enriched, _drop_reason: "title_irrelevant" };
      }

      return { ...enriched, _drop_reason: null };
    }));

    // Aggregate drop reasons
    const drops = { http_4xx: 0, stale: 0, no_date: 0, title_irrelevant: 0, dupe: 0, invalid: 0 };
    const byUrl = new Map();
    for (const r of resolved) {
      if (r._drop_reason) {
        if (r._drop_reason.startsWith("http_4")) drops.http_4xx++;
        else if (r._drop_reason.startsWith("stale_")) drops.stale++;
        else if (r._drop_reason === "no_date") drops.no_date++;
        else if (r._drop_reason === "title_irrelevant") drops.title_irrelevant++;
        else drops.invalid++;
        continue;
      }
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
          article_title: r._article_title,
          article_published_date: r._published_date,
          days_since_published: r._days_since_published,
        }),
      });
    }

    const dropSummary = Object.entries(drops).filter(([, v]) => v > 0).map(([k, v]) => `${v}${k}`).join(" ");
    console.log(
      `Canonicalize: ${kept.length} kept → ${signals.length} signals (${dropSummary || "no drops"})`,
    );
    $.export("$summary", `${signals.length} signals (${kept.length}→ ${dropSummary || "no drops"})`);

    return {
      signals_json: JSON.stringify(signals),
      signal_count: signals.length,
      drops,
      // Legacy keys for backward compatibility with respond step
      dropped_404: drops.http_4xx,
      dropped_dupe: drops.dupe,
      dropped_invalid: drops.invalid + drops.stale + drops.no_date + drops.title_irrelevant,
    };
  },
});
