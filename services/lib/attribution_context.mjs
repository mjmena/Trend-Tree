// The attribution job's pure parts: the set-based queries, the prompt blocks,
// one batch request per trend, the pool filter and the per-entry cost.
// Spec: docs/prd/attribution-job.md. The blocks and the schema are copies of
// lifecycle-attribution-subagent-p_PACe77B/run_subagent/entry.js.

import { groupByTrend, loadPrompts, mustGet, render } from "./lifecycle_context.mjs";

export { groupByTrend, loadPrompts, mustGet };

// CRMA-1691 decides between this and gemini-3.1-pro-preview.
export const JOB_MODEL = "gemini-3.8-flash";
export const JOB_SYSTEM_PROMPT_KEY = "signal.attribution.job.system";
export const RUBRIC_PROMPT_KEY = "signal.attribution.rubric";
export const SIMILARITY_THRESHOLD = "0.35";
export const LOOKBACK_HOURS = 72;
export const LINK_TYPES = ["news", "social", "commerce", "other"];

export const PROMPTS_SQL = `SELECT PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE IS_ACTIVE = TRUE
  AND PROMPT_KEY IN ('${JOB_SYSTEM_PROMPT_KEY}', '${RUBRIC_PROMPT_KEY}')`;

// DISTINCT: a repeated id would otherwise double that trend's rows.
const IDS_CTE = `ids AS (SELECT DISTINCT VALUE::STRING AS TREND_ID FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:1))))`;

// Timestamps leave Snowflake as the strings the Pipedream step rendered, so the
// prompt text does not depend on the driver's date type.
export const SET_QUERIES = {
  trend_context: `WITH ${IDS_CTE},
e AS (
  SELECT l.TREND_ID, l.PAYLOAD:summary_short::STRING AS SUMMARY_SHORT
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
  JOIN ids ON ids.TREND_ID = l.TREND_ID
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY l.WRITTEN_AT DESC) = 1
)
SELECT t.TREND_ID, t.TREND_TOPIC, t.TREND_NAME_B2C, t.TREND_NAME_B2B, t.CATEGORY, t.SUBCATEGORY,
       TO_VARCHAR(t.PROMOTED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF6') AS PROMOTED_AT, e.SUMMARY_SHORT
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN ids ON ids.TREND_ID = t.TREND_ID
LEFT JOIN e ON e.TREND_ID = t.TREND_ID
ORDER BY t.TREND_ID`,

  existing_source_types: `WITH ${IDS_CTE}
SELECT DISTINCT s.TREND_ID, s.LINK_TYPE
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS s
JOIN ids ON ids.TREND_ID = s.TREND_ID
WHERE s.LINK_TYPE IS NOT NULL
ORDER BY s.TREND_ID`,

  candidate_signals: `WITH ${IDS_CTE},
trend_vec AS (
  SELECT l.TREND_ID, l.TREND_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER l
  JOIN ids ON ids.TREND_ID = l.TREND_ID
  WHERE l.TREND_VECTOR IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.TREND_ID ORDER BY l.WRITTEN_AT DESC) = 1
),
new_signals AS (
  SELECT s.SIGNAL_ID, s.SOURCE_NAME, s.SIGNAL_TIMESTAMP, s.SIGNAL_TITLE,
         LEFT(s.SIGNAL_TEXT, 300) AS SIGNAL_TEXT, s.SIGNAL_VECTOR
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS s
  WHERE s.EMBEDDED_AT >= DATEADD(hour, -${LOOKBACK_HOURS}, CURRENT_TIMESTAMP())
    AND s.SIGNAL_VECTOR IS NOT NULL
)
SELECT tv.TREND_ID, ns.SIGNAL_ID, ns.SOURCE_NAME,
       TO_VARCHAR(ns.SIGNAL_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS') AS SIGNAL_TIMESTAMP,
       ns.SIGNAL_TITLE, ns.SIGNAL_TEXT,
       VECTOR_COSINE_SIMILARITY(tv.TREND_VECTOR, ns.SIGNAL_VECTOR) AS SIMILARITY
FROM trend_vec tv
CROSS JOIN new_signals ns
WHERE VECTOR_COSINE_SIMILARITY(tv.TREND_VECTOR, ns.SIGNAL_VECTOR) >= ${SIMILARITY_THRESHOLD}
  AND NOT EXISTS (
    SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS x
    WHERE x.SIGNAL_ID = ns.SIGNAL_ID AND x.TREND_ID = tv.TREND_ID
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY tv.TREND_ID ORDER BY SIMILARITY DESC) <= 20
ORDER BY tv.TREND_ID, SIMILARITY DESC`,
};

// Sweep order (CRMA-1692): never swept first, then least recently swept.
// LIMIT is the cap plus one, so the caller can tell whether the cap cut anything.
export const selectSql = (limit) => `WITH latest_lifecycle AS (
  SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) = 1
),
trends_with_vector AS (
  SELECT DISTINCT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL
),
last_sweep AS (
  SELECT f.VALUE::STRING AS TREND_ID, MAX(b.SUBMITTED_AT) AS LAST_SWEPT_AT
  FROM MCC_RAW.MARKETING_DEV.STG_ATTRIBUTION_BATCHES b,
       LATERAL FLATTEN(INPUT => b.TREND_IDS) f
  WHERE b.STATE = 'COLLECTED'
  GROUP BY 1
)
SELECT t.TREND_ID,
       IFF(ls.LAST_SWEPT_AT IS NULL OR ls.LAST_SWEPT_AT < DATEADD(hour, -24, CURRENT_TIMESTAMP()), TRUE, FALSE) AS OVERDUE
FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
JOIN trends_with_vector tv ON tv.TREND_ID = t.TREND_ID
LEFT JOIN latest_lifecycle lc ON lc.TREND_ID = t.TREND_ID
LEFT JOIN last_sweep ls ON ls.TREND_ID = t.TREND_ID
WHERE COALESCE(lc.LIFECYCLE_STATUS, 'NEW') NOT IN ('RETIRED', 'DORMANT')
ORDER BY ls.LAST_SWEPT_AT ASC NULLS FIRST, HASH(t.TREND_ID)
LIMIT ${limit}`;

