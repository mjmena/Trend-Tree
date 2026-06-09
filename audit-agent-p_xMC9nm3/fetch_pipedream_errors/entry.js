// Audit Agent — fetch_pipedream_errors
//
// Iterates a hardcoded list of workflow IDs, fetching each workflow's
// $errors event_summaries (last 24h, capped) plus its current active flag.
// Returns a normalized pool that the agent's `query_workflow_errors` tool
// slices.
//
// **No project-listing endpoint** exists in the Pipedream REST API
// (cookbook: "Use this instead of asking 'what workflows are in this
// project' — there's no REST endpoint for it"; re-confirmed 2026-06-08:
// GET /workflows, /orgs/{id}/workflows, /projects/{id}/workflows all 404).
// The list below must be kept in sync manually when new workflows are
// scaffolded — when it drifts, the omitted workflows' errors silently
// never reach the audit (this is how the entire ingestion tier went
// unmonitored until 2026-06-08). audit-agent itself is intentionally
// omitted — a run that dies mid-flight can't report its own death; the
// external multi-repo error monitor covers it.
//
// New pattern in this repo — no other workflow calls api.pipedream.com
// from inside a step. URL pattern documented in scripts/test_distillation.sh:117.
//
// Bearer token from API_KEY_PIPEDREAM env var (set workspace-wide via
// Pipedream UI → Account Settings → Environment Variables. The
// `PIPEDREAM_*` prefix is reserved by Pipedream, hence the inverted name).

const ORG_ID = "o_qOIvyEa";
const API_BASE = "https://api.pipedream.com/v1";
const ERRORS_LIMIT = 10;
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

// Hardcoded — no project-listing endpoint exists. Update when scaffolding
// a new workflow. Pair the id with a human-readable name so the agent's
// report doesn't have to look up names from p_* alone.
const WORKFLOW_REGISTRY = [
  // --- core trend pipeline ---
  { id: "p_5VCPP3N", name: "discovery" },
  { id: "p_YyC89Ke", name: "distillation-cluster-agent" },
  { id: "p_mkCBBqb", name: "distillation" },
  { id: "p_jmCjj3J", name: "distillation-subagent" },
  { id: "p_o7CWWZl", name: "distillation-revisit" },
  { id: "p_ezCwwKm", name: "distillation-revisit-subagent" },
  { id: "p_dDCWWPg", name: "distillation-watchdog" },
  { id: "p_xMC99jg", name: "promotion" },
  { id: "p_yKCmm9r", name: "promotion-agent" },
  { id: "p_8rCBgnl", name: "dispatcher" },
  { id: "p_7NCy36w", name: "sources" },
  { id: "p_xMC995w", name: "enrichment" },
  { id: "p_o7CWa2K", name: "write" },
  // --- lifecycle / prediction / digest ---
  { id: "p_JZCz73w", name: "lifecycle-agent" },
  { id: "p_gYC562o", name: "lifecycle-subagent" },
  { id: "p_KwCoaap", name: "lifecycle-attribution-agent" },
  { id: "p_PACe77B", name: "lifecycle-attribution-subagent" },
  { id: "p_QPCkLP1", name: "prediction-agent" },
  { id: "p_vQCkwgV", name: "daily-digest" },
  // --- ingestion (was entirely unmonitored before 2026-06-08) ---
  { id: "p_13CN9KG", name: "gtrends-poller" },
  { id: "p_rvC71gN", name: "ingest-amazon-movers" },
  { id: "p_V9CgV17", name: "ingest-bluesky" },
  { id: "p_3nC3xkk", name: "ingest-google-trends" },
  { id: "p_wOC618j", name: "ingest-google-trends-explore" },
  { id: "p_xMC9jR5", name: "ingest-pinterest" },
  { id: "p_yKCm9Am", name: "ingest-tiktok-trending" },
  { id: "p_5VCPJVJ", name: "ingest-gemini-food-drink" },
  { id: "p_dDCWMDJ", name: "ingest-gemini-other" },
  { id: "p_BjC3yGQ", name: "ingest-gemini-travel" },
  { id: "p_zAC1DvL", name: "ingest-gemini-wellness" },
  { id: "p_ZJCrPWJ", name: "gemini-prompt-tester" },
  // --- ingestion agent-tools (transient 429s/timeouts expected — triage as INFO unless sustained) ---
  { id: "p_vQCkkGK", name: "grok-live-search" },
  { id: "p_13CNNwP", name: "search-bluesky" },
  { id: "p_WxCppoa", name: "search-gdelt" },
  { id: "p_YyC88x8", name: "search-google-trends" },
];

async function fetchJson(url, apiKey, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, status: resp.status, error: text.slice(0, 400) };
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function pmap(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export default defineComponent({
  props: {
    event: { type: "object" },
  },
  async run() {
    const apiKey = process.env.API_KEY_PIPEDREAM;
    if (!apiKey) {
      throw new Error("API_KEY_PIPEDREAM env var missing — set workspace-wide via Account Settings → Environment Variables");
    }

    // Per-workflow: fetch error summaries only. The Pipedream REST API has
    // no GET for the workflow's `active` flag — workflow_get returns
    // structure only, and PUT /workflows/{id} writes active without a
    // corresponding read. So we don't track active here; deactivated
    // workflows surface indirectly via "0 emits + expected cron firing"
    // which would be a future enhancement (one more emits API call per workflow).
    const since = Date.now() - 24 * 3600_000;
    const results = await pmap(WORKFLOW_REGISTRY, CONCURRENCY, async (w) => {
      const errors = await fetchJson(
        `${API_BASE}/workflows/${w.id}/%24errors/event_summaries?org_id=${ORG_ID}&limit=${ERRORS_LIMIT}&expand=event`,
        apiKey,
      );

      const errs = (errors.ok ? errors.data?.data || [] : [])
        .map((e) => {
          const orig = e.event?.original_context || {};
          const err = e.event?.error || {};
          const ts = e.indexed_at_ms ? Number(e.indexed_at_ms) : null;
          return {
            event_id: e.id,
            ts_ms: ts,
            ts_iso: ts ? new Date(ts).toISOString() : null,
            recent_24h: ts ? ts >= since : false,
            cell_id: orig.cell_id || null,
            code: err.code || null,
            msg: typeof err.msg === "string" ? err.msg.slice(0, 400) : null,
          };
        })
        .filter((e) => e.ts_ms === null || e.recent_24h);

      return {
        workflow_id: w.id,
        workflow_name: w.name,
        errors_24h_count: errs.length,
        errors_24h: errs,
        fetch_error: errors.ok ? null : (errors.error || `status ${errors.status || "?"}`),
      };
    });

    const summary = {
      org_id: ORG_ID,
      workflows_audited: results.length,
      errored_24h_count: results.filter((r) => r.errors_24h_count > 0).length,
      total_errors_24h: results.reduce((s, r) => s + r.errors_24h_count, 0),
      fetch_failures: results.filter((r) => r.fetch_error).length,
    };

    console.log(
      `pipedream-errors: ${summary.workflows_audited} workflows, ` +
      `${summary.errored_24h_count} with errors, ` +
      `${summary.total_errors_24h} total errors in 24h`
    );

    return { summary, workflows: results };
  },
});
