// Pipedream Workflow Step: Build Email
//
// Renders a light-themed HTML digest of NEW + GROWING trends from V_TREND_DASHBOARD
// and returns { subject, html_body } for the downstream braze_send step.
//
// Layout (light):
//   - Slim header: wordmark + date
//   - Single list of trend cards, sorted by heat desc
//   - Each card: name, category + velocity chips, summary, sources list (title → URL)

const DASHBOARD_URL = "#"; // TODO: replace with real public dashboard URL when available
const TIMEZONE = "America/Los_Angeles";

// ---------- helpers ----------

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Snowflake VARIANT columns may come back as JSON strings; normalize.
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

// ---------- HTML fragments ----------

const chip = (label, { bg = "#f3f4f6", fg = "#374151", border = "#e5e7eb" } = {}) =>
  `<span style="display:inline-block;padding:2px 9px;margin:0 6px 4px 0;border:1px solid ${border};border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:600;letter-spacing:.02em;">${esc(label)}</span>`;

const velocityChip = (velocity) => {
  if (!velocity) return "";
  const v = String(velocity).toUpperCase();
  if (v === "NEW") {
    return chip("New", { bg: "#eff6ff", fg: "#1d4ed8", border: "#bfdbfe" });
  }
  if (v === "GROWING") {
    return chip("Rising", { bg: "#ecfdf5", fg: "#047857", border: "#a7f3d0" });
  }
  if (v === "STABLE") return chip("Stable");
  if (v === "STAGNANT") return chip("Stagnant");
  if (v === "DECLINING") {
    return chip("Declining", { bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" });
  }
  return chip(v.toLowerCase());
};

// A source row: title on top (as link), full URL underneath in muted.
const sourceRow = (sig) => {
  const url = sig.url ?? sig.URL;
  if (!url) return "";
  const rawTitle = sig.title ?? sig.TITLE;
  const source = sig.source ?? sig.SOURCE;
  const title = rawTitle || source || url;
  return `
    <tr>
      <td style="padding:10px 0;border-top:1px solid #f3f4f6;">
        <a href="${esc(url)}" style="color:#111827;text-decoration:none;font-size:13px;font-weight:600;line-height:1.4;">${esc(title)}</a>
        <div style="font-size:11px;color:#9ca3af;margin-top:3px;word-break:break-all;line-height:1.4;">
          <a href="${esc(url)}" style="color:#9ca3af;text-decoration:none;">${esc(url)}</a>
        </div>
      </td>
    </tr>`;
};

const renderCard = (row) => {
  // B2C becomes the card headline; B2B becomes a muted subtitle directly beneath.
  // If only one exists, show just that (no subtitle). Fall back to TREND_NAME
  // (the coalesced view value) if both are missing.
  const b2c = row.TREND_NAME_B2C || null;
  const b2b = row.TREND_NAME_B2B || null;
  const fallback = row.TREND_NAME ?? "(untitled trend)";
  let headline, subtitle;
  if (b2c && b2b) { headline = b2c; subtitle = b2b; }
  else if (b2c)   { headline = b2c; subtitle = null; }
  else if (b2b)   { headline = b2b; subtitle = null; }
  else            { headline = fallback; subtitle = null; }

  const summary = esc(row.SUMMARY_SHORT ?? "");
  const category = row.CATEGORY ? chip(row.CATEGORY) : "";
  const macroTags = parseVariant(row.MACROTREND_TAGS) || [];
  const firstMacro = Array.isArray(macroTags) && macroTags.length > 0 ? chip(macroTags[0]) : "";
  const velocity = velocityChip(row.VELOCITY_DIRECTION);

  // Prefer LLM-verified final_sources; fall back to raw TOP_SIGNALS only if the
  // verify step never ran.
  const topSignals = Array.isArray(row.final_sources) && row.final_sources.length > 0
    ? row.final_sources.slice(0, 3)
    : (parseVariant(row.TOP_SIGNALS) || []).slice(0, 3);
  const sourcesHtml = topSignals.length > 0
    ? `<div style="margin-top:14px;">
         <div style="font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px;">Sources</div>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
           ${topSignals.map(sourceRow).join("")}
         </table>
       </div>`
    : "";

  const headlineBlock = `
      <div style="font-size:18px;font-weight:700;color:#111827;line-height:1.3;letter-spacing:-0.01em;">
        ${esc(headline)}
      </div>
      ${subtitle
        ? `<div style="font-size:13px;font-weight:500;color:#9ca3af;line-height:1.3;margin-top:3px;margin-bottom:10px;">${esc(subtitle)}</div>`
        : `<div style="margin-bottom:10px;"></div>`}`;

  return `
    <div style="padding:22px 24px;margin-bottom:14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;">
      ${headlineBlock}
      <div style="margin-bottom:12px;">
        ${velocity}${category}${firstMacro}
      </div>
      <div style="font-size:14px;color:#4b5563;line-height:1.6;">
        ${summary}
      </div>
      ${sourcesHtml}
    </div>`;
};

// ---------- main component ----------

export default defineComponent({
  props: {
    dashboard_rows: {
      type: "any",
      label: "V_TREND_DASHBOARD rows (NEW + GROWING)",
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];

    const dateStr = fmtDate(new Date());
    const subject = `Trend Insights Daily — ${dateStr}`;

    const risingCount = rows.filter((r) => {
      const v = String(r.VELOCITY_DIRECTION ?? "").toUpperCase();
      return v === "NEW" || v === "GROWING";
    }).length;
    const fillerCount = rows.length - risingCount;

    const countBlurb = risingCount === 0
      ? `${rows.length} top ${rows.length === 1 ? "trend" : "trends"} by heat`
      : fillerCount > 0
        ? `${risingCount} new and rising, plus ${fillerCount} top by heat`
        : `${risingCount} new and rising ${risingCount === 1 ? "trend" : "trends"}`;

    const header = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
        <tr>
          <td align="left" style="font-size:12px;color:#6b7280;font-weight:600;letter-spacing:.12em;text-transform:uppercase;">
            Trend Insights Daily
          </td>
          <td align="right">
            <a href="${esc(DASHBOARD_URL)}" style="font-size:12px;color:#2563eb;text-decoration:none;font-weight:600;">Open dashboard ›</a>
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:6px;font-size:24px;font-weight:700;color:#111827;letter-spacing:-0.02em;">
            ${esc(dateStr)}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding-top:4px;font-size:13px;color:#6b7280;">
            ${countBlurb}
          </td>
        </tr>
      </table>`;

    // Empty-state short-circuit.
    if (rows.length === 0) {
      const emptyHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:48px 20px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    ${header}
    <div style="padding:32px 24px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">
      <div style="font-size:15px;color:#4b5563;">No new or rising trends right now.</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:6px;">The digest will resume once fresh enrichment output lands in V_TREND_DASHBOARD.</div>
    </div>
  </div>
</body></html>`;
      $.export("$summary", `${subject} — empty`);
      return { subject, html_body: emptyHtml };
    }

    // Rising trends first (bucket 0), filler top-heat trends after (bucket 1);
    // within each bucket, sort by heat desc.
    const isRising = (r) => {
      const v = String(r.VELOCITY_DIRECTION ?? "").toUpperCase();
      return v === "NEW" || v === "GROWING";
    };
    const cards = rows
      .slice()
      .sort((a, b) => {
        const ra = isRising(a) ? 0 : 1;
        const rb = isRising(b) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (b.HEAT_INDEX ?? 0) - (a.HEAT_INDEX ?? 0);
      })
      .map(renderCard)
      .join("");

    const html_body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr><td>${header}</td></tr>
          <tr><td>${cards}</td></tr>
          <tr>
            <td style="padding:24px 4px 8px 4px;text-align:center;font-size:11px;color:#9ca3af;">
              Generated by Trend Tree · ${esc(dateStr)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    $.export("$summary", `${subject} — ${rows.length} cards`);
    return { subject, html_body };
  },
});
