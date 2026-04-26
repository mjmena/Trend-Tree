// Ingest Amazon Movers & Shakers — fetch_source
//
// Scrapes Amazon Movers & Shakers pages for trending products in a
// fixed list of consumer/lifestyle departments. Two pages per dept
// (top 100 movers each). Heavy regex parsing — brittle by design,
// will break periodically when Amazon changes their HTML.
//
// Port of trends-sql/pipedream/ingestion/ingest_amazon_movers.mjs.
//
// SIGNAL_ID intentionally uses ASIN only (no date) so daily re-runs
// MERGE/UPDATE the same row instead of accumulating duplicates —
// the legacy comment explains a 7-day query was returning 7 copies
// per product before this change.

const DEPARTMENTS = {
  beauty: "https://www.amazon.com/gp/movers-and-shakers/beauty",
  "health-personal-care": "https://www.amazon.com/gp/movers-and-shakers/hpc",
  "sports-outdoors": "https://www.amazon.com/gp/movers-and-shakers/sporting-goods",
  grocery: "https://www.amazon.com/gp/movers-and-shakers/grocery",
  "home-kitchen": "https://www.amazon.com/gp/movers-and-shakers/home-garden",
  "kitchen-dining": "https://www.amazon.com/gp/movers-and-shakers/kitchen",
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function htmlUnescape(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function parseMoversPage(html, department) {
  const signals = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const blockRegex = /<div data-asin="([A-Z0-9]{10})"[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gs;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const asin = blockMatch[1];
    const block = blockMatch[2];

    const titleMatch = block.match(/line-clamp[^"]*"[^>]*>(.*?)<\/div>/s);
    const title = titleMatch ? htmlUnescape(titleMatch[1].trim()) : "";

    const rankMatch = block.match(/Sales rank:\s*([^<]+)/);
    const rankInfo = rankMatch ? rankMatch[1].trim() : null;

    const priceMatch = block.match(/p13n-sc-price[^"]*"[^>]*>\$?([\d.]+)/);
    const price = priceMatch ? priceMatch[1] : null;

    const meta = {
      asin,
      department,
      url: `https://www.amazon.com/dp/${asin}`,
    };
    if (rankInfo) meta.rank_info = rankInfo;
    if (price) meta.price = price;

    if (!title || !title.trim()) continue;

    signals.push({
      // SIGNAL_ID is the canonical Amazon product URL — cross-source dedup
      // key shared by gdelt/bluesky/wikimedia (slice-4 swap).
      SIGNAL_ID: `https://www.amazon.com/dp/${asin}`,
      SOURCE_NAME: "amazon_movers",
      SIGNAL_TIMESTAMP: now,
      SIGNAL_TITLE: title,
      SIGNAL_TEXT: `${title} — trending in Amazon ${department.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} (Movers & Shakers)`,
      METADATA: JSON.stringify(meta),
    });
  }

  return signals;
}

export default defineComponent({
  async run({ $ }) {
    const allSignals = [];
    const errors = [];
    const seenAsins = new Set();

    for (const [dept, baseUrl] of Object.entries(DEPARTMENTS)) {
      try {
        const deptSignals = [];

        for (const page of [1, 2]) {
          const url = page > 1 ? `${baseUrl}?pg=${page}` : baseUrl;
          const resp = await fetch(url, { headers: HEADERS });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const html = await resp.text();
          deptSignals.push(...parseMoversPage(html, dept));
          if (page < 2) await sleep(1000);
        }

        if (deptSignals.length === 0) {
          console.warn(`WARNING: ${dept} returned 0 products — parser may be broken or page structure changed`);
        }

        let count = 0;
        for (const s of deptSignals) {
          const asin = JSON.parse(s.METADATA).asin;
          if (seenAsins.has(asin)) continue;
          seenAsins.add(asin);
          allSignals.push(s);
          count++;
        }
        console.log(`${dept}: ${count} products`);
      } catch (e) {
        const msg = `${dept}: ${e.message}`;
        console.log(msg);
        errors.push(msg);
      }
      await sleep(3000);
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length}/${Object.keys(DEPARTMENTS).length} departments failed`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${allSignals.length} Amazon signals`);
    $.export("$summary", `${allSignals.length} Amazon signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
