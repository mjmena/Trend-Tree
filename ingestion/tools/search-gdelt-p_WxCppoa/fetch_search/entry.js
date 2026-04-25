// Search GDELT (agent tool) — fetch_search
//
// Single-query call to GDELT DOC API v2. Lifts the rate-limit handling
// + excluded-domain filter from ingestion/gdelt-p_ezCwalz/fetch_source/entry.js.

import crypto from "crypto";

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

const EXCLUDED_DOMAINS = [
  "wnd.com", "breitbart.com", "foxnews.com", "cnn.com", "msnbc.com",
  "dailymail.co.uk", "tmz.com", "dailypolitical.com", "tickerreport.com",
  "aol.com", "finance.yahoo.com", "marketwatch.com", "benzinga.com",
  "seekingalpha.com", "investorplace.com",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchArticles(topic, windowDays, mode) {
  const fullQuery = `${topic} sourcecountry:US sourcelang:english`;
  const params = new URLSearchParams({
    query: fullQuery,
    mode,
    format: "json",
    maxrecords: "150",
    timespan: `${windowDays}d`,
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
  props: {
    topic: { type: "string" },
    window_days: { type: "string" },
    mode: { type: "string" },
  },
  async run({ $ }) {
    const windowDays = Number(this.window_days) || 7;
    const mode = this.mode || "ArtList";

    let data;
    try {
      data = await fetchArticles(this.topic, windowDays, mode);
    } catch (e) {
      if (e.message.includes("rate limit") || e.message.includes("429")) {
        console.log(`rate limited, waiting 10s and retrying once`);
        await sleep(10000);
        try {
          data = await fetchArticles(this.topic, windowDays, mode);
        } catch (e2) {
          console.log(`fetch_search error: ${e2.message}`);
          return { signals: [], signals_json: "[]", articles: [], count: 0, error: e2.message };
        }
      } else {
        console.log(`fetch_search error: ${e.message}`);
        return { signals: [], signals_json: "[]", articles: [], count: 0, error: e.message };
      }
    }

    const signals = [];
    const articles = [];
    const seenUrls = new Set();

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
      const signalId = `gdelt_${urlHash.slice(0, 32)}`;

      signals.push({
        SIGNAL_ID: signalId,
        SOURCE_NAME: "gdelt",
        SIGNAL_TIMESTAMP: ts,
        SIGNAL_TITLE: title,
        SIGNAL_TEXT: `Source: ${domain} | ${title}`,
        METADATA: JSON.stringify({
          url, domain,
          language: article.language || "",
          image_url: article.socialimage || "",
          search_topic: this.topic,
        }),
      });

      articles.push({
        signal_id: signalId,
        title,
        domain,
        url,
        published_at: ts,
        language: article.language || "english",
        image_url: article.socialimage || null,
      });
    }

    console.log(`fetched ${articles.length} GDELT articles for topic='${this.topic.slice(0, 80)}'`);
    $.export("$summary", `${articles.length} articles for "${this.topic.slice(0, 60)}"`);

    return {
      signals,
      signals_json: JSON.stringify(signals),
      articles,
      count: articles.length,
      topic: this.topic,
    };
  },
});
