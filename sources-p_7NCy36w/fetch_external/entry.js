// Sources Enrichment — fetch_external
//
// Runs GDELT and Wikimedia fetches in parallel via Promise.all.
// Returns a single object with the two source payloads; the downstream
// aggregate step uses them to build FCT_TREND_SOURCE_METRICS records.
//
// Port of:
//   - trends-sql/pipedream/enrichment/enrich_gdelt.mjs
//   - trends-sql/pipedream/enrichment/enrich_wikimedia.mjs
//
// Both functions are self-contained; no Snowflake access. Neither call
// throws to caller — any failure is logged and that source's payload
// degrades to its zero state so the workflow continues.

const USER_AGENT = "TrendsPipeline/1.0 (Pipedream; trend detection research)";
const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────────────
// GDELT helpers
// ──────────────────────────────────────────────────────────────────────

async function gdeltFetch(query, mode, { maxRecords = 250 } = {}) {
  const params = new URLSearchParams({
    query: `${query} sourcelang:english`,
    mode,
    format: "json",
    maxrecords: String(maxRecords),
    timespan: "7d",
  });
  const resp = await fetch(`${GDELT_DOC_URL}?${params}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    throw new Error(`GDELT rate limit: ${text.slice(0, 100)}`);
  }
  return JSON.parse(text);
}

// Build a GDELT-compatible OR query from the trend topic + search terms.
// GDELT rejects queries longer than ~250 chars with the error:
//   "Your query was too short or too long."
// Empirically:
//   - 2 quoted terms / 59 chars works
//   - 8 quoted terms / 235 chars fails
// We pick the most informative terms (specific multi-word phrases first,
// no single words, no substrings of already-picked terms) and stop when
// the resulting query string exceeds the 200-char budget.
function buildGdeltQuery(trendTopic, searchTerms) {
  const QUERY_BUDGET = 200;
  const quote = (t) => (t.includes(" ") ? `"${t}"` : t);

  // Normalize candidates: strip leading #, dedup case-insensitively,
  // drop single-word terms (too generic for OR queries), and require ≥5 chars.
  const seen = new Set();
  const candidates = [trendTopic, ...(searchTerms || []).map((t) => String(t).replace(/^#/, ""))]
    .map((t) => t.trim())
    .filter((t) => {
      if (t.length < 5) return false;
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      // Always allow the trend topic; drop other single-word terms.
      if (t === trendTopic) return true;
      return t.split(/\s+/).length >= 2;
    });

  // Pick longest-first, but always start with trend_topic. Filter out any
  // term that's a case-insensitive substring of a term already picked
  // (substring redundancy doesn't help GDELT but does eat the budget).
  const ordered = [
    trendTopic,
    ...candidates.filter((t) => t !== trendTopic).sort((a, b) => b.length - a.length),
  ];

  const picked = [];
  for (const t of ordered) {
    const lower = t.toLowerCase();
    if (picked.some((p) => p.toLowerCase().includes(lower))) continue;
    const next = [...picked, t].map(quote).join(" OR ");
    const wrapped = picked.length === 0 ? next : `(${next})`;
    if (wrapped.length > QUERY_BUDGET) break;
    picked.push(t);
  }

  if (picked.length === 0) return `"${trendTopic}"`;
  if (picked.length === 1) return quote(picked[0]);
  return `(${picked.map(quote).join(" OR ")})`;
}

async function fetchGdelt(trendTopic, searchTerms) {
  const result = {
    gdelt_article_count_7d: 0,
    gdelt_domain_count_7d: 0,
    gdelt_top_domains: [],
    gdelt_tone_avg: null,
  };

  const gdeltQuery = buildGdeltQuery(trendTopic, searchTerms);
  console.log(`GDELT query (${gdeltQuery.length} chars): ${gdeltQuery}`);

  try {
    const data = await gdeltFetch(gdeltQuery, "ArtList");
    const articles = data?.articles || [];
    result.gdelt_article_count_7d = articles.length;

    const domainMap = {};
    for (const a of articles) {
      const d = a.domain || "unknown";
      if (!domainMap[d]) domainMap[d] = { domain: d, count: 0, sample_title: a.title || "" };
      domainMap[d].count++;
    }
    const domains = Object.values(domainMap).sort((a, b) => b.count - a.count);
    result.gdelt_domain_count_7d = domains.length;
    result.gdelt_top_domains = domains.slice(0, 20);
    console.log(`GDELT: ${articles.length} articles across ${domains.length} domains`);
  } catch (e) {
    console.log(`GDELT ArtList error: ${e.message}`);
  }

  // Courtesy backoff between GDELT modes — their public API throttles aggressively.
  await sleep(6000);

  try {
    const toneData = await gdeltFetch(gdeltQuery, "ToneChart");
    const tones = toneData?.tonechart || [];
    if (tones.length > 0) {
      const avg = tones.reduce((s, t) => s + (t.tone || 0), 0) / tones.length;
      result.gdelt_tone_avg = Math.round(avg * 100) / 100;
      console.log(`GDELT tone: ${result.gdelt_tone_avg} (${tones.length} data points)`);
    }
  } catch (e) {
    console.log(`GDELT ToneChart error: ${e.message}`);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Wikimedia helpers
// ──────────────────────────────────────────────────────────────────────

function formatDate(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function wikiSearch(query) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "5",
    format: "json",
  });
  const resp = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!resp.ok) throw new Error(`Wikipedia search HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.query?.search || [];
}

async function wikiPageviews(articleTitle, days = 30) {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - days * 86400000);
  const encoded = encodeURIComponent(articleTitle);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encoded}/daily/${formatDate(start)}/${formatDate(end)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Pageviews HTTP ${resp.status}`);
  return resp.json();
}

async function wikiSummary(articleTitle) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(articleTitle)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchWikimedia(trendTopic, searchTerms) {
  const result = {
    wiki_article_title: null,
    wiki_pageviews_7d: null,
    wiki_pageviews_30d: null,
    wiki_pageview_growth_pct: null,
    wiki_daily_views: [],
    wiki_extract: null,
  };

  // Require ≥2 words per query (or the full topic). Single-word queries
  // match too broadly ("Seasonal" → "Seasonal food"). Dedup case-insensitive.
  const seen = new Set();
  const searchQueries = [trendTopic, ...searchTerms.map((t) => t.replace(/^#/, ""))]
    .filter((t) => t === trendTopic || t.trim().split(/\s+/).length >= 2)
    .filter((t) => {
      const k = t.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  let articleTitle;
  for (const term of searchQueries) {
    try {
      const hits = await wikiSearch(term);
      // Require at least one ≥5-char word from the query to appear in
      // the candidate article title — avoids matching unrelated articles.
      const queryWords = term.toLowerCase().split(/\s+/).filter((w) => w.length >= 5);
      for (const hit of hits) {
        const titleLower = hit.title.toLowerCase();
        const hasOverlap = queryWords.some((w) => new RegExp(`\\b${w}\\b`).test(titleLower));
        if (hasOverlap) {
          articleTitle = hit.title;
          result.wiki_article_title = articleTitle;
          console.log(`Wikimedia: matched "${term}" → "${articleTitle}"`);
          break;
        }
      }
      if (articleTitle) break;
      console.log(`Wikimedia: no relevant article for "${term}" (${hits.length} results)`);
    } catch (e) {
      console.log(`Wikimedia search error for "${term}": ${e.message}`);
    }
  }

  if (!articleTitle) {
    console.log("Wikimedia: no article match");
    return result;
  }

  await sleep(500);

  try {
    const summary = await wikiSummary(articleTitle);
    if (summary) result.wiki_extract = (summary.extract || "").slice(0, 1000);
  } catch (e) {
    console.log(`Wikimedia summary error: ${e.message}`);
  }

  await sleep(500);

  try {
    const pv = await wikiPageviews(articleTitle, 30);
    const items = pv?.items || [];
    const daily = items.map((i) => ({
      date: i.timestamp?.slice(0, 8) || "",
      views: i.views || 0,
    }));
    result.wiki_daily_views = daily;
    result.wiki_pageviews_30d = daily.reduce((s, d) => s + d.views, 0);

    const last7 = daily.slice(-7).reduce((s, d) => s + d.views, 0);
    const prev7 = daily.slice(-14, -7).reduce((s, d) => s + d.views, 0);
    result.wiki_pageviews_7d = last7;
    if (prev7 > 0) {
      result.wiki_pageview_growth_pct = Math.round(((last7 - prev7) / prev7) * 1000) / 10;
    }
    console.log(`Wikimedia: ${result.wiki_pageviews_30d} views (30d), ${last7} (7d), growth ${result.wiki_pageview_growth_pct ?? "N/A"}%`);
  } catch (e) {
    console.log(`Wikimedia pageviews error: ${e.message}`);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Step entry
// ──────────────────────────────────────────────────────────────────────

export default defineComponent({
  props: {
    metrics_rows: {
      type: "any",
      label: "FCT_TREND_METRICS rows (from query_metrics)",
    },
    search_term_output: {
      type: "any",
      label: "Output from generate_search_terms",
    },
  },
  async run({ $ }) {
    const metrics = (this.metrics_rows || [])[0];
    if (!metrics) throw new Error("query_metrics returned no row");
    const trendTopic = metrics.TREND_TOPIC;

    const searchTerms = this.search_term_output?.terms || [];
    if (searchTerms.length === 0) {
      console.log("No search terms available — using trend topic only");
    }

    // Run GDELT + Wikimedia in parallel. Each catches its own errors and
    // returns a zero-state object on failure, so Promise.all never rejects.
    const [gdelt, wikimedia] = await Promise.all([
      fetchGdelt(trendTopic, searchTerms),
      fetchWikimedia(trendTopic, searchTerms),
    ]);

    $.export("$summary", `GDELT ${gdelt.gdelt_article_count_7d} / Wiki ${wikimedia.wiki_pageviews_7d ?? 0}`);

    return { gdelt, wikimedia };
  },
});
