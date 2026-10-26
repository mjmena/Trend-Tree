// lifecycle_context.mjs — the lifecycle agent's prefetched context, for a whole
// due set at once (CRMA-1677, spec docs/prd/lifecycle-job.md "The set-based
// queries").
//
// Two halves:
//   1. SET_QUERIES: today's 7 per-trend context queries from
//      lifecycle-subagent-p_gYC562o/workflow.yaml, each rewritten as ONE
//      statement over a `due` CTE built from a bound JSON array of trend ids
//      (bind :1). A per-trend filter became a join to `due`; a per-trend
//      `ORDER BY … LIMIT n` became `QUALIFY ROW_NUMBER() OVER (PARTITION BY
//      TREND_ID …) <= n`. Each statement ends ORDER BY <trend key>, <today's
//      order>, so groupByTrend() hands every trend its rows in today's order.
//   2. computeHeatBase and the system-prompt context-block builders, copied
//      UNCHANGED from lifecycle-subagent-p_gYC562o/run_subagent/entry.js. They
//      are pure functions of one trend's rows. The only edit is that `now` is
//      a parameter (default Date.now()) instead of read inline, so the parity
//      test can render both sides at one instant.
//
// The Pipedream subagent keeps its own inlined copy until the cut-over
// (CRMA-1675); keep the two in sync until then.
//
// Parity proof (per-trend vs set-based, char for char):
//   cd services/lifecycle && npm ci && node parity.mjs

// ─────────────────────────────────────────────────────────────────────
// Set-based context queries
// ─────────────────────────────────────────────────────────────────────

const DUE_CTE = `due AS (SELECT VALUE::STRING AS TREND_ID FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:1))))`;

// The publisher-domain CASE, verbatim from q_signal_domains (mirrors
// sql/dt_trend_dashboard.sql's signal_domains CTE — keep them in sync).
const SIGNAL_DOMAINS_CTE = `signal_domains AS (
  SELECT
    s.SIGNAL_ID,
    s.SIGNAL_TIMESTAMP,
    CASE
      WHEN s.SOURCE_NAME = 'wikimedia'             THEN 'wikipedia.org'
      WHEN s.SOURCE_NAME = 'amazon_trends'         THEN 'amazon.com'
      WHEN s.SOURCE_NAME = 'tiktok'                THEN 'tiktok.com'
      WHEN s.SOURCE_NAME = 'pinterest'             THEN 'pinterest.com'
      WHEN s.SOURCE_NAME = 'bluesky'               THEN 'bsky.app'
      WHEN s.SOURCE_NAME = 'google_trends_explore' THEN 'trends.google.com'
      WHEN s.SOURCE_NAME = 'grok_live'             THEN 'x.com'
      WHEN s.SOURCE_NAME = 'gdelt'
        THEN LOWER(REGEXP_REPLACE(s.METADATA:domain::STRING, '^www[.]', ''))
      WHEN STARTSWITH(s.SOURCE_NAME, 'gemini_')
        THEN LOWER(s.METADATA:source_name::STRING)
      WHEN STARTSWITH(s.SOURCE_NAME, 'agent_') AND ENDSWITH(s.SOURCE_NAME, '_discovery') THEN
        CASE
          WHEN s.METADATA:canonical_url::STRING LIKE '%vertexaisearch.cloud.google.com%'
            THEN NULL
          ELSE LOWER(REGEXP_REPLACE(
            REGEXP_SUBSTR(s.METADATA:canonical_url::STRING, 'https?://([^/]+)', 1, 1, 'e', 1),
            '^www[.]', ''))
        END
      ELSE NULL
    END AS DOMAIN
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
)`;

// The latest TREND_VECTOR per due trend (q_candidate_signals' trend_vec and
// q_neighbors' target_vec).
const DUE_VEC_CTE = `due_vec AS (
  SELECT l.TREND_ID, l.TREND_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
  JOIN due d ON d.TREND_ID = l.TREND_ID
  WHERE l.TREND_VECTOR IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY l.WRITTEN_AT DESC) = 1
)`;

