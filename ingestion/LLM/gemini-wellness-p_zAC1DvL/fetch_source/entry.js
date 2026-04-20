// Ingest Gemini Wellness — fetch_source
//
// Calls Gemini with Google Search grounding to discover current
// wellness consumer trends. Outputs signals in the standard
// { signals, signals_json, count, errors } shape for the downstream
// upsert_signals MERGE step.

const SOURCE_NAME = "gemini_wellness";
const CATEGORY = "wellness";
const MODEL = "gemini-3-flash-preview";

function buildPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a consumer trends analyst specializing in wellness, health, and personal care.

Today is ${today}. Search the web for the most noteworthy EMERGING wellness and health trends in the United States right now. Focus on trends that have gained traction THIS WEEK or are currently surging in consumer interest.

Look for:
- New fitness movements, workout styles, or exercise trends gaining popularity
- Emerging supplements, vitamins, or functional health products
- Mental health and mindfulness trends consumers are adopting
- Skincare, beauty, and personal care innovations breaking out
- Sleep, recovery, and biohacking trends
- New wellness brands, apps, or services going viral
- Shifts in how consumers approach preventive health or self-care

IMPORTANT RULES:
- Only include trends with RECENT activity (published or updated within the last 7 days)
- Every trend MUST have a real, working source URL where readers can learn more
- Do NOT include evergreen topics (e.g. "exercise is good for you") unless there is a specific new development
- Do NOT invent or fabricate URLs — only include URLs you found via search
- Aim for 10-15 distinct trends

Respond with a JSON array of objects, each with these fields:
[
  {
    "title": "Short trend name (3-8 words)",
    "description": "1-2 sentence summary of what is trending and why it matters to consumers right now",
    "source_url": "The URL where this trend was reported or discussed",
    "source_name": "The publication or website name"
  }
]`;
}

export default defineComponent({
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
  },
  async run({ $ }) {
    const errors = [];
    const prompt = buildPrompt();

    let data;
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${this.google_gemini.$auth.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.4,
            },
          }),
        },
      );

      if (!resp.ok) {
        throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
      }

      data = await resp.json();
    } catch (e) {
      errors.push(`Gemini API call failed: ${e.message}`);
      console.log(`ERROR: ${e.message}`);
      $.export("$summary", `0 ${SOURCE_NAME} signals (API error)`);
      return { signals: [], signals_json: "[]", count: 0, errors };
    }

    const candidate = data.candidates?.[0];
    const textContent = candidate?.content?.parts?.[0]?.text || "";
    const groundingMeta = candidate?.groundingMetadata || {};
    const groundingChunks = (groundingMeta.groundingChunks || []).map((c) => ({
      url: c.web?.uri,
      title: c.web?.title,
    }));
    const searchQueries = groundingMeta.webSearchQueries || [];
    const usage = data.usageMetadata || {};

    let trends;
    try {
      const cleaned = textContent
        .replace(/^```json\s*/, "")
        .replace(/^```\s*/, "")
        .replace(/\s*```$/, "")
        .trim();
      trends = JSON.parse(cleaned);
      if (!Array.isArray(trends)) {
        throw new Error("Response is not a JSON array");
      }
    } catch (e) {
      errors.push(`JSON parse failed: ${e.message}`);
      console.log(`ERROR parsing Gemini response: ${e.message}`);
      console.log(`Raw content (first 500 chars): ${textContent.slice(0, 500)}`);
      $.export("$summary", `0 ${SOURCE_NAME} signals (parse error)`);
      return { signals: [], signals_json: "[]", count: 0, errors };
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const ts = `${dateStr} ${now.toISOString().slice(11, 19)}`;
    const seenUrls = new Set();
    const signals = [];

    for (let i = 0; i < trends.length; i++) {
      const trend = trends[i];
      const url = (trend.source_url || "").trim();

      if (!url || !url.startsWith("http")) {
        errors.push(`Trend "${trend.title}": missing or invalid URL, skipped`);
        continue;
      }
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      signals.push({
        SIGNAL_ID: url,
        SOURCE_NAME,
        SIGNAL_TIMESTAMP: ts,
        SIGNAL_TITLE: (trend.title || "").slice(0, 500),
        SIGNAL_TEXT: (trend.description || trend.title || "").slice(0, 2000),
        METADATA: JSON.stringify({
          category: CATEGORY,
          model: MODEL,
          source_name: trend.source_name || null,
          search_queries: searchQueries,
          grounding_sources: groundingChunks,
          prompt_tokens: usage.promptTokenCount || 0,
          completion_tokens: usage.candidatesTokenCount || 0,
          run_date: dateStr,
          signal_index: i,
          total_signals: trends.length,
        }),
      });
    }

    if (errors.length) {
      console.log(`\nWarnings: ${errors.length}`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${signals.length} ${SOURCE_NAME} signals`);
    console.log(`Tokens: ${usage.promptTokenCount || 0} in / ${usage.candidatesTokenCount || 0} out`);
    console.log(`Grounding sources: ${groundingChunks.length}, search queries: ${searchQueries.length}`);
    $.export("$summary", `${signals.length} ${SOURCE_NAME} signals`);

    return {
      signals,
      signals_json: JSON.stringify(signals),
      count: signals.length,
      errors,
    };
  },
});
