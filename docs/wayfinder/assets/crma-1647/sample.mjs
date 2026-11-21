// CRMA-1647 step 1: draw the 120-trend stratified sample CRMA-1646 defines.
//
// Strata are disjoint. A trend goes to the FIRST stratum it qualifies for, in
// this order, because the 7-day window is thin: only ~260 trends had an
// evaluation, and nearly every GROWING/DECLINING trend also changed status in
// it. Drawing the status-change stratum first would starve the hold stratum.
//
//   dormant     current DORMANT; every live trend with a recent retirement
//               proposal first, then other DORMANT trends to fill 25
//   reenrich    a re-enrichment request in the window (20)
//   gd_hold     current GROWING/DECLINING, latest evaluation held status (15)
//   change      Pro changed status in the window (40)
//   control     current STABLE, no change and no request in the window (20)
//
// RETIRED trends are excluded: the sweep never evaluates them.
// The draw is deterministic (HASH on the trend id), so a re-run picks the
// same trends while the ledger window is unchanged.
//
//   node docs/wayfinder/assets/crma-1647/sample.mjs   → out/sample.json

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./lib/snowflake.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out", "sample.json");
const SIZES = { dormant: 25, reenrich: 20, gd_hold: 15, change: 40, control: 20 };

const rows = query(`
  WITH latest AS (
    SELECT TREND_ID, PRIOR_STATUS AS LAST_PRIOR, NEW_STATUS AS CUR_STATUS
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) = 1
  ), wk AS (
    SELECT TREND_ID,
           MAX(IFF(RETIREMENT_PROPOSAL IS NOT NULL, 1, 0)) AS RET,
           MAX(IFF(REQUESTED_RE_ENRICHMENT, 1, 0))        AS REENR,
           MAX(IFF(NEW_STATUS <> PRIOR_STATUS, 1, 0))      AS CHG,
           COUNT(*)                                        AS EVALS
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
    WHERE EVALUATED_AT >= DATEADD(day, -7, CURRENT_TIMESTAMP())
    GROUP BY TREND_ID
  )
  SELECT wk.TREND_ID, l.CUR_STATUS, l.LAST_PRIOR, wk.RET, wk.REENR, wk.CHG, wk.EVALS
  FROM wk JOIN latest l USING (TREND_ID)
  WHERE l.CUR_STATUS <> 'RETIRED'
  ORDER BY HASH(wk.TREND_ID, 'crma-1647')
`);

const taken = new Set();
const sample = [];
function take(stratum, pred, n) {
  const picked = rows.filter((r) => !taken.has(r.TREND_ID) && pred(r)).slice(0, n);
  for (const r of picked) {
    taken.add(r.TREND_ID);
    sample.push({ trend_id: r.TREND_ID, stratum, current_status: r.CUR_STATUS, retirement_proposal_7d: !!r.RET,
      re_enrichment_7d: !!r.REENR, status_change_7d: !!r.CHG, evals_7d: r.EVALS });
  }
  return picked.length;
}

const got = {};
got.dormant = take("dormant", (r) => r.CUR_STATUS === "DORMANT" && r.RET, SIZES.dormant);
got.dormant += take("dormant", (r) => r.CUR_STATUS === "DORMANT", SIZES.dormant - got.dormant);
got.reenrich = take("reenrich", (r) => r.REENR, SIZES.reenrich);
got.gd_hold = take("gd_hold", (r) => ["GROWING", "DECLINING"].includes(r.CUR_STATUS) && r.LAST_PRIOR === r.CUR_STATUS, SIZES.gd_hold);
got.change = take("change", (r) => r.CHG, SIZES.change);
got.control = take("control", (r) => r.CUR_STATUS === "STABLE" && !r.CHG && !r.REENR, SIZES.control);

const short = Object.entries(SIZES).filter(([k, n]) => got[k] < n).map(([k, n]) => `${k} ${got[k]}/${n}`);
writeFileSync(OUT, JSON.stringify({ drawn_at: new Date().toISOString(), sizes: got, short, trends: sample }, null, 2));
console.log(`eligible ${rows.length}; drawn ${JSON.stringify(got)}${short.length ? `; SHORT: ${short.join(", ")}` : ""} → ${OUT}`);
