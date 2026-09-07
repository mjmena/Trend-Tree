import { test } from "node:test";
import assert from "node:assert/strict";

import { handleJob, handlePull } from "./server.mjs";
import { loadConfig } from "./config.mjs";
import { BrightDataError } from "./brightdata.mjs";

const ENV = {
  BRIGHTDATA_API_KEY: "test-key",
  BD_DATASET_TIKTOK_POSTS: "gd_tiktok",
  BD_DATASET_REDDIT_POSTS: "gd_reddit",
  BD_WEB_UNLOCKER_ZONE: "test_zone",
  SOURCES_ENABLED: "tiktok,reddit,kickstarter",
};
const config = (over = {}) => loadConfig({ ...ENV, ...over });

const tiktokRecord = {
  post_id: "7",
  video_url: "https://www.tiktok.com/@a/video/7",
  description: "d",
  music: "original sound - a",
};

// --- POST /pull -------------------------------------------------------------

test("a dataset pull triggers the vendor job and returns its snapshot as a job id", async () => {
  let seen;
  const out = await handlePull({
    config: config(),
    body: { source: "tiktok", params: { keywords: ["cookies"] } },
    deps: {
      triggerCollection: async (args) => {
        seen = args;
        return "s_snap1";
      },
    },
  });

  assert.equal(out.status, 202);
  assert.equal(out.body.job_id, "bd.tiktok.s_snap1");
  assert.equal(seen.datasetId, "gd_tiktok", "the dataset id comes from config, not from code");
  assert.equal(seen.discoverBy, "keyword");
  assert.deepEqual(seen.input, [{ search_keyword: "cookies" }]);
});

test("reddit pulls use the reddit dataset and the subreddit discover mode", async () => {
  let seen;
  await handlePull({
    config: config(),
    body: { source: "reddit", params: { subreddit_urls: ["https://www.reddit.com/r/cooking/"] } },
    deps: { triggerCollection: async (a) => ((seen = a), "s_2") },
  });
  assert.equal(seen.datasetId, "gd_reddit");
  assert.equal(seen.discoverBy, "subreddit_url");
});

// Kickstarter has no vendor job, so its POST must NOT call the vendor at all —
// the fetch is deferred into the job id. See scrape_requests.mjs's header.
test("a kickstarter pull calls no vendor endpoint and encodes its request in the job id", async () => {
  const out = await handlePull({
    config: config(),
    body: { source: "kickstarter", params: { category_ids: ["22"], raised: "2" } },
    deps: {
      triggerCollection: async () => assert.fail("kickstarter must not trigger a dataset job"),
    },
  });
  assert.equal(out.status, 202);
  assert.equal(out.body.job_id, "bd.kickstarter.c22-r2");
});

// A warning must reach the caller, not just the log. sort_by=Top with no time
// window silently returns all-time posts, which repeat on every pull — an
// invisible mistake unless the response says so.
test("a request that will misbehave still runs, but returns its warning", async () => {
  const out = await handlePull({
    config: config(),
    body: { source: "reddit", params: { subreddit_urls: ["https://www.reddit.com/r/cooking/"], sort_by: "Top" } },
    deps: { triggerCollection: async () => "s_1" },
  });
  assert.equal(out.status, 202, "a warning is not a rejection");
  assert.match(out.body.warnings[0], /ALL-TIME/);
});

test("a clean request carries no warnings key at all", async () => {
  const out = await handlePull({
    config: config(),
    body: {
      source: "reddit",
      params: { subreddit_urls: ["https://www.reddit.com/r/cooking/"], sort_by: "Top", sort_by_time: "Today" },
    },
    deps: { triggerCollection: async () => "s_1" },
  });
  assert.equal("warnings" in out.body, false);
});

// The kill switch is the lever for the TikTok precedent: a scraped surface
// that vanishes while the scraper keeps reporting success.
test("a disabled source is refused with 403 and never reaches the vendor", async () => {
  await assert.rejects(
    handlePull({
      config: config({ SOURCES_ENABLED: "reddit" }),
      body: { source: "tiktok", params: { keywords: ["x"] } },
      deps: { triggerCollection: async () => assert.fail("disabled source reached the vendor") },
    }),
    (err) => err.status === 403,
  );
});

test("an invalid request is refused before the vendor is called", async () => {
  await assert.rejects(
    handlePull({
      config: config(),
      body: { source: "tiktok", params: {} },
      deps: { triggerCollection: async () => assert.fail("invalid request reached the vendor") },
    }),
  );
});

test("kickstarter without a configured zone fails at POST, not at poll time", async () => {
  await assert.rejects(
    handlePull({
      config: config({ BD_WEB_UNLOCKER_ZONE: "" }),
      body: { source: "kickstarter", params: { category_ids: ["22"] } },
    }),
    (err) => err.status === 503,
  );
});

// --- GET /pull/{job_id} -----------------------------------------------------

