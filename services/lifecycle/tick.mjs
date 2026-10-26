// Cloud Run job entrypoint: one lifecycle tick, then exit. The tick itself is
// services/lib/lifecycle_tick.mjs; this file wires Snowflake and Gemini to it.
// Exit 0 with a one-line JSON summary, or exit 1 with the error on stderr.

import { pathToFileURL } from "node:url";
import { createGeminiBatchClient } from "../lib/gemini_batch.mjs";
import { runTick } from "../lib/lifecycle_tick.mjs";
import { loadConfig } from "./config.mjs";
import { connect, destroy, execute } from "./snowflake.mjs";

async function main() {
  const config = loadConfig();
  const conn = await connect(config.snowflake);
  try {
    const summary = await runTick({
      query: (sql, binds) => execute(conn, sql, binds),
      gemini: createGeminiBatchClient({ apiKey: config.geminiApiKey }),
      cap: config.cap,
    });
    console.log(JSON.stringify({ message: "lifecycle tick complete", ...summary }));
  } finally {
    await destroy(conn);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`lifecycle tick failed: ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}
