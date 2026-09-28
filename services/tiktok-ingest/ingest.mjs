// TikTok ingester — Cloud Run JOB entrypoint (CRMA-1337, epic CRMA-1336).
//
// One run = up to 50 SerpApi short-video searches over the fixed seed list,
// the gemini-3.7-flash title filter, then one MERGE of the kept videos into
// STG_EXTERNAL_SIGNALS as SOURCE_NAME = 'tiktok'. TASK_PROMOTE_SIGNALS_TO_FCT
// moves them into FCT_SIGNALS. `gcloud run jobs execute trend-tree-tiktok-ingest`
// starts it by hand; CRMA-1338 adds the daily Cloud Scheduler trigger. The
// ingest logic lives in services/lib/tiktok_ingest.mjs; this file only wires
// the three I/O functions and turns the result into an exit code.
//
// The filter prompt is read from DIM_LLM_PROMPT BEFORE the first search. That
// read is the only statement ahead of the ingest, and it is read-only: a
// missing prompt row then fails the run without spending SerpApi quota.
//
// Exit 0 with a one-line JSON summary on stdout, or exit 1 with the error on
// stderr. The job has one retry (deploy.env). A retry within the hour costs no
// quota (SerpApi serves repeated queries from its cache), and the MERGE on
// SIGNAL_ID plus the video-ID dedup make a retry write nothing twice.

import { pathToFileURL } from "node:url";
import { createSerpApiClient } from "../lib/sources/serpapi.mjs";
import { createTitleFilter, TIKTOK_FILTER_MODEL } from "../lib/tiktok_filter.mjs";
import { runTikTokIngest } from "../lib/tiktok_ingest.mjs";
import { loadConfig } from "./config.mjs";
import { connect, destroy, execute } from "./snowflake.mjs";

const FILTER_PROMPT_KEY = "ingestion.tiktok.filter";

// ORDER BY VERSION DESC LIMIT 1: DIM_LLM_PROMPT's PRIMARY KEY is not enforced,
// so pick the newest active version deterministically.
const Q_PROMPT = `SELECT TEMPLATE, VERSION
FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT
WHERE PROMPT_KEY = ? AND IS_ACTIVE = TRUE
ORDER BY VERSION DESC
LIMIT 1`;

async function main() {
  const config = loadConfig();
  const conn = await connect(config.snowflake);
  try {
    const [prompt] = await execute(conn, Q_PROMPT, [FILTER_PROMPT_KEY]);
    if (!prompt?.TEMPLATE) {
      throw new Error(`${FILTER_PROMPT_KEY} prompt not found in DIM_LLM_PROMPT (IS_ACTIVE=TRUE)`);
    }
    const serpapi = createSerpApiClient({ apiKey: config.serpApiKey });
    const filter = createTitleFilter({ apiKey: config.geminiApiKey, systemPrompt: prompt.TEMPLATE });

    const summary = await runTikTokIngest({
      search: serpapi.search,
      filter,
      query: (sql, binds) => execute(conn, sql, binds),
      filterModel: TIKTOK_FILTER_MODEL,
    });
    console.log(JSON.stringify({ message: "tiktok ingest complete", promptVersion: prompt.VERSION, ...summary }));
  } finally {
    await destroy(conn);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`tiktok-ingest failed: ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}
