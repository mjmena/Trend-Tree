// Gemini Prompt Tester — fetch_source
//
// Accepts a prompt via HTTP POST body, calls Gemini 3 with Google Search
// grounding + responseSchema for structured JSON output, and returns
// the full result via $.respond().
//
// POST body:
// {
//   "prompt": "Your prompt text here...",
//   "model": "gemini-3-flash-preview",   // optional
//   "temperature": 0.3                    // optional
// }

const DEFAULT_MODEL = "gemini-3-flash-preview";

const TREND_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      title: { type: "STRING", description: "Short trend name (3-8 words)" },
      description: { type: "STRING", description: "1-2 sentence summary of what is trending" },
      source_url: { type: "STRING", description: "REQUIRED: the exact URL from search results where this trend was found" },
      source_name: { type: "STRING", description: "Name of the publication or website" },
    },
    required: ["title", "description", "source_url", "source_name"],
  },
};

async function resolveUrl(url) {
  if (!url || !url.includes("grounding-api-redirect")) return url;
  try {
    const resp = await fetch(url, { method: "HEAD", redirect: "follow" });
    return resp.url || url;
  } catch {
    return url;
  }
}

export default defineComponent({
  props: {
    google_gemini: {
      type: "app",
      app: "google_gemini",
    },
  },
  async run({ steps, $ }) {
    const body = steps.trigger.event.body || {};
    const prompt = body.prompt;
    const model = body.model || DEFAULT_MODEL;
    const temperature = body.temperature ?? 0.3;

    if (!prompt) {
      await $.respond({
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing 'prompt' in request body" }),
      });
      return;
    }

    let data;
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.google_gemini.$auth.api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: TREND_SCHEMA,
              temperature,
            },
          }),
        },
      );

      if (!resp.ok) {
        const errText = await resp.text();
        await $.respond({
          status: 502,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: `Gemini HTTP ${resp.status}`, detail: errText }),
        });
        return;
      }

      data = await resp.json();
    } catch (e) {
      await $.respond({
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `Gemini API call failed: ${e.message}` }),
      });
      return;
    }

    // Extract content and grounding metadata
    const candidate = data.candidates?.[0];
    const textContent = candidate?.content?.parts?.[0]?.text || "";
    const groundingMeta = candidate?.groundingMetadata || {};
    const rawChunks = groundingMeta.groundingChunks || [];
    const searchQueries = groundingMeta.webSearchQueries || [];
    const usage = data.usageMetadata || {};

    // Resolve grounding redirect URLs
    const groundingChunks = await Promise.all(
      rawChunks.map(async (c) => {
        const rawUrl = c.web?.uri || "";
        const resolved = rawUrl.includes("grounding-api-redirect")
          ? await resolveUrl(rawUrl)
          : rawUrl;
        return { raw_url: rawUrl, resolved_url: resolved, title: c.web?.title };
      }),
    );

    // Parse JSON — with responseSchema, the text should be valid JSON directly
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(textContent);
    } catch (e) {
      parseError = e.message;
    }

    // Resolve any grounding redirect URLs in the parsed trends
    if (Array.isArray(parsed)) {
      parsed = await Promise.all(
        parsed.map(async (t) => ({
          ...t,
          source_url: await resolveUrl(t.source_url || ""),
        })),
      );
    }

    const result = {
      model,
      temperature,
      usage: {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
      },
      grounding: {
        search_queries: searchQueries,
        sources: groundingChunks,
        source_count: groundingChunks.length,
      },
      parsed_response: parsed,
      parse_error: parseError,
      raw_text: parseError ? textContent.slice(0, 2000) : undefined,
      trend_count: Array.isArray(parsed) ? parsed.length : null,
    };

    $.export("$summary", `Gemini test: ${result.trend_count ?? 0} trends, ${result.grounding.source_count} grounding sources`);

    await $.respond({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result, null, 2),
    });
  },
});
