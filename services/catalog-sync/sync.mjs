// Catalog sync — Cloud Run JOB entrypoint (CRMA-777, epic CRMA-772).
//
// One run = one full sweep of the storefront products.json feed into
// DIM_CATALOG_PRODUCT, then exit. Cloud Scheduler starts it daily (see
// schedule.sh); `gcloud run jobs execute trend-tree-catalog-sync` starts it by
// hand. The sweep logic lives in services/lib/catalog_sync.mjs; this file only
// wires the two I/O functions and turns the result into an exit code.
//
// Exit 0 with a one-line JSON summary on stdout, or exit 1 with the error on
// stderr. A failed run leaves LAST_SEEN_AT where it was, so the audit agent's
// catalog-freshness row (CRMA-775) is the alert: YELLOW after 3 days, RED
// after 7. The job has one retry (deploy.env), and a retry is safe because a
// sweep is idempotent — unchanged products hash-match and are not re-embedded.

import { pathToFileURL } from "node:url";
import { runCatalogSync } from "../lib/catalog_sync.mjs";
import { fetchStorefrontProducts } from "../lib/storefront_feed.mjs";
import { loadConfig } from "./config.mjs";
import { connect, destroy, execute } from "./snowflake.mjs";

async function main() {
  const config = loadConfig();
  const conn = await connect(config.snowflake);
  try {
    const summary = await runCatalogSync({
      fetchProducts: () => fetchStorefrontProducts({ storeUrl: config.storeUrl }),
      query: (sql, binds) => execute(conn, sql, binds),
      storeUrl: config.storeUrl,
    });
    console.log(JSON.stringify({ message: "catalog sync complete", ...summary }));
  } finally {
    await destroy(conn);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`catalog-sync failed: ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}
