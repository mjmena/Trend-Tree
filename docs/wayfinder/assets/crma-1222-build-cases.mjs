// Reconstructs, live from Snowflake, the candidate + full neighbor pool for
// every case in the CRMA-1216 widened replay set -- one object per AUDIT_ID,
// shaped to exactly the fields crma-1221-jev-questions.json's state_contract
// allows into the model. Mirrors the deployed queries in
// promotion-p_xMC99jg/workflow.yaml (q_load_pending_candidates,
// q_compute_vectors_and_neighbors, q_load_neighbor_signal_samples) verbatim,
// minus the PENDING-only WHERE clause (a historical candidate has long left
// that state -- same swap the wayfinder/gemini-3-7-flash-model-allocation
// harness's promotion.mjs makes). Ports that harness's already-validated
// anachronistic-neighbor cut (450/450 self-created trends dropped, 237/237
// merge targets kept, e864045) without depending on that branch.
//
// Run: node crma-1222-build-cases.mjs > crma-1222-cases.json

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TSV = join(HERE, "crma-1216-replay-set.tsv");
const OUT = join(HERE, "crma-1222-cases.json");

function q(sql) {
  const tmp = `/tmp/crma1222_q_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(tmp, sql);
  const out = execFileSync("snow", ["sql", "-c", "claude", "--format", "json", "-f", tmp], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
  return JSON.parse(out);
}

function sqlList(arr) {
  return arr.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",");
}

function parseTsv(text) {
  const [head, ...lines] = text.trim().split("\n");
  const cols = head.split("\t");
  return lines.map((line) => {
    const vals = line.split("\t");
    const row = {};
    cols.forEach((c, i) => (row[c] = vals[i]));
    return row;
  });
}

const rows = parseTsv(readFileSync(TSV, "utf8"));
console.error(`replay set: ${rows.length} rows`);

const candidateIds = [...new Set(rows.map((r) => r.CANDIDATE_ID))];
const chainIds = [...new Set(rows.map((r) => r.CHAIN_ID))];
console.error(`distinct candidates: ${candidateIds.length}, distinct chains: ${chainIds.length}`);

// ---- A. Candidate base fields (q_load_pending_candidates SELECT, WHERE swapped) ----
console.error("query A: candidate base fields...");
const candRows = q(`
  SELECT CANDIDATE_ID, TOPIC AS CANDIDATE_TOPIC, QUERY AS CANDIDATE_QUERY,
         SOURCE_BREAKDOWN, CONFIDENCE, SPECIFICITY_SCORE,
         ARRAY_SIZE(SUPPORTING_SIGNAL_IDS) AS CLUSTER_SIZE
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES
   WHERE CANDIDATE_ID IN (${sqlList(candidateIds)})
`);
const candById = new Map(candRows.map((r) => [r.CANDIDATE_ID, r]));

// ---- B. Candidate signals (ALL, not top-3 -- state_contract wants "every supporting signal") ----
console.error("query B: candidate signals...");
const sigRows = q(`
  SELECT c.CANDIDATE_ID, es.SIGNAL_TITLE, PARSE_URL(es.URL):host::STRING AS DOMAIN
    FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
         LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
    JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS es ON es.SIGNAL_ID = f.value::STRING
   WHERE c.CANDIDATE_ID IN (${sqlList(candidateIds)})
     AND es.SIGNAL_TITLE IS NOT NULL
`);
const sigsByCid = new Map();
for (const r of sigRows) {
  const list = sigsByCid.get(r.CANDIDATE_ID) || [];
  list.push({ publisher: r.DOMAIN || null, signal_text: r.SIGNAL_TITLE });
  sigsByCid.set(r.CANDIDATE_ID, list);
}

// ---- C. Neighbor pool (vector similarity, mirrors q_compute_vectors_and_neighbors) ----
console.error("query C: neighbor pool (recomputes embeddings -- slow)...");
const neighRows = q(`
  WITH ranked_signals AS (
    SELECT c.CANDIDATE_ID, s.SIGNAL_TITLE, s.INGESTED_AT
      FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c,
           LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
      JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s ON s.SIGNAL_ID = f.value::STRING
     WHERE c.CANDIDATE_ID IN (${sqlList(candidateIds)})
       AND s.SIGNAL_TITLE IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY c.CANDIDATE_ID ORDER BY s.INGESTED_AT DESC) <= 3
  ),
  candidate_signal_titles AS (
    SELECT CANDIDATE_ID, LISTAGG(SIGNAL_TITLE, ', ') WITHIN GROUP (ORDER BY INGESTED_AT DESC) AS TOP_SIGNAL_TITLES
      FROM ranked_signals GROUP BY CANDIDATE_ID
  ),
  candidate_text AS (
    SELECT c.CANDIDATE_ID,
           COALESCE(c.TOPIC,'') || ' | ' || COALESCE(LEFT(c.REASONING,800),'') || ' | ' || COALESCE(t.TOP_SIGNAL_TITLES,'') AS EMBEDDING_TEXT
      FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c
      LEFT JOIN candidate_signal_titles t ON c.CANDIDATE_ID = t.CANDIDATE_ID
     WHERE c.CANDIDATE_ID IN (${sqlList(candidateIds)})
  ),
  candidate_vectors AS (
    SELECT CANDIDATE_ID, SNOWFLAKE.CORTEX.EMBED_TEXT_1024('snowflake-arctic-embed-l-v2.0', EMBEDDING_TEXT) AS CANDIDATE_VECTOR
      FROM candidate_text
  ),
  latest_enrichment_with_vec AS (
    SELECT TREND_ID, TREND_VECTOR, PAYLOAD:summary_short::STRING AS SUMMARY_SHORT
      FROM (SELECT TREND_ID, TREND_VECTOR, PAYLOAD, ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) rn
              FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER WHERE TREND_VECTOR IS NOT NULL) WHERE rn = 1
  )
  SELECT c.CANDIDATE_ID, t.TREND_ID AS NEIGHBOR_TREND_ID, t.TREND_TOPIC AS NEIGHBOR_TOPIC,
         e.SUMMARY_SHORT AS NEIGHBOR_SUMMARY, t.PROMOTED_AT AS NEIGHBOR_PROMOTED_AT,
         ROUND(VECTOR_COSINE_SIMILARITY(c.CANDIDATE_VECTOR, e.TREND_VECTOR), 4) AS SIMILARITY
    FROM candidate_vectors c
    JOIN latest_enrichment_with_vec e ON VECTOR_COSINE_SIMILARITY(c.CANDIDATE_VECTOR, e.TREND_VECTOR) >= 0.50
    JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = e.TREND_ID
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.CANDIDATE_ID ORDER BY SIMILARITY DESC) <= 20
  ORDER BY c.CANDIDATE_ID, SIMILARITY DESC
