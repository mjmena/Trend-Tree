// Audit Agent — saturation guard (CRMA-1031)
//
// Pure helper, sibling-imported by ./entry.mjs, like ./catalog_freshness.mjs.
// It imports no other sibling.
//
// From 2026-08-25 to 2026-10-05 no scheduled audit graded GREEN, and the Slack
// gate sent a DM on every run that was not GREEN. One area stayed RED for
// weeks with no action possible, so a new RED looked the same as the old ones.
//
// This module gives each RED area a streak: the number of consecutive
// scheduled (cron) runs, this one included, in which the area graded RED. It
// also decides whether the run sends the Slack DM. The DM goes out when the
// picture changed, and once every WEEKLY_REMINDER_RUNS runs while a streak
// lasts. The ledger row is written on every run, as before.
//
// The decision is made here, not in post_to_slack, for two reasons. A `.js`
// step cannot import a tested sibling. And commit_audit_ledger runs before
// post_to_slack, so only a decision made in this step reaches the ledger row.
//
// An area is the `area` string of an alert. Two workflows that fail on
// different days both count as `workflow_health`.

const SCHEDULED = "cron";
export const WEEKLY_REMINDER_RUNS = 7;

export function normalizeArea(area) {
  return String(area ?? "").trim().toLowerCase() || "unknown";
}

const isRed = (alert) => String(alert?.severity).toUpperCase() === "RED";

// The Snowflake action can return an ARRAY column as a JSON string.
function parseAreas(value) {
  let list = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { list = []; }
  }
  return [...new Set((Array.isArray(list) ? list : []).map(normalizeArea))].sort();
}

function scheduledRuns(history) {
  return (Array.isArray(history) ? history : [])
    .filter((r) => r && r.TRIGGER_KIND === SCHEDULED)
    .map((r) => ({
      evaluated_at: r.EVALUATED_AT ?? null,
      overall_status: r.OVERALL_STATUS ?? null,
      red_areas: parseAreas(r.RED_AREAS),
    }));
}

/**
 * redAreas: the areas that grade RED in this run, normalized.
 * history: q_audit_history rows, newest first —
 *   { EVALUATED_AT, TRIGGER_KIND, OVERALL_STATUS, RED_AREAS }
 * A streak counts consecutive scheduled runs. An HTTP run reports the
 * scheduled streak so far and adds nothing to it, so a RED that the last
 * scheduled run did not have reads 0 there.
 */
export function computeStreaks({ redAreas, history, triggerKind }) {
  const runs = scheduledRuns(history);
  const own = triggerKind === SCHEDULED ? 1 : 0;
  const streaks = {};
  for (const area of redAreas) {
    let n = 0;
    while (n < runs.length && runs[n].red_areas.includes(area)) n += 1;
    streaks[area] = n + own;
  }

  const key = [...redAreas].sort().join("|");
  let same = 0;
  while (same < runs.length && runs[same].red_areas.join("|") === key) same += 1;

  return {
    streaks,
    previous: runs[0] || null,
    same_set_since: same > 0 ? runs[same - 1].evaluated_at : null,
  };
}

const day = (evaluatedAt) => String(evaluatedAt || "").slice(0, 10);

function decideSlackSend({ status, redAreas, streaks, previous, sameSetSince, triggerKind, force }) {
  if (force) return { send: true, reason: "force_slack=true" };

  // Nothing to compare with: keep the rule from before CRMA-1031. A repeated
  // DM costs less than a lost one.
  if (!previous) {
    return {
      send: status !== "GREEN",
      reason: `no earlier scheduled run to compare with; status ${status}`,
    };
  }

  if (status !== previous.overall_status) {
    return { send: true, reason: `status changed: ${previous.overall_status} → ${status}` };
  }

  const added = redAreas.filter((a) => !previous.red_areas.includes(a));
  const removed = previous.red_areas.filter((a) => !redAreas.includes(a));
  if (added.length || removed.length) {
    const delta = [...added.map((a) => `+${a}`), ...removed.map((a) => `-${a}`)].join(" ");
    return { send: true, reason: `RED areas changed: ${delta}` };
  }

  // Only a scheduled run moves a streak, so only a scheduled run reminds.
  if (triggerKind === SCHEDULED) {
    const due = redAreas.filter((a) => streaks[a] % WEEKLY_REMINDER_RUNS === 0);
    if (due.length) {
      const detail = due.map((a) => `${a} RED for ${streaks[a]} scheduled runs`).join(", ");
      return { send: true, reason: `weekly reminder: ${detail}` };
    }
  }

  if (redAreas.length === 0) {
    return {
      send: false,
      reason: `status ${status} unchanged from the ${day(previous.evaluated_at)} run, no RED area`,
    };
  }
  const detail = redAreas.map((a) => `${a} streak ${streaks[a]}`).join(", ");
  return { send: false, reason: `RED set unchanged since ${day(sameSetSince)} (${detail})` };
}

/**
 * Fold the saturation guard into the agent's report, after every other
 * fold-in, so that it sees the final alerts:
 *  - each RED alert gains streak_days
 *  - slack_summary_md opens with one line that names each RED area and its
 *    streak ("new" when the last scheduled run did not have it)
 *  - report.saturation records the RED areas, the streaks, the scheduled run
 *    it compared with, and the Slack decision { send, reason }
 * Returns a new object; does not mutate the input.
 */
export function applySaturation(report, { history, triggerKind, force }) {
  const base = report || {};
  const alerts = Array.isArray(base.alerts) ? base.alerts : [];
  const redAreas = [...new Set(alerts.filter(isRed).map((a) => normalizeArea(a.area)))].sort();
  const { streaks, previous, same_set_since } = computeStreaks({ redAreas, history, triggerKind });

  const slack = decideSlackSend({
    status: base.overall_status || "UNKNOWN",
    redAreas,
    streaks,
    previous,
    sameSetSince: same_set_since,
    triggerKind,
    force: !!force,
  });

  const labels = redAreas.map((a) => {
    const isNew = !previous || !previous.red_areas.includes(a);
    return `${a} (${isNew ? "new" : `day ${streaks[a]}`})`;
  });
  const line = labels.length ? `*RED areas:* ${labels.join(" · ")}` : null;

  return {
    ...base,
    alerts: alerts.map((a) => (isRed(a) ? { ...a, streak_days: streaks[normalizeArea(a.area)] } : a)),
    slack_summary_md: line
      ? (base.slack_summary_md ? `${line}\n\n${base.slack_summary_md}` : line)
      : base.slack_summary_md,
    saturation: { red_areas: redAreas, streaks, previous_run: previous, slack },
  };
}
