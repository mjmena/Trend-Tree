// Ingest Gemini Other — fetch_source
//
// Calls Gemini with Google Search grounding to discover current
// consumer trends outside food/drink, wellness, and travel.
// Outputs signals in the standard { signals, signals_json, count, errors }
// shape for the downstream upsert_signals MERGE step.

const SOURCE_NAME = "gemini_other";
const CATEGORY = "other";
const MODEL = "gemini-3-flash-preview";

function buildPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. Search the web for 10-15 emerging consumer trends in the United States reported THIS WEEK. Do NOT include food/drink, wellness/health/fitness, or travel trends — those are covered separately.

Focus on: fashion, home & living, consumer technology, sustainability, entertainment, parenting, personal finance, pets, DIY/crafts, and other consumer verticals.

Return ONLY a JSON array matching this exact format — no other text:
[{"title": "Short Trend Name", "description": "1-2 sentence summary.", "source_url": "https://example.com/article", "source_name": "Publication Name"}]

Every object MUST have all 4 fields. Do not omit source_url.`;
}

// Resolve grounding redirects and verify the URL is live (2xx or 3xx).
// Returns { url, ok } — ok=false means the URL is dead (404/5xx/timeout).
async function resolveAndVerify(url) {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    return { url: resp.url || url, ok: resp.ok };
  } catch {
    try {
      const resp = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      await resp.text();
      return { url: resp.url || url, ok: resp.ok };
    } catch {
      return { url, ok: false };
    }
  }
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
            generationConfig: { temperature: 0.3 },
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
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");
      trends = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(trends)) throw new Error("Parsed value is not an array");
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

    const candidates = [];
    for (let i = 0; i < trends.length; i++) {
      const trend = trends[i];
      const title = (trend.title || "").trim();
      const description = (trend.description || "").trim();
      const url = (trend.source_url || "").trim();
      const sourceName = (trend.source_name || "").trim();

      if (!title || !description || !url || !sourceName) {
        errors.push(`Trend #${i + 1}: missing required field (title=${!!title}, desc=${!!description}, url=${!!url}, src=${!!sourceName}), skipped`);
        continue;
      }
      if (!url.startsWith("http")) {
        errors.push(`Trend "${title}": invalid URL "${url}", skipped`);
        continue;
      }
      candidates.push({ title, description, url, sourceName, index: i });
    }

    const verified = await Promise.all(
      candidates.map(async (c) => {
        const result = await resolveAndVerify(c.url);
        return { ...c, resolvedUrl: result.url, urlOk: result.ok };
      }),
    );

    const seenUrls = new Set();
    const signals = [];
    let droppedCount = 0;

    for (const v of verified) {
      if (!v.urlOk) {
        errors.push(`Trend "${v.title}": URL returned non-200, dropped (${v.resolvedUrl})`);
        droppedCount++;
        continue;
      }

      if (seenUrls.has(v.resolvedUrl)) continue;
      seenUrls.add(v.resolvedUrl);

      signals.push({
        SIGNAL_ID: v.resolvedUrl,
        SOURCE_NAME,
        SIGNAL_TIMESTAMP: ts,
        SIGNAL_TITLE: v.title.slice(0, 500),
        SIGNAL_TEXT: v.description.slice(0, 2000),
        METADATA: JSON.stringify({
          category: CATEGORY,
          model: MODEL,
          source_name: v.sourceName,
          search_queries: searchQueries,
          grounding_sources: groundingChunks,
          prompt_tokens: usage.promptTokenCount || 0,
          completion_tokens: usage.candidatesTokenCount || 0,
          run_date: dateStr,
          signal_index: v.index,
          total_signals: trends.length,
        }),
      });
    }

    if (errors.length) {
      console.log(`\nWarnings: ${errors.length}`);
      errors.forEach((e) => console.log(`  ${e}`));
    }

    console.log(`Total: ${signals.length} ${SOURCE_NAME} signals (${droppedCount} dropped for bad URLs)`);
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
