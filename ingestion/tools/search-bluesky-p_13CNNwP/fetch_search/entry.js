// Search Bluesky (agent tool) — fetch_search
//
// Authenticated single-query call to ATProto searchPosts, using the same
// post-shaping logic as the batch ingester at
// ingestion/bluesky-p_V9CgV17/fetch_source/entry.js. Differences:
//   - Single query instead of fixed seed-term loop.
//   - Auth via Pipedream's `bluesky` app prop (not env vars).
//   - Returns signals_json string for the upsert MERGE step.

import crypto from "crypto";

const PDS_HOST = "https://bsky.social";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default defineComponent({
  props: {
    bluesky: { type: "app", app: "bluesky" },
    query: { type: "string" },
    limit: { type: "string" },
    sort:  { type: "string" },
  },
  async run({ $ }) {
    const auth = this.bluesky?.$auth || {};
    const handle = auth.identifier || auth.handle || auth.username;
    const appPassword = auth.app_password || auth.password || auth.api_key;
    if (!handle || !appPassword) {
      throw new Error(
        "bluesky app missing handle/app_password — connect the Bluesky account in this workflow's UI",
      );
    }

    // Authenticate
    let accessJwt;
    {
      const authResp = await fetch(`${PDS_HOST}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password: appPassword }),
      });
      if (!authResp.ok) {
        throw new Error(`Bluesky auth HTTP ${authResp.status}: ${(await authResp.text()).slice(0, 200)}`);
      }
      accessJwt = (await authResp.json()).accessJwt;
    }

    const limit = Math.min(Math.max(1, Number(this.limit) || 25), 100);
    const sort = this.sort || "latest";
    const url = `${PDS_HOST}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(this.query)}&limit=${limit}&sort=${sort}`;

    let data;
    try {
      let resp = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}` } });
      if (resp.status === 403 || resp.status === 429) {
        console.log(`HTTP ${resp.status} on search, retrying in 5s`);
        await sleep(5000);
        resp = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}` } });
      }
      if (!resp.ok) {
        throw new Error(`Bluesky search HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      }
      data = await resp.json();
    } catch (e) {
      // Tool errors surface as JSON to the agent, not workflow failure
      console.log(`fetch_search error: ${e.message}`);
      return {
        signals: [],
        signals_json: "[]",
        posts: [],
        count: 0,
        error: e.message,
      };
    }

    const signals = [];
    const posts = [];
    for (const postView of data.posts || []) {
      const record = postView.record || {};
      const author = postView.author || {};
      const uri = postView.uri || "";
      const uriHash = crypto.createHash("sha256").update(uri).digest("hex").slice(0, 16);
      const text = record.text || "";

      // Same filters as the batch ingester: skip very short posts and pure replies.
      if (text.length < 30 || text.startsWith("@")) continue;

      const createdAt = record.createdAt || "";
      const ts = createdAt ? createdAt.replace("T", " ").replace("Z", "").slice(0, 19) : "";

      let embeddedUrl = "";
      let embedTitle = "";
      let embedDescription = "";
      const embed = postView.embed || {};
      if (embed.$type === "app.bsky.embed.external#view") {
        embeddedUrl = embed.external?.uri || "";
        embedTitle = embed.external?.title || "";
        embedDescription = embed.external?.description || "";
      }

      const firstSentence = text.split(/\. |\n/)[0].trim().slice(0, 200);
      const signalTitle = embedTitle && text.length < 100 ? embedTitle : firstSentence;
      const signalText =
        embedTitle || embedDescription
          ? [text, embedTitle && `[Link: ${embedTitle}]`, embedDescription].filter(Boolean).join("\n\n")
          : text;

      const signalId = `bsky_${uriHash}`;
      signals.push({
        SIGNAL_ID: signalId,
        SOURCE_NAME: "bluesky",
        SIGNAL_TIMESTAMP: ts,
        SIGNAL_TITLE: signalTitle,
        SIGNAL_TEXT: signalText.slice(0, 2000),
        METADATA: JSON.stringify({
          author_handle: author.handle || "",
          like_count: postView.likeCount || 0,
          repost_count: postView.repostCount || 0,
          uri,
          embedded_url: embeddedUrl,
          embed_title: embedTitle,
          embed_description: embedDescription,
          search_query: this.query,
        }),
      });

      // Agent-facing payload (concise; the LLM doesn't need the full Snowflake row shape)
      posts.push({
        signal_id: signalId,
        author_handle: author.handle || "",
        text: signalText.slice(0, 600),
        like_count: postView.likeCount || 0,
        repost_count: postView.repostCount || 0,
        created_at: ts,
        embedded_url: embeddedUrl || null,
      });
    }

    console.log(`fetched ${posts.length} bluesky posts for q='${this.query.slice(0, 80)}'`);
    $.export("$summary", `${posts.length} posts for "${this.query.slice(0, 60)}"`);

    return {
      signals,
      signals_json: JSON.stringify(signals),
      posts,
      count: posts.length,
      query: this.query,
    };
  },
});
