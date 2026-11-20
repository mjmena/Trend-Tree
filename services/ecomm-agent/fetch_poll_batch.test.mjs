import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import snowflake from "snowflake-sdk";
import { fetchPollBatch } from "./fetch_poll_batch.mjs";

const reference = readFileSync(new URL("../../sql/sourcing_poll_query.sql", import.meta.url), "utf8");
const fixtures = readFileSync(new URL("../../test/sourcing_poll.test.sql", import.meta.url), "utf8");
const normalizeSql = (sql) => sql.replace(/--[^\n]*/g, "").replace(/;/g, "").replace(/\s+/g, " ").trim();

test("poll executes the reference query with positional binds and maps its rows", async (t) => {
  const enrichedAt = new Date("2026-03-02T00:00:00.000Z");
  let executed;
  t.mock.method(snowflake, "createConnection", () => ({
    connect: (done) => done(null),
    destroy: (done) => done(null),
    execute({ sqlText, binds, complete }) {
      executed = { sqlText, binds };
      complete(null, null, [{ TREND_ID: "re-enriched", ENRICHED_AT: enrichedAt }]);
    },
  }));

  const batch = await fetchPollBatch({ connOpts: {}, tier: "shopify", staleMinutes: 30, limit: 25 });

  assert.deepEqual(executed.binds, ["shopify", 30, 25]);
  assert.equal(normalizeSql(executed.sqlText), normalizeSql(reference.replace(/:tier|:stale_minutes|:limit/g, "?")));
  assert.deepEqual(batch, [{ trend_id: "re-enriched", enriched_at: enrichedAt.toISOString() }]);
});

test("Snowflake fixtures exercise the reference query with only fixture scope and binds changed", () => {
  const fixtureQuery = fixtures.match(/CREATE OR REPLACE TEMPORARY TABLE _poll_claimed AS\n([\s\S]*?LIMIT 100;)/)?.[1];
  assert.ok(fixtureQuery, "fixture claim query must be present");
  const boundReference = reference.replace(/:tier/g, "'shopify'").replace(/:stale_minutes/g, "30").replace(/:limit/g, "100");

  assert.equal(
    normalizeSql(fixtureQuery.replace("AND e.TREND_ID LIKE 'zztest-poll-%'", "")),
    normalizeSql(boundReference),
  );
});
