// tiktok_filter.mjs — the TikTok title filter (CRMA-1337, decided on
// CRMA-1325). One gemini-3.7-flash call screens a batch of result titles
// against the distillation rubric's test: "a noun phrase you can put on a
// slide and a verb a consumer is doing". The ingest keeps only what it keeps.
//
// The prompt text is registry-driven: `ingestion.tiktok.filter` in
// MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT (sql/update_prompts_ingestion_tiktok_filter_v1.sql).
// The model and the call shape are code-pinned, per the fleet convention that
// only discovery lanes take their model from the registry.
//
// temperature 0 is deliberate. The CRMA-726 convention omits `temperature` on
// new lanes, but this filter's grades were validated at temperature 0 on
// gemini-3.7-flash (CRMA-1325), and the ticket pins that shape.
//
// A plain generateContent call, not services/lib/gemini_loop.mjs: the filter
// has no tools and one turn.

export const TIKTOK_FILTER_MODEL = "gemini-3.7-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createTitleFilter({ apiKey, systemPrompt, fetchImpl = fetch, model = TIKTOK_FILTER_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("createTitleFilter: apiKey is required");
  if (!systemPrompt) throw new Error("createTitleFilter: systemPrompt is required");
  const url = `${GEMINI_BASE}/${model}:generateContent`;

  return async function filter(titles) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `Results:\n${titles.map((t, i) => `${i}. ${t}`).join("\n")}` }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const why = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : err.message;
      throw new Error(`title filter (${model}): request failed: ${why}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) {
      throw new Error(`title filter (${model}): HTTP ${res.status}: ${String(text).slice(0, 200)}`);
    }

    let verdicts;
    try {
      const parts = JSON.parse(text)?.candidates?.[0]?.content?.parts ?? [];
      const answer = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      verdicts = JSON.parse(answer);
    } catch (err) {
      throw new Error(`title filter (${model}): response is not parseable JSON: ${err.message}`);
    }
    if (!Array.isArray(verdicts)) {
      throw new Error(`title filter (${model}): expected a JSON array of verdicts, got ${typeof verdicts}`);
    }

    const byIndex = new Map(verdicts.map((v) => [Number(v?.i), v]));
    return titles.map((_, i) => {
      const v = byIndex.get(i);
      return { keep: v?.keep === true, phrase: String(v?.phrase ?? "") };
    });
  };
}
