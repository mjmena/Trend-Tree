// Grok Live Search (agent tool) — fetch_search
//
// The X/social grounding avenue. Calls Grok 4 via xAI's Agent Tools API
// (/v1/responses) with x_search ONLY, and asks Grok to AUTHOR its citations
// as a JSON object: a digest summary + 3-8 real X posts, each with the
// canonical x.com/<handle>/status URL and a one-sentence context of what that
// post says. We parse Grok's authored JSON (not xAI's native data.citations,
// whose titles are reference indices and whose X URLs are anonymised) and
// persist each cited post as a `grok_live` signal.
//
// Web/news/demand grounding is owned by other tools (GDELT, Google Trends) —
// this tool is X-only. See CONTEXT.md (authored citation / native citation,
// "two Grok searches", "first-class but ungated") and memory
// grok_live_is_x_social_only + xai_grok_api_migration.

const MODEL = "grok-4-latest";
const REQUEST_TIMEOUT_MS = 45_000; // Pipedream kills steps at ~60s; fire AbortController first

const SYSTEM_PROMPT = [
  "You are a live X (Twitter) research assistant. Given a query, search X for what real people and named accounts are posting about it right now.",
  "Return ONLY a JSON object (no prose before or after, no markdown code fences) with this exact shape:",
  '{ "summary": string, "citations": [ { "url": string, "context": string } ] }',
  "- summary: 2-3 sentences digesting what X is currently saying about the query.",
  "- citations: 3-8 of the most relevant real X posts you found.",
  "    - url: the canonical public post URL in the form https://x.com/<handle>/status/<id>. Use the real author handle. Never use the anonymized https://x.com/i/status/<id> form, and never invent a URL you did not actually find.",
  "    - context: one sentence describing what THIS specific post or author says about the query.",
  "Only cite posts you actually found via search. Use factual, observational language.",
].join("\n");

function softFail(query, error) {
  return { query, summary: "", citations: [], signals: [], signals_json: "[]", tokens: { input: 0, output: 0 }, model: MODEL, error };
}

// Concatenate the assistant's message text from xAI's /v1/responses shape.
// The authored JSON object lives in this text. Defensive — the shape can vary.
function extractText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  let text = "";
  const out = Array.isArray(data?.output) ? data.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string") text += block.text;
      else if (typeof block?.output_text === "string") text += block.output_text;
    }
    if (typeof item?.text === "string") text += item.text;
  }
  if (!text) text = data?.choices?.[0]?.message?.content || "";
  return text;
}

// Brace-matching extractor (mirror of discover_grok's extractJsonArray) — pulls
// the first balanced {...} object out of free text, ignoring braces in strings.
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Require an x.com post URL; normalize twitter.com / www. / mobile. → x.com,
// drop query + hash + trailing slash. Returns null for any non-X URL (this is
// the social-only gate). No network.
function canonicalizeXUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^mobile\./, "");
  if (host === "twitter.com") host = "x.com";
  if (host !== "x.com") return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (!path) return null;
  return `https://x.com${path}`;
}

// x.com/<handle>/status/<id> → handle; x.com/i/status/<id> → anonymised.
function extractHandle(canonUrl) {
  try {
    const segs = new URL(canonUrl).pathname.split("/").filter(Boolean);
    if (!segs.length) return { handle: null, anonymised: false };
    if (segs[0].toLowerCase() === "i") return { handle: null, anonymised: true };
    return { handle: segs[0], anonymised: false };
  } catch {
    return { handle: null, anonymised: false };
  }
}

function firstSentence(s, max) {
  const t = (s || "").trim();
  if (!t) return "";
  const m = t.match(/^[\s\S]*?[.!?](\s|$)/);
  return (m ? m[0] : t).trim().slice(0, max);
}

