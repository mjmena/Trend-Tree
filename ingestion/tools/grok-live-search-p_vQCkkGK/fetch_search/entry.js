// Grok Live Search (agent tool) — fetch_search
//
// Calls Grok 4 via xAI's Agent Tools API (the new /v1/responses endpoint
// with native web_search + x_search tools). Replaces the deprecated
// search_parameters shape that returned HTTP 410 as of 2026-04-25.
// See: https://docs.x.ai/docs/guides/tools/overview
//
// Auth is the existing x_ai Pipedream app prop (apn_WYhE6e6 — same one
// llm-enrichment uses).

const MODEL = "grok-4-latest";
const REQUEST_TIMEOUT_MS = 60_000;

function buildTools(mode) {
  if (mode === "web") return [{ type: "web_search" }];
  if (mode === "x") return [{ type: "x_search" }];
  return [{ type: "web_search" }, { type: "x_search" }];
}

// Walk an arbitrary nested response shape looking for the assistant's
// summary text. xAI's /v1/responses returns an `output` array; each item
// has `content` blocks with `type: "output_text"` (or similar) and a
// `text` field. Be defensive — the shape may evolve.
function extractSummary(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const out = Array.isArray(data?.output) ? data.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text.length > 0) return block.text;
      if (typeof block?.output_text === "string") return block.output_text;
    }
    if (typeof item?.text === "string") return item.text;
  }
  // Fallbacks for OpenAI-compat shapes
  return data?.choices?.[0]?.message?.content || "";
}

function extractCitations(data) {
  // Prefer top-level citations
  if (Array.isArray(data?.citations)) return data.citations;
  // Some response variants surface citations per output item
  const out = Array.isArray(data?.output) ? data.output : [];
  const collected = [];
  for (const item of out) {
    if (Array.isArray(item?.citations)) collected.push(...item.citations);
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (Array.isArray(block?.citations)) collected.push(...block.citations);
      if (Array.isArray(block?.annotations)) {
        // OpenAI-style annotations with URL citations
        for (const a of block.annotations) {
          if (a?.url || a?.url_citation?.url) {
            collected.push({ url: a.url || a.url_citation.url, title: a.title || a.url_citation?.title });
          }
        }
      }
    }
  }
  return collected;
}

export default defineComponent({
  props: {
    x_ai: { type: "app", app: "x_ai" },
    query: { type: "string" },
    mode: { type: "string" },
  },
  async run({ $ }) {
    const apiKey = this.x_ai?.$auth?.api_key;
    if (!apiKey) {
      throw new Error("x_ai app prop missing $auth.api_key — connect xAI in this workflow's UI");
    }

    const body = {
      model: MODEL,
      input: [
        {
          role: "system",
          content:
            "You are a live web research assistant. Given a query, search the web (and X if asked), summarize what is currently being said about it in 2-3 sentences, then list the most relevant 3-8 citations. Cite sources by URL. Stick to factual/observational language.",
        },
        { role: "user", content: this.query },
      ],
      tools: buildTools(this.mode || "both"),
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      resp = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      throw new Error(`grok-live-search fetch failed: ${e.message}`);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`grok-live-search HTTP ${resp.status}: ${text.slice(0, 240)}`);
    }

    const data = await resp.json();
    const summary = extractSummary(data);
    const rawCitations = extractCitations(data);
    const usage = data?.usage || {};

    const citations = rawCitations
      .map((c) => (typeof c === "string" ? { url: c } : c))
      .filter((c) => c && (c.url || c.title));

    // Shape citations as STG_EXTERNAL_SIGNALS rows so the upsert_signals
    // step can MERGE them in. Each citation gets the full Grok summary
    // as SIGNAL_TEXT (no per-citation snippets are available from the API
    // — the summary is the closest contextual frame). SIGNAL_ID = URL
    // matches the Phase 2 URL-as-ID convention so the dashboard can
    // join SOCIAL_PROOF entries back to STG_EXTERNAL_SIGNALS via URL.
    const nowIso = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
    const signals = [];
    for (const c of citations) {
      const url = c.url ? String(c.url).trim() : "";
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const title = (c.title || "").trim() || deriveTitleFromUrl(url);
      signals.push({
        SIGNAL_ID: url,
        SOURCE_NAME: "grok_live",
        SIGNAL_TIMESTAMP: nowIso,
        SIGNAL_TITLE: title.slice(0, 500),
        SIGNAL_TEXT: (summary || "").slice(0, 2000) || title,
        METADATA: JSON.stringify({
          search_query: this.query,
          mode: this.mode || "both",
          model: MODEL,
          citation_title: title,
        }),
      });
    }

    console.log(`grok-live-search: ${summary.length}-char summary, ${citations.length} citations (${signals.length} persistable), ${usage.output_tokens || usage.completion_tokens || 0}out tok`);
    $.export("$summary", `${citations.length} citations for "${this.query.slice(0, 60)}"`);

    return {
      query: this.query,
      summary,
      citations,
      signals,
      signals_json: JSON.stringify(signals),
      tokens: {
        input: usage.input_tokens || usage.prompt_tokens || 0,
        output: usage.output_tokens || usage.completion_tokens || 0,
      },
      model: MODEL,
    };
  },
});

function deriveTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(path).replace(/[-_]/g, " ").slice(0, 100);
  } catch {
    return url.slice(0, 100);
  }
}
