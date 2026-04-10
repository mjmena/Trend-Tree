// Ingest GDELT — fetch_source
//
// Polls the GDELT DOC API v2 for consumer/lifestyle trend articles
// across a fixed seed list of search terms, then de-duplicates by URL,
// filters out hard-news / political / stock-spam domains, and emits a
// batch of signal rows for the downstream upsert_signals MERGE step.
//
// Port of trends-sql/pipedream/ingestion/ingest_gdelt.mjs. The legacy
// step uses Pipedream's source `$.interface.timer` + `$emit()` pattern;
// here we're a custom step inside a workflow whose Timer trigger lives
// in the Pipedream UI, so we just return the batch.

import crypto from "crypto";

const SEARCH_TERMS = [
  "wellness trends",
  "beauty trends",
  "consumer lifestyle",
  "diet trends",
  "fitness trends",
];

const EXCLUDED_DOMAINS = [
  "wnd.com", "breitbart.com", "foxnews.com", "cnn.com", "msnbc.com",
  "dailymail.co.uk", "tmz.com", "dailypolitical.com", "tickerreport.com",
  "aol.com", "finance.yahoo.com", "marketwatch.com", "benzinga.com",
  "seekingalpha.com", "investorplace.com",
];

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchArticles(term, maxRecords = 75) {
  const fullQuery = `${term} sourcecountry:US sourcelang:english`;
  const params = new URLSearchParams({
    query: fullQuery,
    mode: "ArtList",
    format: "json",
    maxrecords: String(maxRecords),
    timespan: "1d",
  });
  const resp = await fetch(`${GDELT_DOC_URL}?${params}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    throw new Error(`GDELT rate limit: ${text.slice(0, 100)}`);
  }
  return JSON.parse(text);
}

export default defineComponent({
  async run({ $ }) {
    const allSignals = [];
    const errors = [];
    const seenUrls = new Set();

    for (const term of SEARCH_TERMS) {
      let data;
      try {
        data = await fetchArticles(term);
      } catch (e) {
        if (e.message.includes("rate limit") || e.message.includes("429")) {
          console.log(`'${term}': rate limited, waiting 10s...`);
          await sleep(10000);
          try {
            data = await fetchArticles(term);
          } catch (e2) {
            errors.push(`'${term}': ${e2.message}`);
            await sleep(6000);
            continue;
          }
        } else {
          errors.push(`'${term}': ${e.message}`);
          await sleep(6000);
          continue;
        }
      }

      let count = 0;
      for (const article of data?.articles || []) {
        const url = article.url || "";
        if (!url || seenUrls.has(url)) continue;

        const articleDomain = (article.domain || "").toLowerCase();
        if (EXCLUDED_DOMAINS.some((d) => articleDomain === d || articleDomain.endsWith(`.${d}`))) continue;

        const lang = (article.language || "").toLowerCase();
        if (lang && lang !== "english") continue;

        seenUrls.add(url);

        const seenDate = article.seendate || "";
        let ts = seenDate;
        if (seenDate && seenDate.length >= 15) {
          ts = `${seenDate.slice(0, 4)}-${seenDate.slice(4, 6)}-${seenDate.slice(6, 8)} ${seenDate.slice(9, 11)}:${seenDate.slice(11, 13)}:${seenDate.slice(13, 15)}`;
        }

        const title = article.title || "";
        const domain = article.domain || "";
        const urlHash = crypto.createHash("md5").update(url).digest("hex");

        allSignals.push({
          SIGNAL_ID: `gdelt_${urlHash.slice(0, 32)}`,
          SOURCE_NAME: "gdelt",
          SIGNAL_TIMESTAMP: ts,
          SIGNAL_TITLE: title,
          SIGNAL_TEXT: `Source: ${domain} | ${title}`,
          METADATA: JSON.stringify({
            url,
            domain,
            language: article.language || "",
            image_url: article.socialimage || "",
          }),
        });
        count++;
      }

      console.log(`'${term}': ${count} articles`);
      await sleep(6000);
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length}/${SEARCH_TERMS.length} queries failed`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${allSignals.length} GDELT signals`);
    $.export("$summary", `${allSignals.length} GDELT signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
