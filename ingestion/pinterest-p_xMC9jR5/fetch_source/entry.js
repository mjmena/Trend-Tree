// Ingest Pinterest — fetch_source
//
// Scrapes Pinterest /ideas/ category pages for trending TodayArticle
// objects. The data is embedded in inline `<script>` blocks via
// __PWS_RELAY_REGISTER_COMPLETED_REQUEST__(...) calls; we extract them
// with a regex and parse the JSON. No auth required.
//
// This is brittle by nature — if Pinterest changes the inline script
// format, this needs updating. The legacy step logs a WARNING when a
// category yields zero results; we keep the same behavior.
//
// Port of trends-sql/pipedream/ingestion/ingest_pinterest_trends.mjs.

import crypto from "crypto";

const CATEGORIES = {
  beauty: "/ideas/beauty/935541271955/",
  "food-and-drink": "/ideas/food-and-drink/918530398158/",
  "home-decor": "/ideas/home-decor/935249274030/",
  "womens-fashion": "/ideas/womens-fashion/948967005229/",
  "mens-fashion": "/ideas/mens-fashion/924581335376/",
  "diy-and-crafts": "/ideas/diy-and-crafts/934876475639/",
  travel: "/ideas/travel/908182459161/",
};

const BASE_URL = "https://www.pinterest.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCategoryTrends(html, category, path) {
  const regex = /__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("[^"]+",\s*(.*?)\);/gs;
  const signals = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  let match;
  while ((match = regex.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }

    for (const queryData of Object.values(data?.data || {})) {
      let articles = [];
      if (queryData && typeof queryData === "object") {
        const d = queryData.data;
        if (Array.isArray(d)) {
          articles = d;
        } else if (d && typeof d === "object") {
          const edges = d.connection?.edges || [];
          articles = edges.map((e) => e.node || {});
        }
      }

      for (const article of articles) {
        if (!article || typeof article !== "object") continue;
        if (article.__typename !== "TodayArticle") continue;

        const title = article.title || "";
        if (!title) continue;

        const subtitle = article.subtitle || "";
        const entityId = article.entityId || "";
        const hash = crypto.createHash("md5").update(`${entityId}_${category}`).digest("hex").slice(0, 16);

        signals.push({
          SIGNAL_ID: `pinterest_${hash}`,
          SOURCE_NAME: "pinterest",
          SIGNAL_TIMESTAMP: now,
          SIGNAL_TITLE: title,
          SIGNAL_TEXT:
            `"${title}" is trending on Pinterest in ${category.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}` +
            (subtitle ? ` — ${subtitle}` : ""),
          METADATA: JSON.stringify({
            category,
            subtitle,
            entity_id: entityId,
            url: `${BASE_URL}${path}`,
          }),
        });
      }
    }
  }

  return signals;
}

export default defineComponent({
  async run({ $ }) {
    const allSignals = [];
    const errors = [];
    const seenTitles = new Set();

    for (const [category, path] of Object.entries(CATEGORIES)) {
      try {
        const resp = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();

        const signals = parseCategoryTrends(html, category, path);
        let count = 0;
        for (const s of signals) {
          const titleKey = s.SIGNAL_TITLE.toLowerCase();
          if (seenTitles.has(titleKey)) continue;
          seenTitles.add(titleKey);
          allSignals.push(s);
          count++;
        }
        if (count === 0) {
          console.warn(`WARNING: ${category} returned 0 trends — parser may be broken or page structure changed`);
        }
        console.log(`${category}: ${count} trends`);
      } catch (e) {
        const msg = `${category}: ${e.message}`;
        console.log(msg);
        errors.push(msg);
      }
      await sleep(2000);
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length}/${Object.keys(CATEGORIES).length} categories failed`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${allSignals.length} Pinterest signals`);
    $.export("$summary", `${allSignals.length} Pinterest signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