// commit_attributions' input_schema, verbatim from run_subagent/entry.js.
export const ATTRIBUTION_SCHEMA = {
  type: "object",
  properties: {
    attributions: {
      type: "array",
      description: "Array of confirmed attributions. Each element: { signal_id, link_type }.",
      items: {
        type: "object",
        properties: {
          signal_id: { type: "string" },
          link_type: { type: "string", enum: LINK_TYPES },
        },
        required: ["signal_id", "link_type"],
      },
    },
  },
  required: ["attributions"],
};

/** One trend's candidate rows as the pool stored on the batch row. */
export function toPool(rows = []) {
  return rows.map((r) => ({
    signal_id: r.SIGNAL_ID,
    source_name: r.SOURCE_NAME,
    signal_timestamp: r.SIGNAL_TIMESTAMP,
    signal_title: r.SIGNAL_TITLE,
    signal_text: r.SIGNAL_TEXT,
    similarity: Number(r.SIMILARITY || 0),
  }));
}

/** The trend_block and candidate_signals_block, as run_subagent/entry.js renders them. */
export function buildBlocks(contextRow, sourceRows, pool) {
  const existing = (sourceRows || []).map((r) => r.LINK_TYPE).filter(Boolean);
  const trend_block =
    `TREND_ID: ${contextRow.TREND_ID}
TREND_TOPIC: ${contextRow.TREND_TOPIC}
TREND_NAME_B2B / B2C: ${contextRow.TREND_NAME_B2B || "(unenriched)"} / ${contextRow.TREND_NAME_B2C || "(unenriched)"}
CATEGORY: ${contextRow.CATEGORY || "?"} / ${contextRow.SUBCATEGORY || "?"}
PROMOTED_AT: ${contextRow.PROMOTED_AT}
SUMMARY: ${contextRow.SUMMARY_SHORT || "(no summary yet)"}
EXISTING SIGNAL SOURCE TYPES: ${existing.length ? existing.join(", ") : "(none yet)"}`;
  const candidate_signals_block = pool
    .map((s, i) =>
      `${i + 1}. [${s.signal_id}] sim=${s.similarity.toFixed(2)} [${s.source_name}] ${s.signal_timestamp}\n` +
      `   Title: "${(s.signal_title || "").slice(0, 120)}"\n` +
      `   Text: ${(s.signal_text || "").slice(0, 250)}`)
    .join("\n\n");
  return { trend_block, candidate_signals_block };
}

export function renderSystemPrompt(promptRows, blocks) {
  const loaded = loadPrompts(promptRows);
  return render(mustGet(loaded, JOB_SYSTEM_PROMPT_KEY).template, {
    ...blocks,
    similarity_threshold: SIMILARITY_THRESHOLD,
    attribution_rubric: mustGet(loaded, RUBRIC_PROMPT_KEY).template,
  });
}

export function buildBatchRequest({ trendId, topic, poolSize, systemPrompt, params = {} }) {
  return {
    metadata: { key: trendId },
    request: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{
        role: "user",
        parts: [{
          text: `Evaluate ${poolSize} candidate signals for trend ${trendId} ("${topic}"). ` +
            `Apply the attribution rubric to each candidate. ` +
            `Return the confirmed list as one JSON object (an empty array is a valid outcome).`,
        }],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: ATTRIBUTION_SCHEMA,
        maxOutputTokens: params.per_call_max_tokens,
        thinkingConfig: { thinkingLevel: params.thinking_level },
        temperature: 1.0,
      },
    },
  };
}

/** The `attributions` array of a response, or null when the answer is not usable. */
export function parseAttributions(response) {
  const text = (response?.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  try {
    const list = JSON.parse(text)?.attributions;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Keep the pairs whose signal is in the trend's pool and whose link_type is
 * allowed, once each (CRMA-1461). Returns the kept pairs and the dropped count.
 */
export function filterAttributions(list, pool) {
  const allowed = new Set(pool.map((s) => s.signal_id));
  const seen = new Set();
  const kept = [];
  for (const a of list) {
    if (!allowed.has(a?.signal_id) || !LINK_TYPES.includes(a?.link_type) || seen.has(a.signal_id)) continue;
    seen.add(a.signal_id);
    kept.push({ signal_id: a.signal_id, link_type: a.link_type });
  }
  return { kept, dropped: list.length - kept.length };
}

// Standard per-million rates; a batch entry bills half. Flash doubles on 2027-01-01.
const RATES = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, doublesAt: Date.UTC(2027, 0, 1) },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
};

/** One entry's cost in USD, thinking tokens billed as output. */
export function entryCost(usage = {}, { model = JOB_MODEL, batch = true, at = new Date() } = {}) {
  const r = RATES[model];
  if (!r) throw new Error(`attribution: no rates for ${model}`);
  const scale = (batch ? 0.5 : 1) * (r.doublesAt && at.getTime() >= r.doublesAt ? 2 : 1);
  const output = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const usd = ((usage.promptTokenCount || 0) * r.input + output * r.output) * scale / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
