// Distillation Watchdog — decide_and_fire
//
// Demand-driven trigger for the distillation lead. Reads the unclaimed
// signal pool size + cursor age from Snowflake (q_pool_status) and POSTs
// the distillation HTTP trigger when the pool is full enough to warrant
// a run AND enough time has passed since the last successful run.
//
// The 4h baseline cron on distillation-p_mkCBBqb stays as a safety net.
// This watchdog just shrinks the gap when discovery agents shard new
// signals quickly.

export default defineComponent({
  props: {
    pool_status_rows: { type: "any" },
    distillation_url: { type: "string" },
    pool_threshold:   { type: "integer", default: 450 },
    lockout_minutes:  { type: "integer", default: 30 },
  },
  async run() {
    const row = Array.isArray(this.pool_status_rows) ? this.pool_status_rows[0] : null;
    if (!row) {
      return { fired: false, reason: "no pool_status row" };
    }

    const unclaimed = Number(row.UNCLAIMED_COUNT ?? 0);
    const minutesSince = row.MINUTES_SINCE_LAST_RUN == null ? null : Number(row.MINUTES_SINCE_LAST_RUN);
    const lastRunAt = row.LAST_RUN_AT;

    const reasons = [];
    let shouldFire = true;

    if (unclaimed < this.pool_threshold) {
      shouldFire = false;
      reasons.push(`pool ${unclaimed} < threshold ${this.pool_threshold}`);
    }
    if (minutesSince !== null && minutesSince < this.lockout_minutes) {
      shouldFire = false;
      reasons.push(`only ${minutesSince}m since last run, < lockout ${this.lockout_minutes}m`);
    }

    if (!shouldFire) {
      console.log(`skipping: ${reasons.join("; ")}`);
      return {
        fired: false,
        unclaimed_count: unclaimed,
        minutes_since_last_run: minutesSince,
        last_run_at: lastRunAt,
        reason: reasons.join("; "),
      };
    }

    console.log(`firing distillation: pool=${unclaimed}, ${minutesSince}m since last run`);
    const res = await fetch(this.distillation_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "distillation-watchdog", unclaimed_count: unclaimed }),
    });

    return {
      fired: true,
      unclaimed_count: unclaimed,
      minutes_since_last_run: minutesSince,
      last_run_at: lastRunAt,
      http_status: res.status,
    };
  },
});
