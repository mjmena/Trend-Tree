// Audit Agent — normalize_event
//
// Cron-fired by sources/audit-cron at 13:00 UTC most of the time. Manual
// POSTs (testing, ad-hoc audits) can override:
//   { dry_run, force_slack, lookback_hours, chain_id }
//
// chain_id stamps the run end-to-end so post-mortem queries can filter
// FCT_AUDIT_LEDGER rows back to the original trigger.

const SHORT_ID_OK = /^[A-Za-z0-9_\-]{1,64}$/;

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
    const ev = this.trigger_event || {};
    const body = ev.body || {};
    const isHttp = Boolean(ev.body !== undefined || ev.headers);
    const trigger_kind = isHttp ? "http" : "cron";

    const chain_id = SHORT_ID_OK.test(body.chain_id || "") ? body.chain_id : `audit-chain-${uuid()}`;
    const dry_run = body.dry_run === true || body.dry_run === "true";
    const force_slack = body.force_slack === true || body.force_slack === "true";
    const lookback_hours = clamp(body.lookback_hours, 1, 168) ?? 24;

    console.log(
      `audit: chain=${chain_id} trigger=${trigger_kind} ` +
      `dry_run=${dry_run} force_slack=${force_slack} lookback_hours=${lookback_hours}`
    );

    return {
      chain_id,
      trigger_kind,
      dry_run,
      force_slack,
      lookback_hours,
    };
  },
});
