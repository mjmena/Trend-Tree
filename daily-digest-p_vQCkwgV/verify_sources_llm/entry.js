// Pipedream Workflow Step: Verify Sources via LLM
//
// Takes the output of check_links and, for each trend, asks Gemini 3 Flash
// (with Google Search grounding) to pick the best N on-topic sources —
// filtering the PageRank candidates for relevance and web-searching for
// replacements if too few candidates are on-topic.
//
// Notes:
//   - Gemini's responseMimeType: "application/json" is INCOMPATIBLE with
//     tool use / grounding, so we ask for text and regex-extract the JSON.
//   - On any error we fall back to the trend's alive_signals as-is, so the
//     email still ships something for that trend.
//   - One API call per trend, capped by per_trend_concurrency, to keep
//     JSON extraction simple and isolate per-trend failures.

// Per Google's model list, the ID for Gemini 3 Flash is "gemini-3-flash-preview".
// Stable fallback: "gemini-2.5-flash" (used by llm-enrichment-p_YyC86Zo/enrich_llm_gemini).
const GEMINI_MODEL = "gemini-3-flash-preview";

const makeSemaphore = (max) => {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
};

const isRealHttpUrl = (raw) => {
  if (typeof raw !== "string") return false;
  const s = raw.trim().toLowerCase();
  return s.startsWith("http://") || s.startsWith("https://");
};

const buildPrompt = (row, target) => {
  const alive = Array.isArray(row.alive_signals) ? row.alive_signals : [];
  const candidatesBlock =
    alive.length > 0
      ? alive
          .map(
            (s, i) =>
              `${i + 1}. [${s.source || "unknown"}] ${s.title || "(untitled)"}\n   ${s.final_url || s.url}`,
          )
          .join("\n")
      : "(no alive candidates — you must find sources via search)";

  return `You are curating sources for a trend-intelligence newsletter. Pick the BEST ${target} URLs that are ALIVE AND RELEVANT to this trend. Use Google Search to find replacements if fewer than ${target} of the supplied URLs are on-topic, or if no candidates were supplied at all.

TREND
  Name (B2C):  ${row.TREND_NAME_B2C ?? "(none)"}
  Name (B2B):  ${row.TREND_NAME_B2B ?? "(none)"}
  Fallback:    ${row.TREND_NAME ?? "(none)"}
  Category:    ${row.CATEGORY ?? "(none)"} / ${row.SUBCATEGORY ?? "-"}
  Summary:     ${row.SUMMARY_SHORT ?? "(none)"}

VERIFIED-ALIVE CANDIDATES (${alive.length}), in PageRank order:
${candidatesBlock}

RULES
- Prefer candidates above when on-topic; fill gaps via Google Search.
- Each URL must unambiguously discuss THIS trend (not just the category).
- Avoid duplicate domains where possible.
- No paywalled aggregator rollups (Google News search results, Yahoo rollups).
- Every URL you return MUST start with http:// or https://.
- Return fewer than ${target} if you can't find enough on-topic sources.

OUTPUT — a single JSON object and nothing else:
{
  "sources": [
    {
      "title": string,
      "url": string,
      "source": string,
      "via": "pagerank" | "llm_websearch",
      "reason": string
    }
  ]
}`;
};

const callGemini = async (apiKey, prompt) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      // NOTE: do NOT set responseMimeType — incompatible with tools/grounding.
    },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
};

const extractJson = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in Gemini response");
  return JSON.parse(match[0]);
};

const verifyOneTrend = async (row, apiKey, target) => {
  const prompt = buildPrompt(row, target);
  const data = await callGemini(apiKey, prompt);

  const parsed = extractJson(data);
  const rawSources = Array.isArray(parsed?.sources) ? parsed.sources : [];

  // Belt-and-braces: drop any LLM-hallucinated pseudo-URLs.
  const clean = rawSources
    .filter((s) => s && typeof s === "object" && isRealHttpUrl(s.url))
    .slice(0, target)
    .map((s) => ({
      title: String(s.title || "").slice(0, 300),
      url: String(s.url).trim(),
      source: String(s.source || "").slice(0, 120),
      via: s.via === "llm_websearch" ? "llm_websearch" : "pagerank",
      reason: String(s.reason || "").slice(0, 300),
    }));

  const usage = data?.usageMetadata || {};
  return {
    sources: clean,
    usage: {
      input: usage.promptTokenCount || 0,
      output: usage.candidatesTokenCount || 0,
      model: GEMINI_MODEL,
    },
  };
};

