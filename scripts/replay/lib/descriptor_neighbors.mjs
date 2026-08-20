// Descriptor neighbor-quality comparison — the CRMA-728 axis.
//
// WHY THIS EXISTS. CRMA-728 split two efforts apart on one condition: that
// the descriptor axis could be judged WITHOUT a second production
// re-enrichment sweep. This module is that condition. For a replayed trend
// it embeds the candidate's `descriptor.statement`, finds its nearest
// neighbours among live trends, and puts them beside the neighbours of the
// incumbent's statement. If the candidate model writes statements that
// scramble identity structure, it shows up here and nowhere else — a
// statement can read beautifully and still embed badly.
//
// It also turns ADR-0003's method into re-runnable code. That ADR describes
// the legacy-vs-statement top-3 cosine comparison in prose, but its
// "Reproduce" section points at two temp tables and "see #54 working notes",
// with no SQL body. CRMA-464's gate is a re-run of that comparison at full
// active-set coverage, so the SQL living here is a standing win beyond this
// map.
//
// SAFETY. Everything here reads production and writes ONLY to a scratch
// table under MCC_RAW.MARKETING_DEV. It never touches
// FCT_TREND_ENRICHMENT_LEDGER, and it never updates a TREND_VECTOR. The
// ticket is explicit about that and so is this file.

import { query, execute, sqlStr, SCRATCH_SCHEMA } from "./snowflake.mjs";

/** Same Cortex model that produced TREND_VECTOR (sql/proc_enrichment_apply.sql:92). */
const EMBED_MODEL = "snowflake-arctic-embed-l-v2.0";

export const SCRATCH_TABLE = `${SCRATCH_SCHEMA}.TMP_REPLAY_DESCRIPTOR_NEIGHBORS`;

/**
 * The comparison pool: the latest enrichment vector per live trend.
 * Mirrors how every neighbour query in the fleet reads "current" state —
 * newest ledger row per trend, retired trends excluded.
 */
const POOL_CTE = `
  pool AS (
    SELECT e.TREND_ID,
           e.TREND_VECTOR,
           COALESCE(e.PAYLOAD:trend_name::STRING, t.TREND_TOPIC) AS TREND_NAME,
           e.PAYLOAD:category::STRING AS CATEGORY
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER e
      JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
     WHERE e.TREND_VECTOR IS NOT NULL
     QUALIFY ROW_NUMBER() OVER (PARTITION BY e.TREND_ID ORDER BY e.WRITTEN_AT DESC) = 1
  )`;

/**
 * Top-k neighbours for two statements, in one round trip.
 *
 * @param {object} a
 * @param {string} a.trendId            Excluded from its own neighbour list.
 * @param {string|null} a.incumbentStatement
 * @param {string|null} a.candidateStatement
 * @param {number} [a.k]
 * @returns {{incumbent: Array, candidate: Array, metrics: object}}
 */
export function compareStatements({ trendId, incumbentStatement, candidateStatement, k = 3 }) {
  if (!incumbentStatement && !candidateStatement) {
    return { incumbent: [], candidate: [], metrics: { skipped: "neither side has a descriptor.statement" } };
  }

  const sides = [];
  if (incumbentStatement) sides.push(["incumbent", incumbentStatement]);
  if (candidateStatement) sides.push(["candidate", candidateStatement]);

  const unions = sides
    .map(
      ([side, stmt]) => `
      SELECT '${side}' AS SIDE, p.TREND_ID, p.TREND_NAME, p.CATEGORY,
             VECTOR_COSINE_SIMILARITY(
               p.TREND_VECTOR,
               SNOWFLAKE.CORTEX.EMBED_TEXT_1024('${EMBED_MODEL}', ${sqlStr(stmt)})
             ) AS SIMILARITY
        FROM pool p
       WHERE p.TREND_ID <> ${sqlStr(trendId)}`,
    )
    .join("\n      UNION ALL");

  const rows = query(`
    WITH ${POOL_CTE},
    scored AS (${unions})
    SELECT SIDE, TREND_ID, TREND_NAME, CATEGORY, SIMILARITY
      FROM scored
    QUALIFY ROW_NUMBER() OVER (PARTITION BY SIDE ORDER BY SIMILARITY DESC) <= ${Number(k)}
     ORDER BY SIDE, SIMILARITY DESC
  `);

  const bySide = (s) =>
    rows
      .filter((r) => r.SIDE === s)
      .map((r) => ({
        trend_id: r.TREND_ID,
        trend_name: r.TREND_NAME,
        category: r.CATEGORY,
        similarity: Number(r.SIMILARITY),
      }));

  const incumbent = bySide("incumbent");
  const candidate = bySide("candidate");
  return { incumbent, candidate, metrics: metricsFor(incumbent, candidate) };
}