`);
console.error(`neighbor rows (pre-cut, up to 20/candidate): ${neighRows.length}`);
const neighByCid = new Map();
for (const r of neighRows) {
  const list = neighByCid.get(r.CANDIDATE_ID) || [];
  list.push(r);
  neighByCid.set(r.CANDIDATE_ID, list);
}

// ---- D. Chain windows (FIRST_AT/LAST_AT per CHAIN_ID) ----
console.error("query D: chain windows...");
const chainRows = q(`
  SELECT CHAIN_ID, MIN(DECIDED_AT) AS FIRST_AT, MAX(DECIDED_AT) AS LAST_AT
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_PROMOTION_LEDGER
   WHERE CHAIN_ID IN (${sqlList(chainIds)})
   GROUP BY CHAIN_ID
`);
const chainWindow = new Map(chainRows.map((r) => [r.CHAIN_ID, r]));

// ---- E. Neighbor signal samples (3 per neighbor trend) ----
const allNeighborTrendIds = [...new Set(neighRows.map((r) => r.NEIGHBOR_TREND_ID).filter(Boolean))];
console.error(`query E: signal samples for ${allNeighborTrendIds.length} neighbor trends...`);
const sampleRows = allNeighborTrendIds.length
  ? q(`
    WITH neighbor_signals AS (
      SELECT t.TREND_ID, es.SIGNAL_TITLE, PARSE_URL(es.URL):host::STRING AS DOMAIN, es.SIGNAL_TIMESTAMP AS DETECTED_AT
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t
        JOIN MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES c ON c.CANDIDATE_ID = t.CANDIDATE_ID OR c.DEDUP_OF_TREND_ID = t.TREND_ID
        , LATERAL FLATTEN(INPUT => c.SUPPORTING_SIGNAL_IDS) f
        JOIN MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS es ON es.SIGNAL_ID = f.value::STRING
       WHERE t.TREND_ID IN (${sqlList(allNeighborTrendIds)}) AND es.SIGNAL_TITLE IS NOT NULL
    )
    SELECT TREND_ID, SIGNAL_TITLE, DOMAIN, DETECTED_AT FROM neighbor_signals
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY DETECTED_AT DESC NULLS LAST) <= 3
  `)
  : [];
const samplesByTrend = new Map();
for (const r of sampleRows) {
  const list = samplesByTrend.get(r.TREND_ID) || [];
  list.push({ publisher: r.DOMAIN || null, signal_text: r.SIGNAL_TITLE });
  samplesByTrend.set(r.TREND_ID, list);
}

// ---- Assemble one case object per AUDIT_ID, applying the anachronistic cut per its own chain window ----
const cases = {};
let noCand = 0, noWindow = 0;
for (const row of rows) {
  const c = candById.get(row.CANDIDATE_ID);
  if (!c) { noCand++; continue; }
  const win = chainWindow.get(row.CHAIN_ID);
  const cutoff = win ? new Date(new Date(win.FIRST_AT).getTime() - 5 * 60 * 1000) : null;
  if (!win) noWindow++;

  const allNeighbors = neighByCid.get(row.CANDIDATE_ID) || [];
  const kept = allNeighbors
    .filter((n) => {
      if (!cutoff || !n.NEIGHBOR_PROMOTED_AT) return true;
      return new Date(n.NEIGHBOR_PROMOTED_AT) < cutoff;
    })
    .sort((a, b) => b.SIMILARITY - a.SIMILARITY)
    .slice(0, 8);

  const sourceBreakdown = (() => {
    try {
      return typeof c.SOURCE_BREAKDOWN === "string" ? JSON.parse(c.SOURCE_BREAKDOWN) : c.SOURCE_BREAKDOWN;
    } catch {
      return {};
    }
  })();

  cases[row.AUDIT_ID] = {
    audit_id: row.AUDIT_ID,
    candidate_id: row.CANDIDATE_ID,
    chain_id: row.CHAIN_ID,
    stratum: row.STRATUM,
    ledger: row, // full TSV row for scoring later
    candidate: {
      trend_topic: c.CANDIDATE_TOPIC,
      candidate_query: c.CANDIDATE_QUERY || null,
      sources: Object.entries(sourceBreakdown).map(([source_name, signal_count]) => ({ source_name, signal_count })),
      signals: sigsByCid.get(row.CANDIDATE_ID) || [],
    },
    source_breakdown_raw: sourceBreakdown, // not sent to model -- for family re-derivation only
    neighbors: kept.map((n) => ({
      trend_id: n.NEIGHBOR_TREND_ID,
      trend_topic: n.NEIGHBOR_TOPIC,
      summary: n.NEIGHBOR_SUMMARY || null,
      similarity: n.SIMILARITY, // not sent to model -- for our own diagnostics only
      sample_signals: samplesByTrend.get(n.NEIGHBOR_TREND_ID) || [],
    })),
    excluded_as_anachronistic: allNeighbors.length - kept.length,
  };
}

writeFileSync(OUT, JSON.stringify(cases, null, 2));
console.error(`wrote ${Object.keys(cases).length} cases to ${OUT} (missing candidate row: ${noCand}, missing chain window: ${noWindow})`);
