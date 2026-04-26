// Ingest Reddit — fetch_source
//
// Fetches hot posts from a fixed list of consumer/lifestyle subreddits
// via Reddit's OAuth2 API (application-only "client_credentials" flow,
// not user-context — only public listings).
//
// Reddit OAuth credentials come from project env vars:
//   REDDIT_CLIENT_ID
//   REDDIT_CLIENT_SECRET
// (Set these in the Pipedream UI under the workflow's env vars.)
//
// Port of trends-sql/pipedream/ingestion/ingest_reddit.mjs.

const SUBREDDITS = [
  "SkincareAddiction",
  "fitness",
  "Supplements",
  "EatCheapAndHealthy",
  "BuyItForLife",
  "femalefashionadvice",
  "Cooking",
  "ZeroWaste",
];

const USER_AGENT = "TrendsPipeline/1.0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default defineComponent({
  async run({ $ }) {
    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars required",
      );
    }

    // Get OAuth2 bearer token (application-only)
    let token;
    try {
      const authResp = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: "grant_type=client_credentials",
      });
      if (!authResp.ok) {
        throw new Error(`HTTP ${authResp.status}: ${await authResp.text()}`);
      }
      const authData = await authResp.json();
      token = authData.access_token;
    } catch (e) {
      throw new Error(`Reddit OAuth failed: ${e.message}`);
    }

    const allSignals = [];
    const errors = [];

    for (const subreddit of SUBREDDITS) {
      let data;
      try {
        const url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=25&raw_json=1`;
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": USER_AGENT,
          },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
      } catch (e) {
        const msg = `r/${subreddit}: ${e.message}`;
        console.log(msg);
        errors.push(msg);
        await sleep(1000);
        continue;
      }

      let count = 0;
      for (const child of data?.data?.children || []) {
        const post = child.data || {};
        if (post.stickied) continue;

        const postId = post.id || "";
        const created = new Date((post.created_utc || 0) * 1000);
        const ts = created.toISOString().replace("T", " ").slice(0, 19);

        // SIGNAL_ID is the canonical Reddit post URL — slice-4 cross-source
        // dedup key. Falls back to the post.url (which Reddit may set to the
        // linked-content URL for link posts) if permalink is missing.
        const redditUrl = post.permalink
          ? `https://www.reddit.com${post.permalink}`
          : (post.url || `https://www.reddit.com/comments/${postId}/`);
        allSignals.push({
          SIGNAL_ID: redditUrl,
          SOURCE_NAME: "reddit",
          SIGNAL_TIMESTAMP: ts,
          SIGNAL_TITLE: post.title || "",
          SIGNAL_TEXT: (post.selftext || post.title || "").slice(0, 2000),
          METADATA: JSON.stringify({
            subreddit,
            score: post.score || 0,
            num_comments: post.num_comments || 0,
            url: `https://reddit.com${post.permalink || ""}`,
            post_url: post.url || "",
          }),
        });
        count++;
      }

      console.log(`r/${subreddit}: ${count} posts`);
      await sleep(1000);
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length}/${SUBREDDITS.length} subreddits failed`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${allSignals.length} Reddit signals`);
    $.export("$summary", `${allSignals.length} Reddit signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