test("a running job reports its status without downloading anything", async () => {
  const out = await handleJob({
    config: config(),
    jobId: "bd.tiktok.s_snap1",
    deps: {
      getProgress: async () => ({ status: "running" }),
      downloadSnapshot: async () => assert.fail("downloaded a job that was not ready"),
    },
  });
  assert.equal(out.status, 200, "progress is a successful answer, not an error");
  assert.equal(out.body.status, "running");
});

// A terminal vendor failure must be reported as such, so a caller polling a
// dead job stops instead of looping until its own timeout.
test("a failed or canceled job is reported terminally, not as still-running", async () => {
  for (const status of ["failed", "canceled"]) {
    const out = await handleJob({
      config: config(),
      jobId: "bd.tiktok.s_snap1",
      deps: { getProgress: async () => ({ status }) },
    });
    assert.equal(out.body.status, status);
  }
});

test("a ready job downloads, normalizes, and reports the reject counters", async () => {
  const out = await handleJob({
    config: config(),
    jobId: "bd.tiktok.s_snap1",
    deps: {
      getProgress: async () => ({ status: "ready" }),
      downloadSnapshot: async () => [tiktokRecord, { post_id: "8" }],
    },
  });
  assert.equal(out.body.status, "ready");
  assert.equal(out.body.records.length, 1);
  assert.equal(out.body.rejected, 1);
  assert.deepEqual(out.body.reject_reasons, { "missing:url,description,sound": 1 });
  assert.equal(out.body.records[0].sound, "original sound - a");
});

test("the job id alone selects the normalizer — no stored record of the POST", async () => {
  const out = await handleJob({
    config: config(),
    jobId: "bd.reddit.s_snap9",
    deps: {
      getProgress: async () => ({ status: "ready" }),
      downloadSnapshot: async () => [
        {
          post_id: "t3_a",
          url: "https://www.reddit.com/r/cooking/comments/a/x/",
          title: "t",
          description: "b",
          community_name: "cooking",
          num_upvotes: 5,
        },
      ],
    },
  });
  // `subreddit` and `score` only exist if the REDDIT normalizer ran.
  assert.equal(out.body.records[0].subreddit, "cooking");
  assert.equal(out.body.records[0].score, 5);
});

test("a malformed job id is rejected rather than dispatched", async () => {
  await assert.rejects(handleJob({ config: config(), jobId: "bd.tiktok" }));
  await assert.rejects(handleJob({ config: config(), jobId: "zyte.tiktok.s_1" }));
});

// --- the deferred kickstarter fetch ----------------------------------------

test("a kickstarter GET performs the fetch and normalizes the projects array", async () => {
  let fetched;
  const out = await handleJob({
    config: config(),
    jobId: "bd.kickstarter.c22-r2",
    deps: {
      unlockerFetch: async (args) => {
        fetched = args;
        return JSON.stringify({
          total_hits: 41,
          projects: [
            {
              id: 5,
              name: "Thermos",
              urls: { web: { project: "https://www.kickstarter.com/projects/x/thermos" } },
              percent_funded: 192,
            },
          ],
        });
      },
    },
  });

  assert.equal(out.body.status, "ready");
  assert.equal(out.body.total_hits, 41);
  assert.equal(out.body.records[0].project_id, "5");
  assert.equal(fetched.zone, "test_zone");
  // The URL is rebuilt from the handle, and still carries the decided gate.
  assert.match(fetched.url, /category_id=22/);
  assert.match(fetched.url, /state=live/);
  assert.match(fetched.url, /raised=2/);
});

// The single most likely failure of CRMA-984's route. HTML coming back means
// ?format=json is not serving JSON — a ROUTE problem, not a Turnstile one —
// and the message must say so or the diagnosis goes down the wrong path.
test("an HTML body from kickstarter is a 502 naming the route, not a crash", async () => {
  await assert.rejects(
    handleJob({
      config: config(),
      jobId: "bd.kickstarter.c22",
      deps: { unlockerFetch: async () => "<!doctype html><title>Just a moment...</title>" },
    }),
    (err) => err.status === 502 && /format=json/.test(err.message),
  );
});

test("a vendor error propagates as a vendor error, not as a normalization failure", async () => {
  await assert.rejects(
    handleJob({
      config: config(),
      jobId: "bd.tiktok.s_gone",
      deps: {
        getProgress: async () => {
          throw new BrightDataError("snapshot not found", { status: 404 });
        },
      },
    }),
    BrightDataError,
  );
});

// --- config -----------------------------------------------------------------

test("a missing deploy variable fails at startup rather than at first request", () => {
  for (const key of ["BRIGHTDATA_API_KEY", "BD_DATASET_TIKTOK_POSTS", "SOURCES_ENABLED"]) {
    const env = { ...ENV };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  }
});

test("SOURCES_ENABLED is parsed into a working kill switch", () => {
  const c = config({ SOURCES_ENABLED: " tiktok , Reddit " });
  assert.equal(c.isEnabled("tiktok"), true);
  assert.equal(c.isEnabled("reddit"), true, "source names are compared lowercased");
  assert.equal(c.isEnabled("kickstarter"), false);
});
