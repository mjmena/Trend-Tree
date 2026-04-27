// Ingest Bluesky — fetch_source
//
// Searches Bluesky for consumer/lifestyle trend posts via the
// authenticated ATProto searchPosts XRPC endpoint, using a fixed seed
// list of search terms. Auth is the standard ATProto createSession
// flow with handle + app password (NOT user password).
//
// Credentials come from a connected Pipedream Bluesky app — connect
// via the Pipedream UI on this workflow's `bluesky` prop. The app
// exposes $auth.identifier (handle) and $auth.password (app password).
//
// Port of trends-sql/pipedream/ingestion/ingest_bluesky.mjs.

import crypto from "crypto";

const SEARCH_TERMS = [
  "wellness trends",
  "beauty trends",
  "consumer lifestyle",
  "diet trends",
  "fitness trends",
];

const PDS_HOST = "https://bsky.social";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default defineComponent({
  props: {
    bluesky: { type: "app", app: "bluesky" },
    min_engagement: {
      type: "integer",
      label: "Minimum engagement (like_count + repost_count)",
      description: "Post-fetch safety net. Bluesky's sort=top ranker already filters by engagement, so this is mostly belt-and-suspenders. 0 = trust the ranker, 1+ = drop everything below that floor.",
      default: 0,
    },
    since_hours: {
      type: "integer",
      label: "Search window in hours",
      description: "Only consider posts created within this many hours. Bluesky's sort=top can otherwise return posts from weeks ago if those have the most engagement on the query term.",
      default: 24,
    },
  },
  async run({ $ }) {
    const auth = this.bluesky?.$auth || {};
    const handle = auth.identifier || auth.handle;
    const appPassword = auth.password || auth.app_password;
    if (!handle || !appPassword) {
      throw new Error(
        "Bluesky app must be connected with identifier (handle) + password (app password)",
      );
    }
    const minEngagement = this.min_engagement ?? 0;
    const sinceHours = this.since_hours ?? 24;
    const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

    // Authenticate via ATProto createSession
    let accessJwt;
    try {
      const authResp = await fetch(`${PDS_HOST}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password: appPassword }),
      });
      if (!authResp.ok) {
        throw new Error(`HTTP ${authResp.status}: ${await authResp.text()}`);
      }
      const session = await authResp.json();
      accessJwt = session.accessJwt;
    } catch (e) {
      throw new Error(`Bluesky auth failed: ${e.message}`);
    }

    const allSignals = [];
    const errors = [];

    for (const term of SEARCH_TERMS) {
      // sort=top — Bluesky's server ranks by engagement for the query term.
      // since=<isoTs> — restrict to recent posts so we don't surface
      // months-old top posts. Together these give "top stories on this
      // topic in the last N hours" semantics, which is closer to what
      // we actually want from a trend-signal source.
      const url = `${PDS_HOST}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(term)}&limit=25&sort=top&since=${encodeURIComponent(sinceIso)}`;
      let data;
      try {
        let resp = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}` } });
        if (resp.status === 403 || resp.status === 429) {
          console.log(`'${term}': HTTP ${resp.status}, retrying in 5s...`);
          await sleep(5000);
          resp = await fetch(url, { headers: { Authorization: `Bearer ${accessJwt}` } });
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
      } catch (e) {
        errors.push(`'${term}': ${e.message}`);
        await sleep(2000);
        continue;
      }

      let count = 0;
      for (const postView of data.posts || []) {
        const record = postView.record || {};
        const author = postView.author || {};
        const uri = postView.uri || "";

        const uriHash = crypto.createHash("sha256").update(uri).digest("hex").slice(0, 16);
        const text = record.text || "";

        // Filter out short posts and pure replies
        if (text.length < 30 || text.startsWith("@")) continue;

        // Engagement filter: drop posts below the configured min.
        const likeCount = postView.likeCount || 0;
        const repostCount = postView.repostCount || 0;
        if ((likeCount + repostCount) < minEngagement) continue;

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

        let signalText = text;
        if (embedTitle || embedDescription) {
          const parts = [text];
          if (embedTitle) parts.push(`[Link: ${embedTitle}]`);
          if (embedDescription) parts.push(embedDescription);
          signalText = parts.join("\n\n");
        }

        // Convert at:// uri (at://did:plc:xxx/app.bsky.feed.post/yyy)
        // to public web URL — slice-4 cross-source dedup key.
        const uriParts = (uri || "").replace(/^at:\/\//, "").split("/");
        const bskyWebUrl = uriParts.length >= 3 && uriParts[1] === "app.bsky.feed.post"
          ? `https://bsky.app/profile/${uriParts[0]}/post/${uriParts[2]}`
          : `bsky_${uriHash}`; // fallback for malformed uris (~1% of rows)
        allSignals.push({
          SIGNAL_ID: bskyWebUrl,
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
            search_term: term,
          }),
        });
        count++;
      }

      console.log(`'${term}': ${count} posts`);
      await sleep(1000);
    }

    if (errors.length) {
      console.log(`\nErrors: ${errors.length}/${SEARCH_TERMS.length} queries failed`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${allSignals.length} Bluesky signals`);
    $.export("$summary", `${allSignals.length} Bluesky signals`);

    return {
      signals: allSignals,
      signals_json: JSON.stringify(allSignals),
      count: allSignals.length,
      errors,
    };
  },
});
