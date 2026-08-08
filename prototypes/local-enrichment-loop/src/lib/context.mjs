// PROTOTYPE (CRMA-438) — the prompt-building half of the step entrypoint in
// enrichment-p_xMC995w/run_enrichment_agent/entry.js, extracted into pure
// functions. THIS is the unit-testability demonstration: in prod these live
// inline in the step's run() and can only be exercised by a deploy + live fire.

import { loadPrompts, render, mustGet, parseVariant } from "./prompt_loader.mjs";

export const SYSTEM_PROMPT_KEY = "enrichment.agent.system";
export const NAMING_GUIDANCE_KEY = "enrichment.agent.naming_guidance";
export const USER_PROMPT_KEY = "enrichment.agent.user";

export function normalizeSourceMetricsPool(source_metrics_rows) {
  return (source_metrics_rows || []).map((r) => ({
    source_name: r.SOURCE_NAME,
    headline_metric: r.HEADLINE_METRIC,
    headline_metric_name: r.HEADLINE_METRIC_NAME,
    metrics: parseVariant(r.METRICS),
  }));
}

export function normalizeNeighborPool(neighbor_rows) {
  return (neighbor_rows || []).map((r) => ({
    trend_id: r.TREND_ID,
    trend_topic: r.TREND_TOPIC,
    total_cluster_size: r.TOTAL_CLUSTER_SIZE,
    distinct_source_count: r.DISTINCT_SOURCE_COUNT,
    velocity_direction: r.VELOCITY_DIRECTION,
    trend_heat_index: r.TREND_HEAT_INDEX,
    last_update_at: r.LAST_UPDATE_AT,
    category: r.CATEGORY,
    subcategory: r.SUBCATEGORY,
    trend_name: r.TREND_NAME || r.TREND_NAME_B2C, // q_neighbors already COALESCEs; fallback for legacy rows
    summary_short: r.SUMMARY_SHORT,
  }));
}

export function buildTrendMetadataJson(metricsRow, trend_id) {
  return JSON.stringify({
    trend_id: metricsRow.TREND_ID,
    trend_topic: metricsRow.TREND_TOPIC,
    cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
    distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
    heat_index: metricsRow.TREND_HEAT_INDEX,
    velocity: metricsRow.VELOCITY_DIRECTION,
    detected_at: metricsRow.DETECTED_AT,
    last_update_at: metricsRow.LAST_UPDATE_AT,
  });
}

export function formatTopSignals(signal_rows) {
  return (signal_rows || []).map((s, i) => {
    const head = `${i + 1}. [${s.DOMAIN || "?"}] ${s.TITLE || s.SIGNAL_NAME || "(no title)"} — ${s.URL || "(no url)"}`;
    const body = (s.ARTICLE_BODY || "").trim();
    // Body content is reachable for the subset of prefetched signals where
    // SIGNAL_ID == URL (mostly wikimedia + google_trends_explore + recent
    // bluesky/grok). When present, include a short snippet so the agent
    // has actual context to cite from rather than just title + URL.
    if (body) {
      const snippet = body.replace(/\s+/g, " ").slice(0, 400);
      return `${head}\n     body: "${snippet}${body.length > 400 ? "…" : ""}"`;
    }
    return head;
  }).join("\n") || "(no signals)";
}

export function formatSourceBreakdown(source_metrics_pool) {
  return source_metrics_pool.map((s) =>
    `  • ${s.source_name}: ${s.headline_metric_name || "metric"}=${s.headline_metric ?? "?"}`
  ).join("\n") || "(no source coverage)";
}

export function formatRelatedSignals(signal_rows) {
  return (signal_rows || []).slice(0, 5).map((s, i) => {
    const md = parseVariant(s.SIGNAL_METADATA) || {};
    const why = md.why_now || md.WHY_NOW || "";
    const pub = md.article_published_date || md.ARTICLE_PUBLISHED_DATE || "";
    return `${i + 1}. ${s.TITLE || ""}${pub ? ` (${pub})` : ""}${why ? ` — why_now: ${why}` : ""}`;
  }).join("\n") || "(no metadata)";
}

export function formatNeighbors(trend_neighbor_pool) {
  return trend_neighbor_pool.slice(0, 10).map((n, i) =>
    `${i + 1}. "${n.trend_name || n.trend_topic}" — ${n.category || "?"}/${n.subcategory || "?"} (heat ${n.trend_heat_index ?? "?"})`
  ).join("\n") || "(no neighbors in window)";
}

export function buildTrendSummaryBlock(metricsRow, trend_id) {
  return `TREND_TOPIC: ${metricsRow.TREND_TOPIC}
TREND_ID: ${trend_id}
HEAT_INDEX: ${metricsRow.TREND_HEAT_INDEX} | CLUSTER_SIZE: ${metricsRow.TOTAL_CLUSTER_SIZE} | VELOCITY: ${metricsRow.VELOCITY_DIRECTION}
DETECTED_AT (originally surfaced): ${metricsRow.DETECTED_AT}`;
}

// Renders the full system + user prompts from DIM_LLM_PROMPT rows and the
// prefetched context. Per ADR-0001 the system prompt drops the
// {{valuable_examples}} interpolation — declarative rules only.
export function buildPrompts({ prompts_rows, metricsRow, trend_id, signal_rows, source_metrics_pool, trend_neighbor_pool, now = new Date() }) {
  const loaded = loadPrompts(prompts_rows);
  const systemPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
  const namingGuidance = mustGet(loaded, NAMING_GUIDANCE_KEY);
  const userPrompt = mustGet(loaded, USER_PROMPT_KEY);

  const renderedSystem = render(systemPrompt.template, {
    trend_summary_block: buildTrendSummaryBlock(metricsRow, trend_id),
  }) + "\n\n" + render(namingGuidance.template, {});

  const renderedUser = render(userPrompt.template, {
    trend_metadata_json: buildTrendMetadataJson(metricsRow, trend_id),
    top_signals_formatted: formatTopSignals(signal_rows),
    source_breakdown_formatted: formatSourceBreakdown(source_metrics_pool),
    related_signals_formatted: formatRelatedSignals(signal_rows),
    neighbors_formatted: formatNeighbors(trend_neighbor_pool),
    current_date: now.toISOString().slice(0, 10),
  });

  return { renderedSystem, renderedUser, systemPrompt, namingGuidance, userPrompt };
}