export const SET_QUERIES = {
  // One row per due trend. The scalar COUNT subqueries returned 0 for a trend
  // with no rows, so their GROUP BY forms are COALESCEd back to 0.
  metrics: `WITH ${DUE_CTE},
lc AS (
  SELECT l.TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS, NEW_HEAT AS HEAT_INDEX,
         NEW_HEAT_SMOOTHED AS HEAT_INDEX_SMOOTHED,
         EVALUATED_AT AS LAST_EVAL_AT, NEXT_EVAL_AT,
         DECISION_PAYLOAD:retirement_reason::STRING AS RETIREMENT_REASON
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
  JOIN due d ON d.TREND_ID = l.TREND_ID
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY EVALUATED_AT DESC) = 1
),
e AS (
  SELECT l.TREND_ID, WRITTEN_AT AS ENRICHED_AT,
         PAYLOAD:summary_short::STRING AS SUMMARY_SHORT,
         PAYLOAD:summary_long::STRING  AS SUMMARY_LONG,
         PAYLOAD:vibe_shift::STRING    AS VIBE_SHIFT
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
  JOIN due d ON d.TREND_ID = l.TREND_ID
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY WRITTEN_AT DESC) = 1
),
ev AS (
  SELECT l.TREND_ID, COUNT(*) AS ENRICHMENT_VERSION
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
  JOIN due d ON d.TREND_ID = l.TREND_ID
  WHERE ENRICHMENT_KIND IN ('initial', 'refinement')
  GROUP BY l.TREND_ID
),
cs AS (
  SELECT ts.TREND_ID, COUNT(DISTINCT ts.SIGNAL_ID) AS TOTAL_CLUSTER_SIZE
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
  JOIN due d ON d.TREND_ID = ts.TREND_ID
  GROUP BY ts.TREND_ID
),
src AS (
  SELECT d.TREND_ID, COUNT(DISTINCT k.value::STRING) AS DISTINCT_SOURCE_COUNT
  FROM due d
  JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS dt ON dt.TREND_ID = d.TREND_ID
  JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
    ON c.CANDIDATE_ID = dt.CANDIDATE_ID OR c.DEDUP_OF_TREND_ID = d.TREND_ID,
  LATERAL FLATTEN(INPUT => OBJECT_KEYS(c.SOURCE_BREAKDOWN)) k
  GROUP BY d.TREND_ID
)
SELECT
  t.TREND_ID, t.TREND_TOPIC, t.GTRENDS_KEYWORD,
  t.PROMOTED_AT, t.LAST_UPDATE_AT,
  t.TREND_NAME_B2B, t.TREND_NAME_B2C, t.CATEGORY, t.SUBCATEGORY,
  c.CONFIDENCE, c.SPECIFICITY_SCORE,
  COALESCE(cs.TOTAL_CLUSTER_SIZE, 0) AS TOTAL_CLUSTER_SIZE,
  COALESCE(src.DISTINCT_SOURCE_COUNT, 0) AS DISTINCT_SOURCE_COUNT,
  lc.LIFECYCLE_STATUS, lc.HEAT_INDEX AS TREND_HEAT_INDEX,
  lc.HEAT_INDEX_SMOOTHED AS TREND_HEAT_INDEX_SMOOTHED,
  lc.LAST_EVAL_AT AS LAST_LIFECYCLE_EVAL_AT,
  lc.NEXT_EVAL_AT AS NEXT_LIFECYCLE_EVAL_AT,
  lc.RETIREMENT_REASON,
  e.SUMMARY_SHORT, e.SUMMARY_LONG, e.VIBE_SHIFT,
  e.ENRICHED_AT, COALESCE(ev.ENRICHMENT_VERSION, 0) AS ENRICHMENT_VERSION
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN due d ON d.TREND_ID = t.TREND_ID
LEFT JOIN lc  ON lc.TREND_ID  = t.TREND_ID
LEFT JOIN e   ON e.TREND_ID   = t.TREND_ID
LEFT JOIN ev  ON ev.TREND_ID  = t.TREND_ID
LEFT JOIN cs  ON cs.TREND_ID  = t.TREND_ID
LEFT JOIN src ON src.TREND_ID = t.TREND_ID
LEFT JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = t.CANDIDATE_ID
ORDER BY t.TREND_ID`,

  signal_domains: `WITH ${DUE_CTE},
${SIGNAL_DOMAINS_CTE}
SELECT ts.TREND_ID, sd.DOMAIN, COUNT(*) AS SIGNAL_COUNT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
JOIN due d ON d.TREND_ID = ts.TREND_ID
JOIN signal_domains sd ON sd.SIGNAL_ID = ts.SIGNAL_ID
WHERE sd.DOMAIN IS NOT NULL
  AND sd.SIGNAL_TIMESTAMP > DATEADD(day, -21, CURRENT_TIMESTAMP())
GROUP BY ts.TREND_ID, sd.DOMAIN
ORDER BY ts.TREND_ID`,

  lifecycle_history: `WITH ${DUE_CTE}
SELECT l.TREND_ID, EVALUATED_AT, PRIOR_STATUS, NEW_STATUS, PRIOR_HEAT, NEW_HEAT,
       HEAT_BASE, HEAT_MODIFIER_PCT, REASONING, RETIREMENT_PROPOSAL, REQUESTED_RE_ENRICHMENT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER l
JOIN due d ON d.TREND_ID = l.TREND_ID
QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY EVALUATED_AT DESC) <= 5
ORDER BY l.TREND_ID, EVALUATED_AT DESC`,

  recent_signals: `WITH ${DUE_CTE}
SELECT ts.TREND_ID, s.SIGNAL_ID, s.SOURCE_NAME, s.SIGNAL_TIMESTAMP,
       s.SIGNAL_TITLE, LEFT(s.SIGNAL_TEXT, 400) AS SIGNAL_TEXT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS ts
JOIN due d ON d.TREND_ID = ts.TREND_ID
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
  ON s.SIGNAL_ID = ts.SIGNAL_ID
WHERE s.SIGNAL_TIMESTAMP > DATEADD(day, -14, CURRENT_TIMESTAMP())
QUALIFY ROW_NUMBER() OVER (PARTITION BY ts.TREND_ID ORDER BY s.SIGNAL_TIMESTAMP DESC NULLS LAST) <= 30
ORDER BY ts.TREND_ID, s.SIGNAL_TIMESTAMP DESC NULLS LAST`,

  // Due trend vectors x the 7-day signal pool, with today's per-trend
  // NOT EXISTS evaluated per (trend, signal) pair.
  candidate_signals: `WITH ${DUE_CTE},
${DUE_VEC_CTE},
new_signals AS (
  SELECT s.SIGNAL_ID, s.SOURCE_NAME, s.SIGNAL_TIMESTAMP,
         s.SIGNAL_TITLE, LEFT(s.SIGNAL_TEXT, 300) AS SIGNAL_TEXT, s.SIGNAL_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
  WHERE s.EMBEDDED_AT >= DATEADD(day, -7, CURRENT_TIMESTAMP())
    AND s.SIGNAL_VECTOR IS NOT NULL
),
scored AS (
  SELECT tv.TREND_ID, ns.SIGNAL_ID, ns.SOURCE_NAME, ns.SIGNAL_TIMESTAMP,
         ns.SIGNAL_TITLE, ns.SIGNAL_TEXT,
         VECTOR_COSINE_SIMILARITY(tv.TREND_VECTOR, ns.SIGNAL_VECTOR) AS SIMILARITY
  FROM due_vec tv
  CROSS JOIN new_signals ns
  WHERE NOT EXISTS (
    SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
    WHERE x.SIGNAL_ID = ns.SIGNAL_ID
      AND x.TREND_ID = tv.TREND_ID
  )
)
SELECT TREND_ID, SIGNAL_ID, SOURCE_NAME, SIGNAL_TIMESTAMP, SIGNAL_TITLE, SIGNAL_TEXT, SIMILARITY
FROM scored
WHERE SIMILARITY >= 0.45
QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY SIMILARITY DESC) <= 20
ORDER BY TREND_ID, SIMILARITY DESC`,

  // TREND_ID here is the NEIGHBOR (as today); DUE_TREND_ID is the due trend
  // the row belongs to — group on it.
  neighbors: `WITH ${DUE_CTE},
${DUE_VEC_CTE},
latest_enrichment AS (
  SELECT TREND_ID, TREND_VECTOR,
         PAYLOAD:trend_name_b2c::STRING AS E_TREND_NAME_B2C,
         PAYLOAD:category::STRING       AS E_CATEGORY,
         PAYLOAD:subcategory::STRING    AS E_SUBCATEGORY,
         PAYLOAD:summary_short::STRING  AS SUMMARY_SHORT
  FROM (
    SELECT TREND_ID, TREND_VECTOR, PAYLOAD,
           ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  ) WHERE rn = 1
),
latest_vector AS (
  SELECT TREND_ID, TREND_VECTOR
  FROM (
    SELECT TREND_ID, TREND_VECTOR,
           ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    WHERE TREND_VECTOR IS NOT NULL
  ) WHERE rn = 1
),
latest_lifecycle AS (
  SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS,
         NEW_HEAT AS HEAT_INDEX, NEW_HEAT_SMOOTHED AS HEAT_INDEX_SMOOTHED
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  ) WHERE rn = 1
)
SELECT tv.TREND_ID AS DUE_TREND_ID,
       t.TREND_ID, t.TREND_TOPIC, lc.LIFECYCLE_STATUS,
       COALESCE(lc.HEAT_INDEX_SMOOTHED, lc.HEAT_INDEX) AS HEAT,
       t.LAST_UPDATE_AT,
       COALESCE(t.TREND_NAME_B2C, e.E_TREND_NAME_B2C) AS TREND_NAME_B2C,
       COALESCE(t.CATEGORY,       e.E_CATEGORY)       AS CATEGORY,
       COALESCE(t.SUBCATEGORY,    e.E_SUBCATEGORY)    AS SUBCATEGORY,
       e.SUMMARY_SHORT,
       VECTOR_COSINE_SIMILARITY(lv.TREND_VECTOR, tv.TREND_VECTOR) AS SIMILARITY
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
CROSS JOIN due_vec tv
LEFT JOIN latest_enrichment e ON e.TREND_ID = t.TREND_ID
LEFT JOIN latest_vector     lv ON lv.TREND_ID = t.TREND_ID
LEFT JOIN latest_lifecycle  lc ON lc.TREND_ID = t.TREND_ID
WHERE t.TREND_ID != tv.TREND_ID
  AND lv.TREND_VECTOR IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY tv.TREND_ID ORDER BY SIMILARITY DESC NULLS LAST) <= 30
ORDER BY DUE_TREND_ID, SIMILARITY DESC NULLS LAST`,
};

