// Pipedream Workflow Step: Build Email
//
// Reads upstream Snowflake results (query_dashboard + query_stats), renders a
// dark-themed HTML email matching the approved mockup, and returns
// { subject, html_body } for the downstream braze_send step. No network calls.
//
// Layout:
//   - Top bar: date string (left) + "Open dashboard" button (right)
//   - Stats row: TOTAL / NEW / UPDATED counts
//   - "New today" section (only if any IS_NEW rows)
//   - "Top trends" section (the rest)
//   - Each card: name, tag chips, summary, key data points, sources

const DASHBOARD_URL = "#"; // TODO: replace with real public dashboard URL when available
const TIMEZONE = "America/Los_Angeles";

// ---------- tiny helpers ----------

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Snowflake VARIANT columns may come back as JSON strings depending on session
// config; normalize to a JS value (array/object) or null.
const parseVariant = (v) => {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
};

const fmtDate = (d) => new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: TIMEZONE,
}).format(d);

const fmtNumber = (n) => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const num = Number(n);
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(1) + "K";
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(1);
};

// ---------- HTML fragments ----------

const chip = (label, { bg = "#1f2937", fg = "#e5e7eb", border = "#374151" } = {}) =>
  `<span style="display:inline-block;padding:3px 8px;margin:0 6px 4px 0;border:1px solid ${border};border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;">${esc(label)}</span>`;

const velocityChip = (velocity) => {
  if (!velocity) return "";
  const v = String(velocity).toLowerCase();
  if (v.includes("rising") || v.includes("growing") || v.includes("up")) {
    return chip("rising", { bg: "#052e1a", fg: "#34d399", border: "#065f46" });
  }
  if (v.includes("fall") || v.includes("declin") || v.includes("down")) {
    return chip(velocity, { bg: "#2a0e13", fg: "#fca5a5", border: "#7f1d1d" });
  }
  return chip(velocity);
};

const newBadge = () =>
  `<span style="display:inline-block;padding:3px 8px;margin:0 6px 4px 0;border:1px solid #065f46;border-radius:999px;background:#052e1a;color:#34d399;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">NEW</span>`;

const dataPointLine = (dp) => {
  const src = esc(dp.source ?? dp.SOURCE ?? "");
  const name = esc(dp.metric_name ?? dp.METRIC_NAME ?? "");
  const val = fmtNumber(dp.metric_value ?? dp.METRIC_VALUE);
  return `<div style="font-size:12px;color:#9ca3af;line-height:1.5;">
    <span style="color:#d1d5db;font-weight:600;">${src}</span>
    &nbsp;·&nbsp; ${val} <span style="color:#6b7280;">${name}</span>
  </div>`;
};

const sourceLink = (sig) => {
  const url = sig.url ?? sig.URL;
  const title = sig.source ?? sig.SOURCE ?? sig.title ?? sig.TITLE ?? "source";
  if (!url) return "";
  return `<a href="${esc(url)}" style="color:#60a5fa;text-decoration:none;font-size:12px;margin-right:12px;">${esc(title)} ›</a>`;
};

const renderCard = (row) => {
  const name = esc(row.TREND_NAME ?? "(untitled trend)");
  const summary = esc(row.SUMMARY_SHORT ?? "");
  const category = row.CATEGORY ? chip(row.CATEGORY) : "";
  const macroTags = parseVariant(row.MACROTREND_TAGS) || [];
  const firstMacro = Array.isArray(macroTags) && macroTags.length > 0 ? chip(macroTags[0]) : "";
  const velocity = velocityChip(row.VELOCITY_DIRECTION);
  const isNewPill = row.IS_NEW ? newBadge() : "";

  const dataPoints = (parseVariant(row.KEY_DATA_POINTS) || []).slice(0, 3);
  const dpHtml = dataPoints.length > 0
    ? `<div style="margin-top:10px;padding:10px 12px;background:#0b1220;border-left:2px solid #374151;border-radius:4px;">
         ${dataPoints.map(dataPointLine).join("")}
       </div>`
    : "";

  const topSignals = (parseVariant(row.TOP_SIGNALS) || []).slice(0, 2);
  const sourcesHtml = topSignals.length > 0
    ? `<div style="margin-top:10px;font-size:12px;color:#6b7280;">
         <span style="color:#4b5563;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-right:6px;">Sources</span>
         ${topSignals.map(sourceLink).join("")}
       </div>`
    : "";

  return `
    <div style="padding:18px 20px;margin-bottom:12px;background:#161b22;border:1px solid #1f2937;border-radius:8px;">
      <div style="font-size:16px;font-weight:700;color:#f9fafb;line-height:1.3;margin-bottom:8px;">
        ${name}
      </div>
      <div style="margin-bottom:10px;">
        ${isNewPill}${category}${firstMacro}${velocity}
      </div>
      <div style="font-size:14px;color:#d1d5db;line-height:1.5;">
        ${summary}
      </div>
      ${dpHtml}
      ${sourcesHtml}
    </div>`;
};

