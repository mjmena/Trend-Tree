// Sources Enrichment — generate_search_terms
//
// First custom step. Calls Claude Haiku to generate 6–8 compound search
// phrases for the trend topic, to be used by downstream source fetchers
// (GDELT, Wikimedia, Google Trends) as query / CONTAINS filters.
//
// Falls back to n-grams + long words extracted from the trend topic if
// the Claude call fails or returns unparseable text. Always returns at
// least one usable term (the raw trend topic) so downstream steps can
// still run.
//
// Port of trends-sql/pipedream/enrichment/enrich_generate_hashtags.mjs,
// wrapped with defineComponent and with `trend_topic` read from the
// upstream query_metrics registry step (not from steps.trigger.event)
// because this workflow's trigger only carries `trend_id` in its body.

export default defineComponent({
  props: {
    anthropic: {
      type: "app",
      app: "anthropic",
    },
    trend_id: {
      type: "string",
      label: "Trend ID",
      description: "Wired from the HTTP trigger body",
    },
    metrics_rows: {
      type: "any",
      label: "FCT_TREND_METRICS rows (from query_metrics)",
    },
  },
  async run({ $ }) {
    const metrics = (this.metrics_rows || [])[0];
    if (!metrics) {
      throw new Error(`Trend not found in FCT_TREND_METRICS: ${this.trend_id}`);
    }
    const trendTopic = metrics.TREND_TOPIC;
    if (!trendTopic) {
      throw new Error(`FCT_TREND_METRICS row for ${this.trend_id} has no TREND_TOPIC`);
    }

    // Baseline supplement: n-grams + long single words from the trend topic.
    // These are safe fallbacks — if Claude fails we still produce something.
    const topicWords = trendTopic
      .split(/\s+/)
      .filter((w) => w.replace(/[^a-zA-Z0-9]/g, "").length >= 3);
    const ngrams = [];
    for (let i = 0; i < topicWords.length; i++) {
      if (i + 1 < topicWords.length) ngrams.push(topicWords.slice(i, i + 2).join(" "));
      if (i + 2 < topicWords.length) ngrams.push(topicWords.slice(i, i + 3).join(" "));
    }
    const longWords = topicWords.filter(
      (w) => w.replace(/[^a-zA-Z0-9]/g, "").length >= 7,
    );

    const dedup = (terms) => {
      const seen = new Set();
      return terms.filter((t) => {
        const key = t.toLowerCase();
        if (t.replace(/^#/, "").length < 5 || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const fallback = () => dedup([trendTopic, ...ngrams, ...longWords]);

    const prompt = `Generate 6-8 specific search terms for finding content about this trend on social media, e-commerce, and news sites.

Trend topic: "${trendTopic}"

Rules:
- Return ONLY a JSON array of strings, nothing else
- Each term must be 5+ characters
- Terms MUST contain spaces between words (e.g. "methylene blue supplement" not "methyleneblue")
- Include the full topic phrase as the first term
- Add product-specific phrases and category terms that appear verbatim in product titles or article headlines
- No generic filler words (e.g. "trend", "popular", "new")
- No hashtag format — plain phrases only, exactly as they would appear in titles

Example for "Methylene Blue Biohacking":
["Methylene Blue Biohacking", "methylene blue supplement", "biohacking supplement", "methylene blue nootropic", "cognitive enhancement supplement", "brain health supplement"]

Respond with only the JSON array.`;

    let terms;
    let tokenUsage = null;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.anthropic.$auth.api_key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.log(`Search term generation failed (${response.status}): ${err}`);
        terms = fallback();
      } else {
        const data = await response.json();
        const text = (data.content?.[0]?.text || "").trim();
        const clean = text
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
          .trim();
        try {
          const parsed = JSON.parse(clean);
          if (!Array.isArray(parsed)) throw new Error("not an array");
          terms = dedup([
            ...parsed.map((t) => String(t).trim()),
            ...ngrams,
            ...longWords,
          ]);
          if (data.usage) {
            tokenUsage = {
              input: data.usage.input_tokens || 0,
              output: data.usage.output_tokens || 0,
              model: "claude-haiku-4-5-20251001",
            };
          }
        } catch {
          console.log(`Failed to parse search-term JSON: ${text}`);
          terms = fallback();
        }
      }
    } catch (e) {
      console.log(`Claude call error: ${e.message}`);
      terms = fallback();
    }

    if (terms.length === 0) terms = [trendTopic];

    console.log(`Generated ${terms.length} search terms for "${trendTopic}": ${terms.join(", ")}`);
    $.export("$summary", `Generated ${terms.length} terms`);

    return {
      trend_topic: trendTopic,
      terms,
      terms_json: JSON.stringify(terms),
      _token_usage: tokenUsage,
    };
  },
});