// q_prompts, unchanged; run once per tick.
export const PROMPTS_SQL = `SELECT PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE IS_ACTIVE = TRUE
  AND PROMPT_KEY IN ('lifecycle.subagent.system', 'lifecycle.subagent.decision_rubric')`;

// Rows of one set-based query -> Map(trend_id -> rows), keeping row order.
export function groupByTrend(rows, key = "TREND_ID") {
  const out = new Map();
  for (const r of rows || []) {
    const id = r[key];
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Moved from lifecycle-subagent-p_gYC562o/run_subagent/entry.js
// ─────────────────────────────────────────────────────────────────────

export function loadPrompts(rows) {
  const out = {};
  for (const r of rows || []) {
    let params = {};
    try { params = typeof r.MODEL_PARAMS === "string" ? JSON.parse(r.MODEL_PARAMS) : (r.MODEL_PARAMS || {}); } catch { params = {}; }
    out[r.PROMPT_KEY] = { template: r.TEMPLATE, version: r.VERSION, model: r.MODEL, params };
  }
  return out;
}

export function render(template, vars) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function mustGet(loaded, key) {
  const p = loaded[key];
  if (!p) throw new Error(`prompt ${key} not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)`);
  return p;
}

function shannonEntropyNormalized(counts) {
  const vals = Object.values(counts).filter((v) => v > 0);
  if (vals.length <= 1) return 0;
  const total = vals.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const v of vals) {
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(vals.length);
}

// Heat formula v2 (ADR-0005): a pure measure of LINKED evidence — signals
// attached to the trend in FCT_TREND_SIGNALS. Candidate (vector-similar but
// unlinked) signals earn zero heat; the path for a candidate to start
// counting is attribution, not similarity. Google Trends is not a heat
// input — demand-side evidence lives on the opportunity-score axis.
export function computeHeatBase({ metrics, signal_domain_counts, recent_signals }, now = Date.now()) {
  // recency_factor: hours since the newest LINKED signal, half-life 120h.
  // No LAST_UPDATE_AT fallback — bookkeeping timestamps are not evidence.
  // recent_signals is the 14d linked prefetch; a trend with nothing linked
  // in 14d would score ≤ exp(-2.8) ≈ 0.06 anyway, so no-rows → 0.
  const lastSignalTs = recent_signals[0]?.signal_timestamp
    ? new Date(recent_signals[0].signal_timestamp).getTime()
    : null;
  const recency_factor = lastSignalTs
    ? Math.exp(-Math.max(0, (now - lastSignalTs) / (3600 * 1000)) / 120)
    : 0;

  // velocity_factor: linear in linked signals over 7d, saturating at 3.
  // Replaces the sigmoid and its 0.34 zero-signal floor: 0 linked = 0 pts.
  const sevenD = 7 * 24 * 3600 * 1000;
  const last7dCount = recent_signals.filter((s) => {
    const ts = s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0;
    return ts > 0 && (now - ts) <= sevenD;
  }).length;
  const velocity_factor = Math.min(1, last7dCount / 3);

  // breadth_factor: log-publishers × shannon entropy across distinct linked
  // publisher domains ACTIVE IN THE LAST 21 DAYS (q_signal_domains windows
  // the counts — cumulative breadth was an age counter). Anchored so 6
  // active domains (observed windowed max) with even distribution = 1.0.
  // Publisher extraction mirrors sql/dt_trend_dashboard.sql's signal_domains
  // CTE — keep them in sync.
  const distinct = Object.values(signal_domain_counts).filter(v => v > 0).length;
  const log_score = distinct === 0
    ? 0
    : Math.min(1, Math.max(0, Math.log2(distinct) - 0.5) / (Math.log2(6) - 0.5));
  const entropy = shannonEntropyNormalized(signal_domain_counts);
  const breadth_factor = log_score * entropy;

  // confidence: from FCT_TRENDS.CONFIDENCE (0-1)
  const confidence = Number(metrics?.confidence || 0.5);

  const heat_base =
    25 * recency_factor +
    25 * velocity_factor +
    40 * breadth_factor +
    10 * confidence;

  return {
    heat_base: Math.round(heat_base * 10) / 10,
    components: {
      recency_factor: Math.round(recency_factor * 1000) / 1000,
      velocity_factor: Math.round(velocity_factor * 1000) / 1000,
      breadth_factor: Math.round(breadth_factor * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
    },
  };
}

export const SYSTEM_PROMPT_KEY = "lifecycle.subagent.system";
export const RUBRIC_PROMPT_KEY = "lifecycle.subagent.decision_rubric";

function parseVariant(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

function fmtJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// One trend's rows -> its heat_base and the system-prompt context blocks.
// The body is run_subagent's run(), from the metrics row to the blocks.
export function buildTrendContext({
  trend_id, metrics_rows, signal_domain_rows, lifecycle_history_rows,
  recent_signal_rows, candidate_signal_rows, neighbor_rows,
}, now = Date.now()) {
  const metricsRow = (metrics_rows || [])[0];
  if (!metricsRow) {
    throw new Error(`lifecycle: no FCT_TRENDS row for trend_id ${trend_id}`);
  }

  // Normalize prefetched data into context shape
  const metrics = {
    trend_id: metricsRow.TREND_ID,
    trend_topic: metricsRow.TREND_TOPIC,
    lifecycle_status: metricsRow.LIFECYCLE_STATUS,
    total_cluster_size: metricsRow.TOTAL_CLUSTER_SIZE,
    distinct_source_count: metricsRow.DISTINCT_SOURCE_COUNT,
    confidence: metricsRow.CONFIDENCE,
    specificity_score: metricsRow.SPECIFICITY_SCORE,
    trend_heat_index: metricsRow.TREND_HEAT_INDEX,
    trend_heat_index_smoothed: metricsRow.TREND_HEAT_INDEX_SMOOTHED,
    promoted_at: metricsRow.PROMOTED_AT,
    last_update_at: metricsRow.LAST_UPDATE_AT,
    last_lifecycle_eval_at: metricsRow.LAST_LIFECYCLE_EVAL_AT,
    trend_name_b2b: metricsRow.TREND_NAME_B2B,
    trend_name_b2c: metricsRow.TREND_NAME_B2C,
    category: metricsRow.CATEGORY,
    subcategory: metricsRow.SUBCATEGORY,
    summary_short: metricsRow.SUMMARY_SHORT,
    summary_long: metricsRow.SUMMARY_LONG,
    vibe_shift: metricsRow.VIBE_SHIFT,
    enriched_at: metricsRow.ENRICHED_AT,
    enrichment_version: metricsRow.ENRICHMENT_VERSION,
  };

  // Per-domain signal counts attached to this trend (from q_signal_domains).
  // Drives breadth_factor via Shannon entropy in computeHeatBase. Counts come
  // from FCT_TREND_SIGNALS (both 'supporting' and 'attributed' LINK_KINDs),
  // windowed to signals active in the last 21 days (ADR-0005), with each
  // signal mapped to a canonical publisher domain.
  const signal_domain_counts = Object.fromEntries(
    (signal_domain_rows || [])
      .filter((r) => r.DOMAIN && Number(r.SIGNAL_COUNT) > 0)
      .map((r) => [r.DOMAIN, Number(r.SIGNAL_COUNT)])
  );

  const lifecycle_history = (lifecycle_history_rows || []).map((r) => ({
    evaluated_at: r.EVALUATED_AT,
    prior_status: r.PRIOR_STATUS,
    new_status: r.NEW_STATUS,
    prior_heat: r.PRIOR_HEAT,
    new_heat: r.NEW_HEAT,
    heat_base: r.HEAT_BASE,
    heat_modifier_pct: r.HEAT_MODIFIER_PCT,
    reasoning: r.REASONING,
    retirement_proposal: parseVariant(r.RETIREMENT_PROPOSAL),
    requested_re_enrichment: r.REQUESTED_RE_ENRICHMENT,
  }));

  const recent_signals = (recent_signal_rows || []).map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
  }));

  const candidate_signals = (candidate_signal_rows || []).map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  const neighbor_pool = (neighbor_rows || []).map((r) => ({
    trend_id: r.TREND_ID,
    trend_topic: r.TREND_TOPIC,
    lifecycle_status: r.LIFECYCLE_STATUS,
    heat: r.HEAT,
    last_update_at: r.LAST_UPDATE_AT,
    trend_name_b2c: r.TREND_NAME_B2C,
    category: r.CATEGORY,
    subcategory: r.SUBCATEGORY,
    summary_short: r.SUMMARY_SHORT,
    similarity: Number(r.SIMILARITY || 0),
  }));

  // Heat v2 (ADR-0005): heat is computed from LINKED signals only.
  // Candidate signals stay in the prompt as a growth hint but earn zero
  // heat points — no merge. recent_signals arrives newest-first from SQL.
  const { heat_base, components } = computeHeatBase({
    metrics, signal_domain_counts, recent_signals,
  }, now);

  // Raw linked-evidence metrics for the agent's heat context block. The
  // status rubric keys on these (never on modified heat — anti-feedback
  // rule): linked n7 vs prior week, active publishers, days silent.
  const _now = now;
  const _7d = 7 * 24 * 3600 * 1000;
  const _24h = 24 * 3600 * 1000;
  const linkedTs = recent_signals
    .map(s => (s.signal_timestamp ? new Date(s.signal_timestamp).getTime() : 0))
    .filter(ts => ts > 0);
  const last7dCount = linkedTs.filter(ts => (_now - ts) <= _7d).length;
  const priorWeekCount = linkedTs.filter(ts => (_now - ts) > _7d).length; // 14d prefetch − last 7d
  const last24hCount = linkedTs.filter(ts => (_now - ts) <= _24h).length;
  const newestLinkedTs = linkedTs.length ? Math.max(...linkedTs) : null;
  const daysSilent = newestLinkedTs !== null
    ? ((_now - newestLinkedTs) / (24 * 3600 * 1000)).toFixed(1)
    : null;
  const activeDomains = Object.values(signal_domain_counts).filter(v => v > 0).length;
  // lifecycle_history is sorted newest-first by the SQL query.
  // Delta is raw-vs-raw (heat_base vs prior HEAT_BASE), never vs the
  // status-modified value — see anti-feedback rule.
  const priorHeatBase = lifecycle_history.length && lifecycle_history[0].heat_base != null
    ? Number(lifecycle_history[0].heat_base) : null;
  const heatDelta = priorHeatBase !== null ? (heat_base - priorHeatBase).toFixed(1) : null;
  const heatTrajectory = lifecycle_history.length
    ? lifecycle_history.slice(0, 5).map(h => `${h.evaluated_at}: ${h.new_heat}`).join(" → ")
    : null;

  // Build context blocks for the system prompt
  const trend_state_block = `TREND_ID: ${metrics.trend_id}
TREND_TOPIC: ${metrics.trend_topic}
TREND_NAME_B2B / B2C: ${metrics.trend_name_b2b || "(unenriched)"} / ${metrics.trend_name_b2c || "(unenriched)"}
CATEGORY: ${metrics.category || "?"} / ${metrics.subcategory || "?"}
CURRENT LIFECYCLE_STATUS: ${metrics.lifecycle_status}
CURRENT HEAT (smoothed): ${metrics.trend_heat_index_smoothed ?? metrics.trend_heat_index}
CURRENT HEAT (raw): ${metrics.trend_heat_index}
PROMOTED_AT: ${metrics.promoted_at}
LAST_UPDATE_AT: ${metrics.last_update_at}
LAST_LIFECYCLE_EVAL_AT: ${metrics.last_lifecycle_eval_at || "(never)"}`;

  const metrics_block = `Cluster size: ${metrics.total_cluster_size}
Distinct source count: ${metrics.distinct_source_count}
Confidence: ${metrics.confidence}
Specificity score: ${metrics.specificity_score}`;

  const lifecycle_history_block = lifecycle_history.length
    ? lifecycle_history.map((h, i) =>
        `${i + 1}. ${h.evaluated_at} — ${h.prior_status} → ${h.new_status} | heat ${h.prior_heat} → ${h.new_heat} ` +
        `${h.retirement_proposal ? "[RETIREMENT_PROPOSED] " : ""}` +
        `reason: ${(h.reasoning || "").slice(0, 200)}`
      ).join("\n")
    : "(no prior lifecycle evaluations)";

  const recent_signals_block = recent_signals.length
    ? recent_signals.slice(0, 20).map((s, i) =>
        `${i + 1}. [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
      ).join("\n")
    : "(no signals in last 14d)";

  const neighbor_block = neighbor_pool.length
    ? neighbor_pool.slice(0, 10).map((n, i) =>
        `${i + 1}. sim=${n.similarity.toFixed(2)} | ${n.lifecycle_status} | "${n.trend_name_b2c || n.trend_topic}" (heat ${n.heat})`
      ).join("\n")
    : "(no neighbors in pool)";

  const candidate_signals_block = candidate_signals.length
    ? candidate_signals.map((s, i) =>
        `${i + 1}. sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp} — "${(s.signal_title || "").slice(0, 120)}"`
      ).join("\n")
    : "(no vector-similar signals in last 7d)";

  const heat_baseline_block = `heat_base = ${heat_base}
components: ${fmtJson(components)}
formula: 25*recency + 25*velocity + 40*breadth + 10*confidence  (LINKED evidence only)
heat_base_delta (vs prior eval's heat_base): ${heatDelta !== null ? heatDelta : "(first eval)"}
heat_trajectory (committed heat, recent evals, newest first): ${heatTrajectory || "(first eval)"}
LINKED signals last 7d: ${last7dCount}  |  prior week (7-14d ago): ${priorWeekCount}
LINKED signals last 24h: ${last24hCount}
days since newest linked signal: ${daysSilent !== null ? daysSilent : "(none in 14d window)"}
active publisher domains (last 21d): ${activeDomains}
Status heat factor is FIXED and applied at commit: GROWING/RESURGENT +10%, STABLE/NEW 0%, DECLINING -10%, DORMANT -15%.`;

  return {
    metrics,
    heat_base,
    components,
    blocks: {
      trend_state_block,
      metrics_block,
      lifecycle_history_block,
      recent_signals_block,
      candidate_signals_block,
      neighbor_block,
      heat_baseline_block,
    },
  };
}

// prompts_rows (PROMPTS_SQL) + one trend's blocks -> the rendered system prompt.
export function renderSystemPrompt(prompts_rows, blocks) {
  const loaded = loadPrompts(prompts_rows);
  const systemPrompt = mustGet(loaded, SYSTEM_PROMPT_KEY);
  const rubric = mustGet(loaded, RUBRIC_PROMPT_KEY);

  return render(systemPrompt.template, {
    decision_rubric: rubric.template,
    ...blocks,
  });
}