const pagerankFallback = (row, target) => {
  const alive = Array.isArray(row.alive_signals) ? row.alive_signals : [];
  return alive.slice(0, target).map((s) => ({
    title: s.title || "",
    url: s.final_url || s.url,
    source: s.source || "",
    via: "pagerank",
    reason: "fallback: LLM verify unavailable",
  }));
};

export default defineComponent({
  name: "Verify Sources (Gemini)",
  description:
    "Per-trend source relevance check + web-search replacements via Gemini Flash grounding.",
  version: "0.0.1",
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
    checked: {
      type: "any",
      label: "Output from check_links",
    },
    target_sources_per_trend: {
      type: "integer",
      label: "Target sources per trend",
      default: 3,
      optional: true,
    },
    per_trend_concurrency: {
      type: "integer",
      label: "Max concurrent Gemini calls",
      default: 3,
      optional: true,
    },
  },
  async run({ $ }) {
    const checked = this.checked || {};
    const rows = Array.isArray(checked.rows) ? checked.rows : [];
    const target = this.target_sources_per_trend ?? 3;
    const concurrency = this.per_trend_concurrency ?? 3;
    const apiKey = this.google_gemini?.$auth?.api_key;

    if (!apiKey) {
      console.log("No Gemini API key on google_gemini app; falling back to pagerank for all trends.");
      for (const row of rows) {
        row.final_sources = pagerankFallback(row, target);
        row._llm_error = "no_api_key";
      }
      $.export("$summary", `Verified 0 via LLM / ${rows.length} fallback (no api key)`);
      return {
        rows,
        _token_usage_total: { input: 0, output: 0, model: GEMINI_MODEL, cost_estimate_usd: 0 },
      };
    }

    const sem = makeSemaphore(concurrency);
    let llmOk = 0;
    let llmFallback = 0;
    let totalInput = 0;
    let totalOutput = 0;

    await Promise.all(
      rows.map((row) =>
        sem(async () => {
          try {
            const r = await verifyOneTrend(row, apiKey, target);
            if (r.sources.length === 0) {
              // If LLM returned nothing usable, prefer fallback so the card isn't empty.
              row.final_sources = pagerankFallback(row, target);
              row._llm_error = "llm_returned_no_sources";
              llmFallback++;
            } else {
              row.final_sources = r.sources;
              row._llm_usage = r.usage;
              llmOk++;
            }
            totalInput += r.usage?.input || 0;
            totalOutput += r.usage?.output || 0;
          } catch (e) {
            const msg = e?.message || String(e);
            console.log(`verify_sources_llm: fallback ${row.TREND_ID}: ${msg}`);
            row.final_sources = pagerankFallback(row, target);
            row._llm_error = msg.slice(0, 500);
            llmFallback++;
          }
        }),
      ),
    );

    // Rough Gemini Flash pricing placeholder ($ per 1M tokens).
    // Keep this in sync with llm-enrichment's COST_PER_M table if that exists.
    const INPUT_PER_M = 0.3;
    const OUTPUT_PER_M = 2.5;
    const cost_estimate_usd =
      (totalInput / 1_000_000) * INPUT_PER_M +
      (totalOutput / 1_000_000) * OUTPUT_PER_M;

    $.export(
      "$summary",
      `Verified ${rows.length} trends — ${llmOk} via LLM / ${llmFallback} fallback — $${cost_estimate_usd.toFixed(4)}`,
    );

    return {
      rows,
      _token_usage_total: {
        input: totalInput,
        output: totalOutput,
        model: GEMINI_MODEL,
        cost_estimate_usd,
      },
    };
  },
});
