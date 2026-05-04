// Audit Agent — fetch_pipedream_errors
//
// Auto-discovers active workflows in project proj_x9sLmqO, then GETs each
// workflow's $errors event_summaries (last 24h, capped) plus its current
// active flag. Returns a normalized pool that the agent's
// `query_workflow_errors` tool slices.
//
// New pattern in this repo — no other workflow currently calls
// api.pipedream.com from inside a step. Pattern documented in
// scripts/test_distillation.sh:117.
//
// Bearer token from PIPEDREAM_API_KEY env var (set on the deployed workflow
// via Pipedream UI → Settings → Environment).

const ORG_ID = "o_qOIvyEa";
const PROJECT_ID = "proj_x9sLmqO";
const API_BASE = "https://api.pipedream.com/v1";
const ERRORS_LIMIT = 10;
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

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
    const apiKey = process.env.PIPEDREAM_API_KEY;
    if (!apiKey) {
      throw new Error("PIPEDREAM_API_KEY env var missing — set on workflow Settings → Environment");
    }

    // 1. List workflows in the project.
    const listUrl = `${API_BASE}/projects/${PROJECT_ID}/workflows`;
    const listResp = await fetchJson(listUrl, apiKey);
    if (!listResp.ok) {
      throw new Error(`Pipedream list workflows failed: ${listResp.status || ""} ${listResp.error}`);
    }
    const workflows = (listResp.data?.data || []).map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
    }));

    // 2. Per-workflow: fetch error summaries (last N events) + emits in last 24h
    //    to detect "active workflow that hasn't fired."
    const since = Date.now() - 24 * 3600_000;
    const results = await pmap(workflows, CONCURRENCY, async (w) => {
      const errUrl = `${API_BASE}/workflows/${w.id}/%24errors/event_summaries?org_id=${ORG_ID}&limit=${ERRORS_LIMIT}&expand=event`;
      const errors = await fetchJson(errUrl, apiKey);
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
        active: w.active,
        errors_24h_count: errs.length,
        errors_24h: errs,
        fetch_error: errors.ok ? null : (errors.error || `status ${errors.status || "?"}`),
      };
    });

    const summary = {
      project_id: PROJECT_ID,
      workflows_audited: results.length,
      active_count: results.filter((r) => r.active).length,
      errored_24h_count: results.filter((r) => r.errors_24h_count > 0).length,
      total_errors_24h: results.reduce((s, r) => s + r.errors_24h_count, 0),
      fetch_failures: results.filter((r) => r.fetch_error).length,
    };

    console.log(
      `pipedream-errors: ${summary.workflows_audited} workflows, ` +
      `${summary.active_count} active, ${summary.errored_24h_count} with errors, ` +
      `${summary.total_errors_24h} total errors in 24h`
    );

    return { summary, workflows: results };
  },
});
