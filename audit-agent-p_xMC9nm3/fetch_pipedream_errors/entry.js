// Audit Agent — fetch_pipedream_errors
//
// Iterates a hardcoded list of workflow IDs, fetching each workflow's
// $errors event_summaries (last 24h, capped) plus its current active flag.
// Returns a normalized pool that the agent's `query_workflow_errors` tool
// slices.
//
// **No project-listing endpoint** exists in the Pipedream REST API
// (cookbook: "Use this instead of asking 'what workflows are in this
// project' — there's no REST endpoint for it"). The list below must be
// kept in sync manually when new workflows are scaffolded. audit-agent
// itself is intentionally omitted — error-alerts catches its errors.
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
  { id: "p_vQCkwgV", name: "daily-digest" },
  { id: "p_5VCPP3N", name: "discovery" },
  { id: "p_8rCBgnl", name: "dispatcher" },
  { id: "p_YyC89Ke", name: "distillation-cluster-agent" },
  { id: "p_mkCBBqb", name: "distillation" },
  { id: "p_o7CWWZl", name: "distillation-revisit" },
  { id: "p_ezCwwKm", name: "distillation-revisit-subagent" },
  { id: "p_jmCjj3J", name: "distillation-subagent" },
  { id: "p_dDCWWPg", name: "distillation-watchdog" },
  { id: "p_xMC995w", name: "enrichment" },
  { id: "p_zAC1Nd9", name: "error-alerts" },
  { id: "p_13CN9KG", name: "gtrends-poller" },
  { id: "p_JZCz73w", name: "lifecycle-agent" },
  { id: "p_KwCoaap", name: "lifecycle-attribution-agent" },
  { id: "p_PACe77B", name: "lifecycle-attribution-subagent" },
  { id: "p_gYC562o", name: "lifecycle-subagent" },
  { id: "p_yKCmm9r", name: "promotion-agent" },
  { id: "p_xMC99jg", name: "promotion" },
  { id: "p_7NCy36w", name: "sources" },
  { id: "p_o7CWa2K", name: "write" },
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

    // Per-workflow: fetch the workflow record (for active flag) AND error
    // summaries (last N events). Two requests per workflow, parallelized.
    const since = Date.now() - 24 * 3600_000;
    const results = await pmap(WORKFLOW_REGISTRY, CONCURRENCY, async (w) => {
      const [meta, errors] = await Promise.all([
        fetchJson(`${API_BASE}/workflows/${w.id}?org_id=${ORG_ID}`, apiKey),
        fetchJson(
          `${API_BASE}/workflows/${w.id}/%24errors/event_summaries?org_id=${ORG_ID}&limit=${ERRORS_LIMIT}&expand=event`,
          apiKey,
        ),
      ]);
      const active = meta.ok ? Boolean(meta.data?.active) : null;

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
        active,
        errors_24h_count: errs.length,
        errors_24h: errs,
        fetch_error: errors.ok ? null : (errors.error || `status ${errors.status || "?"}`),
        meta_fetch_error: meta.ok ? null : (meta.error || `status ${meta.status || "?"}`),
      };
    });

    const summary = {
      org_id: ORG_ID,
      workflows_audited: results.length,
      active_count: results.filter((r) => r.active === true).length,
      errored_24h_count: results.filter((r) => r.errors_24h_count > 0).length,
      total_errors_24h: results.reduce((s, r) => s + r.errors_24h_count, 0),
      fetch_failures: results.filter((r) => r.fetch_error || r.meta_fetch_error).length,
    };

    console.log(
      `pipedream-errors: ${summary.workflows_audited} workflows, ` +
      `${summary.active_count} active, ${summary.errored_24h_count} with errors, ` +
      `${summary.total_errors_24h} total errors in 24h`
    );

    return { summary, workflows: results };
  },
});