function mean(xs) {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
}

/**
 * The three numbers ADR-0003 actually judged on, plus set overlap.
 *
 * A NOTE ON READING THESE. ADR-0003 found that a LOWER mean cosine was an
 * improvement, not a regression — the legacy multi-field doc inflated
 * similarity through shared boilerplate. So do not read a cosine dip as a
 * loss on its own. Overlap and identical-#1 are the structural measures;
 * mean cosine is context.
 */
function metricsFor(incumbent, candidate) {
  if (!incumbent.length || !candidate.length) {
    return { note: "one side has no statement — nothing to compare" };
  }
  const ai = incumbent.map((n) => n.trend_id);
  const bi = candidate.map((n) => n.trend_id);
  const overlap = ai.filter((id) => bi.includes(id));
  return {
    mean_top_k_cosine_incumbent: mean(incumbent.map((n) => n.similarity)),
    mean_top_k_cosine_candidate: mean(candidate.map((n) => n.similarity)),
    identical_top_1: ai[0] === bi[0],
    overlap_count: overlap.length,
    overlap_pct: Math.round((overlap.length / ai.length) * 100),
    same_category_incumbent: incumbent.filter((n) => n.category).length,
    same_category_candidate: candidate.filter((n) => n.category).length,
  };
}

/** Create the scratch table if it is not there. Never a production ledger. */
export function ensureScratchTable() {
  execute(`
    CREATE TABLE IF NOT EXISTS ${SCRATCH_TABLE} (
      RUN_ID            VARCHAR,
      RUN_AT            TIMESTAMP_NTZ,
      LANE              VARCHAR,
      CANDIDATE_MODEL   VARCHAR,
      TREND_ID          VARCHAR,
      SIDE              VARCHAR,
      RANK              NUMBER,
      NEIGHBOR_TREND_ID VARCHAR,
      NEIGHBOR_NAME     VARCHAR,
      SIMILARITY        FLOAT,
      STATEMENT         VARCHAR
    )
  `);
}

/** Persist one comparison. Scratch only — see the header. */
export function persist({ runId, lane, candidateModel, trendId, incumbentStatement, candidateStatement, result }) {
  const rows = [];
  const push = (side, list, stmt) =>
    list.forEach((n, i) =>
      rows.push(
        `(${sqlStr(runId)}, CURRENT_TIMESTAMP(), ${sqlStr(lane)}, ${sqlStr(candidateModel)}, ${sqlStr(trendId)}, ` +
          `${sqlStr(side)}, ${i + 1}, ${sqlStr(n.trend_id)}, ${sqlStr(n.trend_name)}, ${n.similarity}, ${sqlStr(stmt)})`,
      ),
    );
  push("incumbent", result.incumbent, incumbentStatement);
  push("candidate", result.candidate, candidateStatement);
  if (!rows.length) return 0;

  execute(`
    INSERT INTO ${SCRATCH_TABLE}
      (RUN_ID, RUN_AT, LANE, CANDIDATE_MODEL, TREND_ID, SIDE, RANK,
       NEIGHBOR_TREND_ID, NEIGHBOR_NAME, SIMILARITY, STATEMENT)
    VALUES ${rows.join(",\n           ")}
  `);
  return rows.length;
}

/** Render one side's neighbours for the side-by-side view. */
export function formatNeighbors(list) {
  if (!list?.length) return "—";
  return list.map((n, i) => `${i + 1}. ${n.trend_name} [${n.similarity.toFixed(3)}]`).join("\n");
}
