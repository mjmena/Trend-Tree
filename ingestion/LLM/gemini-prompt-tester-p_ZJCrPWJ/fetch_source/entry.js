// Gemini Prompt Tester — fetch_source
//
// Accepts a prompt + config via HTTP POST body, calls Gemini with
// Google Search grounding, and returns the full result via $.respond().
//
// POST body:
// {
//   "prompt": "Your prompt text here...",
//   "model": "gemini-3-flash-preview",   // optional
//   "temperature": 0.4                    // optional
// }

const DEFAULT_MODEL = "gemini-3-flash-preview";

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
    const temperature = body.temperature ?? 0.4;

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
    const groundingChunks = (groundingMeta.groundingChunks || []).map((c) => ({
      url: c.web?.uri,
      title: c.web?.title,
    }));
    const searchQueries = groundingMeta.webSearchQueries || [];
    const usage = data.usageMetadata || {};

    // Try to parse JSON from the response
    let parsed = null;
    let parseError = null;
    try {
      const cleaned = textContent
        .replace(/^```json\s*/, "")
        .replace(/^```\s*/, "")
        .replace(/\s*```$/, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parseError = e.message;
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
