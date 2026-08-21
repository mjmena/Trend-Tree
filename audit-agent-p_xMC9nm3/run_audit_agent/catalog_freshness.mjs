// Audit Agent — catalog freshness grading (CRMA-775)
//
// Pure helper, sibling-imported by ./entry.mjs (same step dir — the only
// cross-file import Pipedream's bundler allows; see the
// pipedream-synced-project skill). No `defineComponent` here, so this file
// is also directly `import`-able from a plain Node script for offline
// testing/demo — importing entry.mjs itself is NOT possible outside the
// Pipedream runtime, since `defineComponent` is an auto-injected global that
// doesn't exist in plain Node and the default-export call executes at
// module-evaluation time. entry.mjs (not .js) is required here specifically
// BECAUSE it does this sibling import — a hand-authored .js step cannot use
// sibling .mjs imports per the pipedream-synced-project skill's documented
// (empirically-verified) constraint; steps that don't import siblings can
// stay .js.
//
// Deliberately deterministic, not LLM-graded: "a dead catalog sync should be
// noticed within a day" is a mechanical staleness gate (MAX(LAST_SEEN_AT) vs
// a fixed day boundary), not a judgment call — same reasoning as the
// deterministic prediction-agent elsewhere in this repo. The grade computed
// here is folded into the agent's report AFTER the Gemini loop finishes
// (see applyCatalogFinding), so it can't be silently dropped by prompt
// drift the way a purely-LLM-observed context block could be (the live
// `audit.system` DIM_LLM_PROMPT template as of this story does not yet
// reference a catalog freshness block at all). applyCatalogFinding also
// patches slack_summary_md directly, not just alerts[]/overall_status —
// post_to_slack/entry.js renders ONLY slack_summary_md into the DM body, and
// since the LLM has no visibility into catalog data (per the prompt-drift
// note above), a catalog-caused escalation would otherwise page an operator
// with a status emoji but no explanation of why.

export const GREEN_MAX_DAYS = 3;
export const YELLOW_MAX_DAYS = 7;

const STATUS_RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
const STATUS_EMOJI = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" };

/** Worse-wins merge of two statuses. Never de-escalates. */
export function escalateStatus(a, b) {
  const ra = STATUS_RANK[a] ?? -1;
  const rb = STATUS_RANK[b] ?? -1;
  return rb > ra ? b : (a in STATUS_RANK ? a : b);
}

/**
 * GREEN <= 3d, YELLOW (3d, 7d], RED > 7d.
 * null/undefined/NaN (no reading at all) and negative (LAST_SEEN_AT in the
 * future relative to Snowflake's CURRENT_TIMESTAMP() — clock skew or a bad
 * source-side date) both fail SAFE to RED rather than being read as "0 days
 * old, perfectly fresh." An unreadable or nonsensical freshness signal is
 * itself the anomaly this gate exists to catch.
 */
export function gradeDaysSinceLastSeen(days) {
  if (days === null || days === undefined || Number.isNaN(days) || days < 0) return "RED";
  if (days > YELLOW_MAX_DAYS) return "RED";
  if (days > GREEN_MAX_DAYS) return "YELLOW";
  return "GREEN";
}

/**
 * rows: q_catalog_freshness output — one row per TIER EVER SEEN (LEFT JOINed
 * against active-only stats in SQL, so a tier that still exists but has zero
 * active rows today still appears, with LAST_SEEN_AT_MAX/MINUTES_SINCE_LAST_SEEN
 * NULL rather than the row vanishing):
 *   { TIER, LAST_SEEN_AT_MAX, MINUTES_SINCE_LAST_SEEN, ACTIVE_PRODUCT_COUNT }
 * Grouped by TIER (not collapsed to a single overall MAX) so a dead tier
 * can't hide behind a healthy one once a second tier (e.g. Amazon) exists —
 * today there's only 'shopify', but the grading doesn't assume that.
 */
export function gradeCatalogFreshness(rows) {
  const list = Array.isArray(rows) ? rows : [];

  if (list.length === 0) {
    return {
      status: "RED",
      days_since_last_seen: null,
      stale_tiers: ["(no active catalog rows found for any tier)"],
      tiers: [],
    };
  }

  const tiers = list.map((r) => {
    // NULL/undefined must NOT become Number(null) === 0 ("0 minutes ago" —
    // the opposite of what a missing reading means). Only a genuine numeric
    // value converts; anything else stays NaN -> days=null -> RED above.
    const raw = r.MINUTES_SINCE_LAST_SEEN;
    const minutes = raw === null || raw === undefined ? NaN : Number(raw);
    const days = Number.isFinite(minutes) ? minutes / 1440 : null;
    const status = gradeDaysSinceLastSeen(days);
    return {
      tier: r.TIER,
      last_seen_at_max: r.LAST_SEEN_AT_MAX ?? null,
      days_since_last_seen: days === null ? null : Math.round(days * 100) / 100,
      active_product_count: Number(r.ACTIVE_PRODUCT_COUNT || 0),
      status,
    };
  });

  const status = tiers.reduce((acc, t) => escalateStatus(acc, t.status), "GREEN");
  const stale_tiers = tiers.filter((t) => t.status !== "GREEN").map((t) => t.tier);
  // Report the worst (max) days-since-last-seen across tiers as the headline
  // number. A null-days tier (no active rows, or unreadable) still forces
  // RED via `status` above even though it can't contribute a numeric max.
  const days_since_last_seen = tiers.reduce(
    (max, t) => (t.days_since_last_seen === null ? max : Math.max(max, t.days_since_last_seen)),
    0,
  );

  return { status, days_since_last_seen, stale_tiers, tiers };
}

