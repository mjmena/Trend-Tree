// Distillation — acquire_signal_ids
//
// Threshold-gated unclaimed signal ID fetch. Polls every 30-60 min; exits
// early if fewer than 150 unclaimed discovery signals are available —
// $.flow.exit() is a clean non-error termination, no cursor update, and the
// next cron poll will retry. Once 150+ are available the run proceeds.
//
// Window: 7 days on INGESTED_AT (the staging load time), NOT SIGNAL_TIMESTAMP.
// SIGNAL_TIMESTAMP is source-dated — discovery agents stamp it with the
// evidence article's publish date (weeks old), and gtrss with the trending
// query's pubDate — so windowing on it silently strands freshly-ingested
// signals whose source-date is older than 7d. Audit 2026-06-01: 184 of 354
// freshly-ingested discovery signals (all agent_chatgpt/grok/gemini — the
// cross-source corroboration material) were invisible to distillation for
// exactly this reason, starving candidates of a 2nd source family and
// collapsing the promotion rate. ORDER BY INGESTED_AT DESC so freshest-loaded
// are claimed first; older unclaimed drain when fresh ingestion is light.
// (Originally 24h, which stranded ~940 signals during the 2026-05-04→05-07
// cluster-agent silent-drop incident.)
//
// PER_SOURCE_CAP: no single source may occupy more than this many slots of
// the pool. Without it the gtrss flatten flood (~61% of the pool, audit
// 2026-06-01) crowds out every other source, leaving nothing to corroborate
// a topic across families. Capping guarantees the clustering proc sees the
// thin-but-diverse discovery signals it needs to build multi-family clusters.
//
// Floor lowered from 400 to 150 on 2026-05-07: the original sizing assumed
// agent-derived grok_live citations would contribute ~190/day, but those
// only land when the agent runs — creating a self-gating spiral when
// discovery throughput dips. 150 reflects the realistic external-pull
// floor (bluesky + google_trends + amazon + gemini verticals).

import snowflake from "snowflake-sdk";

const WINDOW_HOURS = 168; // 7 days
const POOL_LIMIT = 1600; // grouping pool (raised from 200 — clustering is ~8s
                         // at this size, O(N²) cosine graph; matches the
                         // nightly revisit pool so both passes see the same
                         // cross-source density needed for multi-family clusters)
const PER_SOURCE_CAP = 320; // max slots any one SOURCE_NAME may take (~20% of pool)
const MIN_POOL = 150; // gate: wait for this many before running

function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}

function execute(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows)),
    });
  });
}

function destroy(conn) {
  return new Promise((resolve) => conn.destroy(() => resolve()));
}

export default defineComponent({
  props: {
    snowflake: { type: "app", app: "snowflake" },
  },
  async run({ $ }) {
    const auth = this.snowflake.$auth;
    const conn = await connect({
      account: auth.account,
      username: auth.username,
      privateKey: auth.private_key,
      authenticator: "SNOWFLAKE_JWT",
      database: "MCC_RAW",
      schema: "MARKETING_DEV",
      role: "MARKETING_ENGINEER",
    });

    try {
      const rows = await execute(
        conn,
        `WITH unclaimed AS (
           SELECT SIGNAL_ID,
                  INGESTED_AT,
                  ROW_NUMBER() OVER (
                    PARTITION BY SOURCE_NAME ORDER BY INGESTED_AT DESC
                  ) AS rn_in_source
           FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
           WHERE INGESTED_AT > DATEADD(hour, -${WINDOW_HOURS}, CURRENT_TIMESTAMP())
             AND COALESCE(AGENT_SESSION_ID, '') = ''
             AND COALESCE(METADATA:signal_kind::STRING, 'discovery_signal') = 'discovery_signal'
         )
         SELECT SIGNAL_ID
         FROM unclaimed
         WHERE rn_in_source <= ${PER_SOURCE_CAP}
         ORDER BY INGESTED_AT DESC
         LIMIT ${POOL_LIMIT}`,
        [],
      );
      const ids = (Array.isArray(rows) ? rows : []).map((r) => r.SIGNAL_ID).filter(Boolean);

      if (ids.length < MIN_POOL) {
        $.flow.exit(`Only ${ids.length} unclaimed signals available — waiting for ${MIN_POOL}`);
      }

      console.log(`acquire_signal_ids: ${ids.length} unclaimed signals ready`);
      $.export("$summary", `${ids.length} signal IDs acquired`);
      return {
        signal_ids_json: JSON.stringify(ids),
        signal_ids: ids,
        count: ids.length,
      };
    } finally {
      await destroy(conn);
    }
  },
});