const renderSectionHeader = (label) =>
  `<div style="margin:20px 0 10px 0;font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;">${esc(label)}</div>`;

// ---------- main component ----------

export default defineComponent({
  props: {
    dashboard_rows: {
      type: "any",
      label: "V_TREND_DASHBOARD rows (new-today + top 10 by heat)",
    },
    stats_rows: {
      type: "any",
      label: "Header stats: TOTAL / NEW / UPDATED",
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    const stats = (Array.isArray(this.stats_rows) ? this.stats_rows[0] : null) || {};

    const totalTrends = stats.TOTAL_TRENDS ?? 0;
    const newTrends = stats.NEW_TRENDS ?? 0;
    const updatedTrends = stats.UPDATED_TRENDS ?? 0;

    const dateStr = fmtDate(new Date());
    const subject = `Trend Insights Daily — ${dateStr}`;

    // Split and sort: new-today first (by heat desc within), then the rest (by heat desc).
    const newRows = rows.filter((r) => r.IS_NEW === true || r.IS_NEW === "true")
      .sort((a, b) => (b.HEAT_INDEX ?? 0) - (a.HEAT_INDEX ?? 0));
    const topRows = rows.filter((r) => !(r.IS_NEW === true || r.IS_NEW === "true"))
      .sort((a, b) => (b.HEAT_INDEX ?? 0) - (a.HEAT_INDEX ?? 0));

    // Empty-state short-circuit: no data at all.
    if (rows.length === 0) {
      const emptyHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:40px 20px;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;color:#e5e7eb;">
    <div style="font-size:14px;color:#9ca3af;margin-bottom:8px;">${esc(dateStr)}</div>
    <div style="font-size:18px;font-weight:600;">No active trends today.</div>
    <div style="font-size:13px;color:#6b7280;margin-top:8px;">The digest will resume once new enrichment output lands in V_TREND_DASHBOARD.</div>
  </div>
</body></html>`;
      $.export("$summary", `${subject} — empty (no rows)`);
      return { subject, html_body: emptyHtml };
    }

    const statCell = (value, label, color) => `
      <td align="center" width="33%" style="padding:12px 8px;">
        <div style="font-size:34px;font-weight:700;color:${color};line-height:1;">${fmtNumber(value)}</div>
        <div style="font-size:10px;font-weight:700;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;margin-top:6px;">${esc(label)}</div>
      </td>`;

    const newSection = newRows.length > 0
      ? renderSectionHeader("New today") + newRows.map(renderCard).join("")
      : "";
    const topSection = topRows.length > 0
      ? renderSectionHeader(newRows.length > 0 ? "Top trends" : "Today's top trends") + topRows.map(renderCard).join("")
      : "";

    const html_body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0d1117;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <!-- Top bar -->
          <tr>
            <td style="padding:0 4px 20px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" style="font-size:13px;color:#9ca3af;font-weight:500;letter-spacing:.02em;">
                    TREND INSIGHTS DAILY
                  </td>
                  <td align="right">
                    <a href="${esc(DASHBOARD_URL)}" style="display:inline-block;padding:8px 14px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:12px;font-weight:600;border-radius:6px;">Open dashboard</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero (date + stats) -->
          <tr>
            <td style="padding:28px 24px 20px 24px;background:#0b0f1a;border:1px solid #1f2937;border-radius:10px;">
              <div style="font-size:22px;font-weight:700;color:#f9fafb;margin-bottom:20px;">${esc(dateStr)}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${statCell(totalTrends, "Total trends", "#f9fafb")}
                  ${statCell(newTrends, "New today", "#34d399")}
                  ${statCell(updatedTrends, "Updated", "#fbbf24")}
                </tr>
              </table>
            </td>
          </tr>

          <!-- Cards -->
          <tr>
            <td style="padding:8px 0 0 0;">
              ${newSection}
              ${topSection}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 4px 8px 4px;text-align:center;font-size:11px;color:#4b5563;">
              Generated by Trend Tree — ${esc(dateStr)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    $.export("$summary", `${subject} — ${rows.length} cards (${newRows.length} new, ${topRows.length} top-heat)`);
    return { subject, html_body };
  },
});