/** Narrative context block, matching the `<name>_block` convention used for
 * every other prefetch in run_audit_agent/entry.mjs. */
export function buildCatalogFreshnessBlock(graded) {
  if (graded.tiers.length === 0) {
    return `status: RED\n(no active DIM_CATALOG_PRODUCT rows found for any tier — either the ` +
      `catalog was never seeded or every row has been delisted)`;
  }
  const lines = graded.tiers.map(
    (t) => `  ${t.tier}: ${t.days_since_last_seen === null ? "no active rows" : `${t.days_since_last_seen}d since last sync`}, ${t.active_product_count} active products, status=${t.status}`,
  );
  return (
    `status: ${graded.status}\n` +
    `days_since_last_seen (worst tier): ${graded.days_since_last_seen}\n` +
    `per-tier:\n${lines.join("\n")}\n` +
    `Thresholds: GREEN <= ${GREEN_MAX_DAYS}d, YELLOW ${GREEN_MAX_DAYS}-${YELLOW_MAX_DAYS}d, RED > ${YELLOW_MAX_DAYS}d. ` +
    `This grade is computed deterministically (not an LLM judgment) and is merged into the ` +
    `report after this agent's loop finishes — it cannot be dropped by the agent forgetting to mention it.`
  );
}

/** One alert PER stale tier (not one combined alert) so severity/evidence
 * survives per-tier — a mixed YELLOW+RED multi-tier situation must not
 * collapse into a single alert that hides which tier is actually RED. */
function catalogAlerts(graded) {
  return graded.tiers
    .filter((t) => t.status !== "GREEN")
    .map((t) => ({
      severity: t.status === "RED" ? "RED" : "WARN",
      area: "catalog",
      summary: `Catalog sync stale for tier '${t.tier}': ${t.days_since_last_seen === null ? "no active rows" : `${t.days_since_last_seen}d since last sync`}`,
      evidence: `DIM_CATALOG_PRODUCT tier='${t.tier}' MAX(LAST_SEEN_AT)=${t.last_seen_at_max} ` +
        `age_days=${t.days_since_last_seen} active_products=${t.active_product_count} ` +
        `(GREEN<=${GREEN_MAX_DAYS}d, YELLOW<=${YELLOW_MAX_DAYS}d, RED>${YELLOW_MAX_DAYS}d)`,
    }));
}

/** Short bullet appended to slack_summary_md when catalog is non-GREEN — see
 * the file-header note on why this can't rely on the LLM to have mentioned it. */
function catalogSlackLine(graded) {
  if (graded.status === "GREEN") return null;
  const emoji = STATUS_EMOJI[graded.status] || "⚪";
  const detail = graded.tiers.length === 0
    ? "no active catalog rows for any tier"
    : graded.stale_tiers
        .map((tierName) => {
          const t = graded.tiers.find((x) => x.tier === tierName);
          return `${tierName} (${t && t.days_since_last_seen !== null ? `${t.days_since_last_seen}d` : "no active rows"})`;
        })
        .join(", ");
  return `${emoji} *Catalog*: stale — ${detail}`;
}

/**
 * Fold the deterministic catalog grade into the agent's report:
 *  - adds report.catalog (same per-area shape as report.dashboard etc.)
 *  - appends one alert per stale tier when non-GREEN
 *  - escalates (never de-escalates) report.overall_status
 *  - appends a bullet to slack_summary_md when non-GREEN, since post_to_slack
 *    renders ONLY that field and the LLM may not have seen catalog data
 * Returns a new object; does not mutate the input.
 */
export function applyCatalogFinding(report, graded) {
  const base = report || {};
  const alerts = Array.isArray(base.alerts) ? base.alerts.slice() : [];
  alerts.push(...catalogAlerts(graded));

  const slackLine = catalogSlackLine(graded);
  const slack_summary_md = slackLine
    ? `${base.slack_summary_md ? `${base.slack_summary_md}\n\n` : ""}${slackLine}`
    : base.slack_summary_md;

  return {
    ...base,
    catalog: {
      status: graded.status,
      days_since_last_seen: graded.days_since_last_seen,
      stale_tiers: graded.stale_tiers,
      tiers: graded.tiers,
    },
    alerts,
    slack_summary_md,
    overall_status: escalateStatus(base.overall_status || "GREEN", graded.status),
  };
}
