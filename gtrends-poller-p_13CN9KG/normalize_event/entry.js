// gtrends-poller — normalize_event
//
// Cron-fired most of the time; manual POST occasionally for testing.
// Body overrides: { trend_ids: [...], geo, timeframe, dry_run, max_trends }.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;
const ALLOWED_GEOS = /^[A-Z]{2}$/;

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(Number(n))) return null;
  return Math.min(Math.max(Number(n), lo), hi);
}

export default defineComponent({
  props: {
    trigger_event: { type: "any" },
  },
  async run() {
    const body = this.trigger_event?.body || {};

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `gtp-${uuid()}`;
    const geo = ALLOWED_GEOS.test(String(body.geo || "US").toUpperCase())
      ? String(body.geo || "US").toUpperCase()
      : "US";
    const timeframe = String(body.timeframe || "now 7-d").trim().slice(0, 32);
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const max_trends = clamp(body.max_trends, 1, 200) ?? 100;

    // Optional explicit trend_ids list overrides the SQL select (manual targeted runs).
    const trend_ids_filter = Array.isArray(body.trend_ids)
      ? body.trend_ids.map((s) => String(s).slice(0, 64)).filter(SHORT_ID_OK.test.bind(SHORT_ID_OK))
      : null;

    console.log(
      `gtrends-poller: chain=${chain_id} geo=${geo} timeframe='${timeframe}' max=${max_trends} dry_run=${dry_run}` +
      (trend_ids_filter ? ` filter=${trend_ids_filter.length}` : "")
    );

    return { chain_id, geo, timeframe, dry_run, max_trends, trend_ids_filter };
  },
});
