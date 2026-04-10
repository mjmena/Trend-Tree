// Ingest TikTok Trending — fetch_source
//
// Loads TikTok's Creative Center "Popular Trends → Hashtag" page in
// a headless Chromium via @pipedream/browsers (Playwright). The
// page makes an internal `creative_radar_api/v1/popular_trend/hashtag/list`
// XHR with a page-generated auth token; we intercept the responses
// and pull out the hashtag list directly. Direct HTTP calls to that
// endpoint return code 40101 — Playwright is required.
//
// Port of trends-sql/pipedream/ingestion/ingest_tiktok_trending.mjs.
//
// Memory: this workflow needs lambda_memory: 2048 (Chromium overhead).
// Runtime: ~30s typical, sometimes longer if TikTok is slow to load.
//
// Brittleness: TikTok occasionally rolls anti-bot challenges that
// break this. The legacy comment notes a Python backfill in
// `trends-sql/ingest/backfill_tiktok.py` if this stops emitting.

import { playwright } from "@pipedream/browsers";

const BASE_URL =
  "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en";
const COUNTRY_CODE = "US";
const ITEMS_PER_PAGE = 50;

export default defineComponent({
  async run({ $ }) {
    const browser = await playwright.browser();
    const rawItems = [];

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "en-US",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Spoof navigator.webdriver and plugins to look more human
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      const page = await context.newPage();

      // Force the page's API requests to ask for full 50-item pages
      await page.route(
        "**/creative_radar_api/v1/popular_trend/hashtag/list*",
        (route) => {
          let url = route.request().url();
          url = url.replace(/limit=\d+/, `limit=${ITEMS_PER_PAGE}`);
          route.continue({ url });
        },
      );

      // Capture API responses
      page.on("response", async (response) => {
        if (
          response.url().includes("creative_radar_api") &&
          response.url().includes("hashtag/list")
        ) {
          try {
            const data = await response.json();
            if (data.code === 0 && data.data?.list) {
              rawItems.push(...data.data.list);
            }
          } catch {
            // ignore non-JSON responses
          }
        }
      });

      await page.goto(BASE_URL, { timeout: 30000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(5000);

      // Scroll to trigger second-page API call
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);

      await page.close();
      await context.close();
    } finally {
      await browser.close();
    }

    console.log(`Fetched ${rawItems.length} raw hashtag items`);

    // Dedup by hashtag name
    const seen = new Set();
    const unique = [];
    for (const item of rawItems) {
      const name = item.hashtag_name || "";
      if (name && !seen.has(name)) {
        seen.add(name);
        unique.push(item);
      }
    }
    unique.sort((a, b) => (a.rank || 999) - (b.rank || 999));

    // Drop promoted hashtags — they're paid, not organic trends
    const organic = unique.filter((item) => !item.is_promoted);
    console.log(
      `Filtered to ${organic.length} organic hashtags (removed ${unique.length - organic.length} promoted)`,
    );

    const now = new Date().toISOString().replace("T", " ").replace("Z", "");
    const allSignals = [];

    for (const item of organic) {
      const hashtag = item.hashtag_name;
      const rank = item.rank || 0;
      const views = item.video_views || 0;
      const publishCnt = item.publish_cnt || 0;
      const trend = item.trend || [];

      let growthPct = null;
      if (trend.length >= 2) {
        const firstVal = Math.max(trend[0]?.value || 0, 0.01);
        const lastVal = trend[trend.length - 1]?.value || 0;
        growthPct = Math.round(((lastVal - firstVal) / firstVal) * 100);
      }

      allSignals.push({
        SIGNAL_ID: `tiktok_${item.hashtag_id || hashtag}`,
        SOURCE_NAME: "tiktok",
        SIGNAL_TIMESTAMP: now,
        SIGNAL_TITLE: hashtag,
        SIGNAL_TEXT: `#${hashtag} is trending on TikTok US (rank #${rank}, ${views.toLocaleString()} views, ${growthPct != null ? `${growthPct}%` : "N/A"} 7d growth)`,
        METADATA: JSON.stringify({
          hashtag,
          hashtag_id: item.hashtag_id || "",
          rank,
          video_views: views,
          publish_count: publishCnt,
          growth_7d_pct: growthPct,
          rank_diff: item.rank_diff || 0,
          is_promoted: item.is_promoted || false,
          country: COUNTRY_CODE,
          url: `https://www.tiktok.com/tag/${hashtag}`,
        }),
      });
    }

    console.log(`Total: ${allSignals.length} TikTok signals`);
    $.export("$summary", `${allSignals.length} TikTok signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
    };
  },
});
