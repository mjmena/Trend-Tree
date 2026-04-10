// Pipedream Workflow Step: Check Links
//
// Consumes dashboard rows (from query_dashboard) and bulk signals (from
// query_signals_bulk), groups signals by TREND_ID, runs HTTP HEAD requests
// in parallel to validate each URL, and attaches `alive_signals` +
// `dead_signals` to each dashboard row.
//
// Pseudo-URLs (non-http(s) strings — e.g. Amazon aggregated SIGNAL_IDs that
// leaked into STG_TREND_SIGNALS.URL) are filtered BEFORE the HTTP check and
// recorded as dead with reason "pseudo_url", so we never render them as
// <a href> in the email and they're treated as needing replacement.

const normalizeUrl = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    // strip utm_* query params
    const toDelete = [];
    u.searchParams.forEach((_, k) => {
      if (k.toLowerCase().startsWith("utm_")) toDelete.push(k);
    });
    toDelete.forEach((k) => u.searchParams.delete(k));
    // strip trailing slash on path (but keep root slash)
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
};

const isRealHttpUrl = (raw) => {
  if (typeof raw !== "string") return false;
  const s = raw.trim().toLowerCase();
  return s.startsWith("http://") || s.startsWith("https://");
};

// Minimal promise-based semaphore for concurrency control.
const makeSemaphore = (max) => {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
};

const checkOne = async (url, timeoutMs) => {
  // Try HEAD first; on 405/403 retry as GET with Range: bytes=0-0.
  const doFetch = async (method, extraHeaders = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TrendTreeLinkChecker/1.0; +https://mcclatchy.com)",
          ...extraHeaders,
        },
        signal: controller.signal,
      });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let resp = await doFetch("HEAD");
    if (resp.status === 405 || resp.status === 403) {
      resp = await doFetch("GET", { Range: "bytes=0-0" });
    }
    if (resp.status >= 200 && resp.status < 400) {
      return { alive: true, http_status: resp.status, final_url: resp.url || url };
    }
    return { alive: false, http_status: resp.status, reason: `http_${resp.status}` };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || "error";
    return { alive: false, reason: msg };
  }
};

export default defineComponent({
  name: "Check Links",
  description:
    "HTTP-validate source URLs for each dashboard row; filter pseudo-URLs.",
  version: "0.0.1",
  props: {
    dashboard_rows: {
      type: "any",
      label: "Dashboard rows from query_dashboard",
    },
    signal_rows: {
      type: "any",
      label: "Signal rows from query_signals_bulk",
    },
    http_timeout_ms: {
      type: "integer",
      label: "HTTP timeout per URL (ms)",
      default: 5000,
      optional: true,
    },
    concurrency: {
      type: "integer",
      label: "Max concurrent HTTP checks",
      default: 8,
      optional: true,
    },
  },
  async run({ $ }) {
    const started = Date.now();
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    const signals = Array.isArray(this.signal_rows) ? this.signal_rows : [];

    // Group signals by TREND_ID, dedupe by normalized URL, preserve PageRank order.
    const byTrend = new Map();
    for (const s of signals) {
      const tid = s.TREND_ID;
      if (!tid) continue;
      if (!byTrend.has(tid)) byTrend.set(tid, { seen: new Set(), list: [] });
      const bucket = byTrend.get(tid);
      const rawUrl = s.URL;
      const norm = normalizeUrl(rawUrl) || (typeof rawUrl === "string" ? rawUrl.trim() : null);
      if (!norm) continue;
      if (bucket.seen.has(norm)) continue;
      bucket.seen.add(norm);
      bucket.list.push({
        title: s.TITLE || "",
        url: norm,
        source: s.SOURCE || "",
        domain: s.DOMAIN || "",
        pagerank_score: s.PAGERANK_SCORE ?? null,
      });
    }

    // Partition: pseudo-URLs go straight to dead_signals; real URLs get HTTP-checked.
    const workQueue = []; // { row, sig }
    const perRow = new Map(); // TREND_ID -> { alive: [], dead: [] }
    for (const row of rows) {
      perRow.set(row.TREND_ID, { alive: [], dead: [] });
      const bucket = byTrend.get(row.TREND_ID);
      const list = bucket?.list || [];
      for (const sig of list) {
        if (!isRealHttpUrl(sig.url)) {
          perRow.get(row.TREND_ID).dead.push({
            title: sig.title,
            url: sig.url,
            source: sig.source,
            reason: "pseudo_url",
          });
        } else {
          workQueue.push({ row, sig });
        }
      }
    }

    // Parallel HTTP checks under a semaphore cap.
    const sem = makeSemaphore(this.concurrency ?? 8);
    const timeoutMs = this.http_timeout_ms ?? 5000;
    await Promise.all(
      workQueue.map(({ row, sig }) =>
        sem(async () => {
          const result = await checkOne(sig.url, timeoutMs);
          const target = perRow.get(row.TREND_ID);
          if (result.alive) {
            target.alive.push({
              title: sig.title,
              url: sig.url,
              source: sig.source,
              domain: sig.domain,
              pagerank_score: sig.pagerank_score,
              final_url: result.final_url,
              http_status: result.http_status,
            });
          } else {
            target.dead.push({
              title: sig.title,
              url: sig.url,
              source: sig.source,
              reason: result.reason,
              http_status: result.http_status,
            });
          }
        }),
      ),
    );

    // Preserve PageRank order inside alive_signals. workQueue was walked in
    // per-trend PageRank order, but Promise.all resolution order is arbitrary,
    // so re-sort by the original bucket index.
    for (const row of rows) {
      const bucket = byTrend.get(row.TREND_ID);
      const orderIdx = new Map();
      (bucket?.list || []).forEach((s, i) => orderIdx.set(s.url, i));
      const target = perRow.get(row.TREND_ID);
      target.alive.sort(
        (a, b) => (orderIdx.get(a.url) ?? 0) - (orderIdx.get(b.url) ?? 0),
      );
      row.alive_signals = target.alive;
      row.dead_signals = target.dead;
    }

    let checked = 0;
    let alive = 0;
    let dead = 0;
    for (const row of rows) {
      alive += row.alive_signals.length;
      dead += row.dead_signals.length;
      checked += row.alive_signals.length + row.dead_signals.length;
    }

    const elapsed_ms = Date.now() - started;
    $.export(
      "$summary",
      `Checked ${checked} URLs — ${alive} alive / ${dead} dead (${elapsed_ms} ms)`,
    );
    return {
      rows,
      _stats: { urls_checked: checked, alive, dead, elapsed_ms },
    };
  },
});
