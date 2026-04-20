// Gemini Prompt Tester — fetch_source
//
// Accepts a prompt via HTTP POST body, calls Gemini 3 with Google Search
// grounding (no JSON mode — it breaks grounding), parses JSON from text,
// resolves grounding redirect URLs, and returns result via $.respond().
//
// POST body:
// {
//   "prompt": "Your prompt text here...",
//   "model": "gemini-3-flash-preview",   // optional
//   "temperature": 0.3                    // optional
// }

const DEFAULT_MODEL = "gemini-3-flash-preview";

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
            generationConfig: { temperature },
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

    // Resolve grounding redirect URLs in parallel
    const groundingChunks = await Promise.all(
      rawChunks.map(async (c) => {
        const rawUrl = c.web?.uri || "";
        const resolved = rawUrl.includes("grounding-api-redirect")
          ? await resolveUrl(rawUrl)
          : rawUrl;
        return { raw_url: rawUrl, resolved_url: resolved, title: c.web?.title };
      }),
    );

    // Parse JSON array from text response
    let parsed = null;
    let parseError = null;
    try {
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parseError = "No JSON array found in response";
      }
    } catch (e) {
      parseError = e.message;
    }

    // Resolve grounding redirect URLs in parsed trends
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
