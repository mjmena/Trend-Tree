// Subagent fanout client
// ======================
//
// Posts N hypotheses to the distillation subagent's HTTP endpoint in
// parallel with a concurrency cap (default 10 in flight). Used by the
// lead orchestrator's `dispatch_subagent` tool.
//
// Design notes:
//  - Per-call timeout (default 240s, accommodating subagent loop wall-clock
//    of 60-180s plus ingest tool latency).
//  - One subagent failure does NOT tank the whole batch; failed dispatches
//    return { error } and the lead can decide what to do.
//  - We do NOT await prompt caching or any auth handshake here — the
//    subagent endpoint accepts a plain JSON POST with whatever the lead
//    provides as `dispatches[]` items.

export async function fanoutSubagents({
  url,
  dispatches,
  concurrency = 10,
  perCallTimeoutMs = 240_000,
}) {
  if (!url || /PLACEHOLDER/i.test(url)) {
    return {
      error: `subagent endpoint not configured (got '${url}'). Set DISTILLATION_SUBAGENT_URL env var.`,
      results: [],
    };
  }
  if (!Array.isArray(dispatches) || dispatches.length === 0) {
    return { results: [], note: "no dispatches" };
  }

  const results = new Array(dispatches.length);
  let cursor = 0;

  async function worker() {
    while (cursor < dispatches.length) {
      const idx = cursor++;
      const body = dispatches[idx];
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), perCallTimeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await resp.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (!resp.ok) {
          results[idx] = {
            hypothesis: body.hypothesis,
            bucket: body.bucket,
            error: `HTTP ${resp.status}: ${text.slice(0, 240)}`,
            duration_ms: Date.now() - started,
          };
        } else {
          results[idx] = {
            hypothesis: body.hypothesis,
            bucket: body.bucket,
            duration_ms: Date.now() - started,
            ...parsed,
          };
        }
      } catch (e) {
        results[idx] = {
          hypothesis: body.hypothesis,
          bucket: body.bucket,
          error: e.name === "AbortError" ? `timeout after ${perCallTimeoutMs}ms` : e.message,
          duration_ms: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, dispatches.length) }, () => worker());
  await Promise.all(workers);

  // Aggregate stats so the LLM gets a concise summary alongside per-result detail.
  const summary = {
    dispatched: dispatches.length,
    succeeded: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    by_verdict: {},
  };
  for (const r of results) {
    const v = r?.verdict || (r?.error ? "ERROR" : "UNKNOWN");
    summary.by_verdict[v] = (summary.by_verdict[v] || 0) + 1;
  }
  return { results, summary };
}