// Fallback title when there's no handle and no usable context.
function deriveTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    const isStub = (s) => /^\d+$/.test(s) || /^(index|story|home|default|status)(\.\w+)?$/i.test(s);
    let seg = segs.pop() || u.hostname;
    if (isStub(seg) && segs.length) seg = segs.pop();
    return decodeURIComponent(seg).replace(/[-_]/g, " ").slice(0, 100);
  } catch {
    return url.slice(0, 100);
  }
}

export default defineComponent({
  props: {
    x_ai: { type: "app", app: "x_ai" },
    query: { type: "string" },
    mode: { type: "string", optional: true }, // vestigial — this tool is X-only
  },
  async run({ $ }) {
    const apiKey = this.x_ai?.$auth?.api_key;
    if (!apiKey) {
      throw new Error("x_ai app prop missing $auth.api_key — connect xAI in this workflow's UI");
    }

    const body = {
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: this.query },
      ],
      tools: [{ type: "x_search" }],
    };

    let resp;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      resp = await fetch("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      console.warn(`grok-live-search: fetch failed (${e.message}) — returning empty results`);
      $.export("$summary", "soft-fail: timeout");
      return softFail(this.query, "timeout");
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`grok-live-search: HTTP ${resp.status} — returning empty results. body: ${text.slice(0, 240)}`);
      $.export("$summary", `soft-fail: HTTP ${resp.status}`);
      return softFail(this.query, `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const usage = data?.usage || {};

    // Parse Grok's AUTHORED JSON object. On any parse failure, soft-fail to a
    // visible zero — do NOT fall back to xAI's native data.citations (that
    // would silently re-inject ungated, anonymised citations under the same
    // SOURCE_NAME, which is exactly what this refactor removes).
    const objText = extractJsonObject(extractText(data));
    let parsed = null;
    if (objText) { try { parsed = JSON.parse(objText); } catch { parsed = null; } }
    const rawCitations = Array.isArray(parsed?.citations) ? parsed.citations : null;
    if (!parsed || !rawCitations || rawCitations.length === 0) {
      console.warn(`grok-live-search: no authored JSON citations in response — soft-fail. text head: ${extractText(data).slice(0, 200)}`);
      $.export("$summary", "soft-fail: parse");
      return softFail(this.query, "parse");
    }

    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const nowIso = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

    const seen = new Set();
    const signals = [];
    const citations = [];
    let droppedNonX = 0;
    for (const c of rawCitations) {
      const canon = canonicalizeXUrl(c?.url);
      if (!canon) { droppedNonX++; continue; } // social-only gate
      if (seen.has(canon)) continue;
      seen.add(canon);

      const context = typeof c?.context === "string" ? c.context.trim() : "";
      const { handle, anonymised } = extractHandle(canon);

      let title;
      if (handle) {
        const ctx = firstSentence(context, 120);
        title = ctx ? `@${handle}: ${ctx}` : `@${handle}`;
      } else {
        title = firstSentence(context, 140) || deriveTitleFromUrl(canon);
      }

      citations.push({ url: canon, context, handle, anonymised });
      signals.push({
        SIGNAL_ID: canon,
        SOURCE_NAME: "grok_live",
        SIGNAL_TIMESTAMP: nowIso,
        SIGNAL_TITLE: title.slice(0, 500),
        SIGNAL_TEXT: (context || summary || title).slice(0, 2000),
        METADATA: JSON.stringify({
          search_query: this.query,
          mode: "x",
          model: MODEL,
          authored_context: context || null,
          handle: handle || null,
          anonymised,
        }),
      });
    }

    if (signals.length === 0) {
      console.warn(`grok-live-search: authored ${rawCitations.length} citations but none were valid x.com URLs — soft-fail`);
      $.export("$summary", "soft-fail: no x.com citations");
      return softFail(this.query, "no_x_citations");
    }

    console.log(`grok-live-search: ${summary.length}-char summary, ${signals.length} X posts (${droppedNonX} non-x dropped), ${usage.output_tokens || usage.completion_tokens || 0}out tok`);
    $.export("$summary", `${signals.length} X posts for "${this.query.slice(0, 60)}"`);

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
