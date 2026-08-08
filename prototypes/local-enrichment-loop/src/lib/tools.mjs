// PROTOTYPE (CRMA-438) — in-process + HTTP tool implementations, ported
// verbatim from enrichment-p_xMC995w/run_enrichment_agent/entry.js.

import { ALL_SCHEMAS, DEFERRED_BY_NEED } from "./tool_catalog.mjs";

function tokenize(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function lookupTrendNeighbors(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const { topic, k = 5, min_similarity = 0 } = input || {};
  const cap = Math.min(Number(k) || 5, 15);
  if (!topic) return { error: "topic is required" };
  const queryTokens = tokenize(topic);
  const scored = pool.map((t) => ({
    trend_id: t.trend_id,
    trend_topic: t.trend_topic,
    total_cluster_size: t.total_cluster_size,
    velocity_direction: t.velocity_direction,
    trend_heat_index: t.trend_heat_index,
    last_update_at: t.last_update_at,
    category: t.category,
    subcategory: t.subcategory,
    trend_name: t.trend_name,
    summary_short: t.summary_short,
    similarity_score: jaccard(queryTokens, tokenize(t.trend_topic)),
  }));
  scored.sort((a, b) => b.similarity_score - a.similarity_score);
  return { neighbors: scored.filter((s) => s.similarity_score >= min_similarity).slice(0, cap) };
}

function lookupTrendMetrics(input, ctx) {
  const pool = ctx.trend_neighbor_pool || [];
  const want = new Set(input.trend_ids || []);
  return { metrics: pool.filter((t) => want.has(t.trend_id)) };
}

function lookupTrendSourceMetrics(input, ctx) {
  const pool = ctx.source_metrics_pool || [];
  const { source, min_headline_metric } = input || {};
  const out = [];
  for (const r of pool) {
    if (source && r.source_name !== source) continue;
    if (typeof min_headline_metric === "number" && Number(r.headline_metric || 0) < min_headline_metric) continue;
    out.push({
      source_name: r.source_name,
      headline_metric: r.headline_metric,
      headline_metric_name: r.headline_metric_name,
      metrics: r.metrics,
    });
  }
  return { source_metrics: out, total_in_pool: pool.length };
}

async function validateUrlCanonical(input) {
  const urls = (input.urls || []).slice(0, 10);
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        clearTimeout(timer);
        return {
          input_url: u,
          canonical_url: resp.url,
          status: resp.status,
          content_type: resp.headers.get("content-type") || null,
        };
      } catch (e) {
        return { input_url: u, error: e.message };
      }
    }),
  );
  return { results };
}

function discoverExternalTools(input) {
  const need = (input.need || "all").toLowerCase();
  const wanted = DEFERRED_BY_NEED[need] || DEFERRED_BY_NEED.all;
  return {
    tools: wanted.map((n) => ALL_SCHEMAS[n]),
    note: `Loaded ${wanted.length} tool(s) for need='${need}'. Call them by name.`,
  };
}

async function postJson(url, body, { timeoutMs = 90_000 } = {}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return { error: `tool endpoint not configured (got '${url}')` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}: ${text.slice(0, 400)}` };
    }
    return parsed ?? { _raw: text };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function ingestBluesky(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_bluesky, {
    query: input.query,
    limit: input.limit ?? 25,
    sort: input.sort ?? "latest",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}
async function ingestGdelt(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_gdelt, {
    topic: input.topic,
    window_days: input.window_days ?? 7,
    mode: input.mode ?? "ArtList",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 60_000 });
}
async function ingestGoogleTrends(input, ctx) {
  return postJson(ctx.endpoints?.ingest_search_google_trends, {
    keyword: input.keyword,
    geo: input.geo ?? "US",
    timeframe: input.timeframe ?? "now 7-d",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 90_000 });
}
async function ingestGrokLive(input, ctx) {
  return postJson(ctx.endpoints?.ingest_grok_live_search, {
    query: input.query,
    mode: input.mode ?? "both",
    agent_session_id: ctx.agent_session_id,
  }, { timeoutMs: 30_000 });
}

function proposeEnrichment(input, ctx) {
  const seenUrls = new Set();
  const deduped = (input.evidence || []).filter(item => {
    if (!item.url || seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });
  ctx.proposed_enrichment = { ...input, evidence: deduped, emitted_at: new Date().toISOString() };
  return {
    accepted: true,
    note: `Enrichment record captured. evidence: ${input.evidence?.length ?? 0} → ${deduped.length} items after dedup.`,
  };
}

const DISPATCHERS = {
  query_trend_neighbors: (input, ctx) => lookupTrendNeighbors(input, ctx),
  query_trend_metrics: (input, ctx) => lookupTrendMetrics(input, ctx),
  query_trend_source_metrics: (input, ctx) => lookupTrendSourceMetrics(input, ctx),
  validate_url_canonical: (input) => validateUrlCanonical(input),
  discover_external_tools: (input) => discoverExternalTools(input),
  ingest_search_bluesky: (input, ctx) => ingestBluesky(input, ctx),
  ingest_search_gdelt: (input, ctx) => ingestGdelt(input, ctx),
  ingest_search_google_trends: (input, ctx) => ingestGoogleTrends(input, ctx),
  ingest_grok_live_search: (input, ctx) => ingestGrokLive(input, ctx),
  propose_enrichment: (input, ctx) => proposeEnrichment(input, ctx),
};

export async function dispatchTool(name, input, ctx) {
  const fn = DISPATCHERS[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try {
    return await fn(input || {}, ctx || {});
  } catch (e) {
    return { error: `tool '${name}' threw: ${e.message}` };
  }
}
