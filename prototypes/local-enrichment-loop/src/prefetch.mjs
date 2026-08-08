// PROTOTYPE (CRMA-438) — the five prefetch queries ported from
// enrichment-p_xMC995w/workflow.yaml (q_metrics, q_signals,
// q_source_metrics, q_neighbors, q_prompts), parameterized on trend_id.
// All SELECTs — the prototype never writes to Snowflake.
//
// --capture saves the results as JSON fixtures; --fixture replays them
// offline (sub-second edit→rerun, no warehouse in the loop).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSql, sqlEscape } from "./lib/snow.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIR = process.env.FIXTURE_DIR || join(ROOT, "fixtures");

export const QUERIES = {
  q_metrics: (tid) => `
    WITH lc AS (
      SELECT NEW_STATUS AS LIFECYCLE_STATUS, NEW_HEAT AS HEAT_INDEX
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
      WHERE TREND_ID = '${tid}'
      ORDER BY EVALUATED_AT DESC LIMIT 1
    ),
    agg AS (
      SELECT
        (SELECT COUNT(DISTINCT f.value::STRING)
           FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c, LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
          WHERE c.CANDIDATE_ID = (SELECT CANDIDATE_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS WHERE TREND_ID = '${tid}')
             OR c.DEDUP_OF_TREND_ID = '${tid}') AS TOTAL_CLUSTER_SIZE,
        (SELECT COUNT(DISTINCT k.value::STRING)
           FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c, LATERAL FLATTEN(INPUT => OBJECT_KEYS(c.SOURCE_BREAKDOWN)) k
          WHERE c.CANDIDATE_ID = (SELECT CANDIDATE_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS WHERE TREND_ID = '${tid}')
             OR c.DEDUP_OF_TREND_ID = '${tid}') AS DISTINCT_SOURCE_COUNT
    )
    SELECT t.TREND_ID, t.TREND_TOPIC,
           agg.TOTAL_CLUSTER_SIZE, agg.DISTINCT_SOURCE_COUNT,
           COALESCE(lc.LIFECYCLE_STATUS, 'NEW') AS VELOCITY_DIRECTION,
           COALESCE(lc.HEAT_INDEX, 0) AS TREND_HEAT_INDEX,
           t.DETECTED_AT, t.LAST_UPDATE_AT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    LEFT JOIN lc  ON TRUE
    LEFT JOIN agg ON TRUE
    WHERE t.TREND_ID = '${tid}'`,

  q_signals: (tid) => `
    WITH cand AS (
      SELECT c.SUPPORTING_SIGNAL_IDS
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
      JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
        ON c.CANDIDATE_ID = t.CANDIDATE_ID
            OR c.DEDUP_OF_TREND_ID = t.TREND_ID
      WHERE t.TREND_ID = '${tid}'
    ),
    sig_ids AS (
      SELECT DISTINCT f.value::STRING AS sid
      FROM cand, LATERAL FLATTEN(input => cand.SUPPORTING_SIGNAL_IDS) f
    )
    SELECT
      x.URL,
      x.SIGNAL_TITLE        AS TITLE,
      x.SOURCE_NAME         AS SIGNAL_NAME,
      COALESCE(SPLIT_PART(SPLIT_PART(x.URL, '://', 2), '/', 1), '?') AS DOMAIN,
      x.SIGNAL_TIMESTAMP    AS DETECTED_AT,
      NULL::FLOAT           AS PAGERANK_SCORE,
      NULL                  AS INGESTION_ID,
      x.SIGNAL_TEXT         AS ARTICLE_BODY,
      x.METADATA            AS SIGNAL_METADATA,
      x.SOURCE_NAME         AS X_SOURCE_NAME
    FROM sig_ids
    JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS x
      ON x.SIGNAL_ID = sig_ids.sid
    ORDER BY x.SIGNAL_TIMESTAMP DESC NULLS LAST
    LIMIT 10`,

  q_source_metrics: (tid) => `
    SELECT SOURCE_NAME, HEADLINE_METRIC, HEADLINE_METRIC_NAME, METRICS
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
    WHERE TREND_ID = '${tid}'`,

  q_neighbors: (tid) => `
    WITH latest_lifecycle AS (
      SELECT TREND_ID, NEW_STATUS AS LIFECYCLE_STATUS, NEW_HEAT AS HEAT_INDEX
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
      ) WHERE rn = 1
    ),
    latest_enrichment AS (
      SELECT TREND_ID,
             PAYLOAD:trend_name_b2c::STRING AS E_TREND_NAME_B2C,
             PAYLOAD:category::STRING       AS E_CATEGORY,
             PAYLOAD:subcategory::STRING    AS E_SUBCATEGORY,
             PAYLOAD:summary_short::STRING  AS SUMMARY_SHORT
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) AS rn
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
      ) WHERE rn = 1
    ),
    tc_for_agg AS (
      SELECT t.TREND_ID, c.SUPPORTING_SIGNAL_IDS, c.SOURCE_BREAKDOWN
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
      JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
        ON c.CANDIDATE_ID = t.CANDIDATE_ID OR c.DEDUP_OF_TREND_ID = t.TREND_ID
    ),
    agg AS (
      SELECT t.TREND_ID,
             COALESCE(s.TOTAL_CLUSTER_SIZE, 0)    AS TOTAL_CLUSTER_SIZE,
             COALESCE(src.DISTINCT_SOURCE_COUNT, 0) AS DISTINCT_SOURCE_COUNT
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
      LEFT JOIN (
        SELECT TREND_ID, COUNT(DISTINCT f.value::STRING) AS TOTAL_CLUSTER_SIZE
        FROM tc_for_agg, LATERAL FLATTEN(INPUT => SUPPORTING_SIGNAL_IDS) f
        GROUP BY TREND_ID
      ) s ON s.TREND_ID = t.TREND_ID
      LEFT JOIN (
        SELECT TREND_ID, COUNT(DISTINCT k.value::STRING) AS DISTINCT_SOURCE_COUNT
        FROM tc_for_agg, LATERAL FLATTEN(INPUT => OBJECT_KEYS(SOURCE_BREAKDOWN)) k
        GROUP BY TREND_ID
      ) src ON src.TREND_ID = t.TREND_ID
    )
    SELECT t.TREND_ID, t.TREND_TOPIC,
           agg.TOTAL_CLUSTER_SIZE, agg.DISTINCT_SOURCE_COUNT,
           COALESCE(lc.LIFECYCLE_STATUS, 'NEW') AS VELOCITY_DIRECTION,
           COALESCE(lc.HEAT_INDEX, 0) AS TREND_HEAT_INDEX,
           t.LAST_UPDATE_AT,
           COALESCE(t.CATEGORY, e.E_CATEGORY)             AS CATEGORY,
           COALESCE(t.SUBCATEGORY, e.E_SUBCATEGORY)       AS SUBCATEGORY,
           COALESCE(t.TREND_NAME, t.TREND_NAME_B2C, e.E_TREND_NAME_B2C) AS TREND_NAME,
           COALESCE(t.TREND_NAME_B2C, e.E_TREND_NAME_B2C) AS TREND_NAME_B2C,
           e.SUMMARY_SHORT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
    LEFT JOIN latest_lifecycle  lc  ON lc.TREND_ID  = t.TREND_ID
    LEFT JOIN latest_enrichment e   ON e.TREND_ID   = t.TREND_ID
    LEFT JOIN agg               agg ON agg.TREND_ID = t.TREND_ID
    WHERE COALESCE(lc.LIFECYCLE_STATUS, 'NEW') != 'RETIRED'
      AND t.LAST_UPDATE_AT > DATEADD(day, -14, CURRENT_TIMESTAMP())
      AND t.TREND_ID != '${tid}'
    ORDER BY COALESCE(lc.HEAT_INDEX, 0) DESC NULLS LAST
    LIMIT 30`,

  q_prompts: () => `
    SELECT PROMPT_KEY, VERSION, MODEL, TEMPLATE, MODEL_PARAMS
    FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
    WHERE IS_ACTIVE = TRUE
      AND PROMPT_KEY IN ('enrichment.agent.system', 'enrichment.agent.naming_guidance', 'enrichment.agent.user', 'enrichment.reviewer.decoder', 'enrichment.reviewer.verifier')`,
};

export async function prefetchLive(trend_id, { log = () => {} } = {}) {
  const tid = sqlEscape(trend_id);
  const out = {};
  // Sequential, mirroring the workflow's step order. (Pipedream also runs
  // these as separate sequential steps; parallelizing here would be a free
  // local win but would muddy the latency comparison.)
  for (const [name, build] of Object.entries(QUERIES)) {
    const started = Date.now();
    out[name] = await runSql(build(tid));
    log(`  ${name}: ${out[name].length} rows in ${Date.now() - started}ms`);
  }
  return out;
}

function fixturePath(trend_id) {
  return join(FIXTURE_DIR, `${trend_id}.json`);
}

export async function saveFixture(trend_id, data) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const p = fixturePath(trend_id);
  await writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

export async function loadFixture(trend_id) {
  const p = fixturePath(trend_id);
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    throw new Error(`no fixture at ${p} — run with --capture first (${e.message})`);
  }
}
