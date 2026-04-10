// Enrichment Dispatcher — orchestrate
//
// Single custom code step that drives the whole enrichment pipeline
// synchronously via fetch():
//
//   sources workflow → llm-enrichment workflow → write workflow
//
// Each hop is a plain HTTPS POST to the respective workflow's HTTP
// trigger endpoint, waiting for the JSON response body before
// proceeding. The LLM workflow is the slow one (~100–120s); sources
// and write are each ~5–60s. Total wall clock ~200s, comfortably
// under the 600s lambda timeout.
//
// On any HTTP or network failure, returns { error_message: "..." }.
// The downstream mark_failed registry step uses that string as a
// gate — when non-empty it UPDATEs the queue to STATUS='FAILED' with
// the message in ERROR_MESSAGE. On success, error_message is empty
// and the mark_failed step is a no-op (thanks to its WHERE :2 != '').
//
// Endpoint URLs are tied to each workflow's HTTP trigger and don't
// change once the workflow exists (Pipedream assigns the *.m.pipedream.net
// subdomain at trigger creation time and persists it). Hard-coded here as
// defaults; project env vars (SOURCES_URL / LLM_URL / WRITE_URL) override
// them if you ever need to point at a different environment.

const DEFAULT_SOURCES_URL = "https://eoqw249vy2xnwyv.m.pipedream.net"; // sources-p_7NCy36w
const DEFAULT_LLM_URL     = "https://eod25mq0qt8tk4q.m.pipedream.net"; // llm-enrichment-p_YyC86Zo
const DEFAULT_WRITE_URL   = "https://eobhhpl77hkx33c.m.pipedream.net"; // write-p_o7CWa2K

// mark_failed inlines this string directly into a Snowflake UPDATE via
// mustache substitution (no parameter binding), so any embedded single
// quote would terminate the SQL string literal early. Strip quotes and
// control chars and cap at 480 chars (the column is LEFT-truncated to
// 500 by the UPDATE itself, but we leave a small margin).
function sanitizeErrorMessage(msg) {
  if (!msg) return "";
  return String(msg)
    .replace(/['\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 480);
}

async function postJson(url, body, { timeoutMs = 500_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!resp.ok) {
      const snippet = text.slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`HTTP ${resp.status}: ${snippet}`);
    }
    return parsed ?? { _raw: text };
  } finally {
    clearTimeout(timer);
  }
}

export default defineComponent({
  props: {
    trend_id: {
      type: "string",
      label: "Trend ID",
      description: "Wired from the Snowflake polling trigger event",
    },
    enrichment_type: {
      type: "string",
      label: "Enrichment type",
      description: "From STG_ENRICHMENT_QUEUE.ENRICHMENT_TYPE (FULL | SOURCES_ONLY | REFRESH)",
      optional: true,
    },
    trend_event: {
      type: "any",
      label: "Full trigger event (for debugging)",
      optional: true,
    },
  },
  async run({ $ }) {
    const trendId = this.trend_id;
    if (!trendId) {
      return { error_message: "missing trend_id in trigger event", stage: "pre" };
    }

    const sourcesUrl = process.env.SOURCES_URL || DEFAULT_SOURCES_URL;
    const llmUrl = process.env.LLM_URL || DEFAULT_LLM_URL;
    const writeUrl = process.env.WRITE_URL || DEFAULT_WRITE_URL;

    const enrichmentType =
      (this.enrichment_type && String(this.enrichment_type).toUpperCase()) || "FULL";
    console.log(`\n=== Dispatching ${trendId} [${enrichmentType}] ===`);

    const started = Date.now();
    let sourcesResp = null;
    let llmResp = null;
    let writeResp = null;

    // ── 1. Sources ────────────────────────────────────────────────
    try {
      console.log(`[sources] POST ${sourcesUrl}`);
      sourcesResp = await postJson(sourcesUrl, { trend_id: trendId });
      console.log(
        `[sources] coverage=${sourcesResp?.source_coverage ?? "?"} records=${
          sourcesResp?.records?.length ?? "?"
        }`,
      );
    } catch (e) {
      return {
        error_message: sanitizeErrorMessage(`sources failed: ${e.message}`),
        stage: "sources",
        trend_id: trendId,
      };
    }

    // ── 2. LLM (skip for non-FULL) ────────────────────────────────
    if (enrichmentType === "FULL") {
      try {
        console.log(`[llm] POST ${llmUrl}`);
        llmResp = await postJson(llmUrl, { trend_id: trendId });
        console.log(
          `[llm] tokens=${llmResp?.llm_total_tokens ?? "?"} gated=${
            llmResp?.gated ?? false
          }`,
        );
      } catch (e) {
        return {
          error_message: sanitizeErrorMessage(`llm failed: ${e.message}`),
          stage: "llm",
          trend_id: trendId,
          sources: sourcesResp,
        };
      }
    } else {
      console.log(`[llm] skipped (enrichment_type=${enrichmentType})`);
    }

    // ── 3. Write ─────────────────────────────────────────────────
    try {
      console.log(`[write] POST ${writeUrl}`);
      writeResp = await postJson(writeUrl, {
        trend_id: trendId,
        enrichment_type: enrichmentType,
        llm_output: llmResp,
      });
      console.log(
        `[write] tier=${writeResp?.tier ?? "?"} commercial=${
          writeResp?.commercial_score ?? "?"
        }`,
      );
    } catch (e) {
      return {
        error_message: sanitizeErrorMessage(`write failed: ${e.message}`),
        stage: "write",
        trend_id: trendId,
        sources: sourcesResp,
        llm: llmResp,
      };
    }

    const durationMs = Date.now() - started;
    console.log(`=== Dispatch complete in ${Math.round(durationMs / 1000)}s ===`);

    $.export(
      "$summary",
      `${trendId} [${enrichmentType}] → ${writeResp?.tier ?? "?"} in ${Math.round(durationMs / 1000)}s`,
    );

    return {
      error_message: "",
      stage: "done",
      trend_id: trendId,
      enrichment_type: enrichmentType,
      duration_ms: durationMs,
      sources: sourcesResp,
      llm: llmResp,
      write: writeResp,
    };
  },
});
