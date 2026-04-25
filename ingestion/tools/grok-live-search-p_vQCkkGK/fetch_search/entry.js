// Grok Live Search (agent tool) — fetch_search
//
// Calls Grok 3 with native live web/X search via xAI's `search_parameters`
// shape. Returns a digested response + citation list. Auth is the existing
// x_ai Pipedream app prop (apn_WYhE6e6 — same one llm-enrichment uses).

const MODEL = "grok-3-latest";
const REQUEST_TIMEOUT_MS = 45_000;

function buildSources(mode) {
  if (mode === "web") return [{ type: "web" }];
  if (mode === "x") return [{ type: "x" }];
  return [{ type: "web" }, { type: "x" }];
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
      return { error: "x_ai auth missing (connect the x_ai app in this workflow)" };
    }

    const body = {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a live web research assistant. Given a query, search the web (and X if asked), summarize what is currently being said about it in 2-3 sentences, then list the most relevant 3-8 citations. Cite sources by URL. Stick to factual/observational language.",
        },
        { role: "user", content: this.query },
      ],
      search_parameters: {
        mode: "on",
        return_citations: true,
        max_search_results: 10,
        sources: buildSources(this.mode || "both"),
      },
      temperature: 0.2,
      max_tokens: 1500,
    };

    let resp;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      resp = await fetch("https://api.x.ai/v1/chat/completions", {
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
      console.log(`grok-live-search fetch error: ${e.message}`);
      return { error: e.message };
    }

    if (!resp.ok) {
      const text = await resp.text();
      console.log(`grok-live-search HTTP ${resp.status}: ${text.slice(0, 240)}`);
      return { error: `HTTP ${resp.status}: ${text.slice(0, 240)}` };
    }

    const data = await resp.json();
    const summary = data?.choices?.[0]?.message?.content || "";
    const citations = data?.citations || data?.choices?.[0]?.message?.citations || [];
    const usage = data?.usage || {};

    console.log(`grok-live-search: ${summary.length}-char summary, ${citations.length} citations, ${usage.completion_tokens || 0}out tok`);
    $.export("$summary", `${citations.length} citations for "${this.query.slice(0, 60)}"`);

    return {
      query: this.query,
      summary,
      citations: Array.isArray(citations)
        ? citations.map((c) => (typeof c === "string" ? { url: c } : c))
        : [],
      tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
      model: MODEL,
    };
  },
});
