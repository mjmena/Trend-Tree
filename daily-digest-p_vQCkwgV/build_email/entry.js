// Pipedream Workflow Step: Build Email
//
// Renders a light-themed HTML digest of NEW + GROWING trends from DT_TREND_DASHBOARD
// and returns { subject, html_body } for the downstream braze_send step.
//
// Layout (light):
//   - Slim header: wordmark + date
//   - Single list of trend cards, sorted by heat desc
//   - Each card: name, category + velocity chips, summary, sources list (title → URL)

const DASHBOARD_URL = "https://staging-insights-agent.trendhunteragents.ai/trends";
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

const fmtDateShort = (d) => new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: TIMEZONE,
}).format(d);

// snake_case → Title Case (e.g. "mineral_sunscreen" → "Mineral Sunscreen").
const prettifyToken = (s) => String(s ?? "")
  .replace(/[_-]+/g, " ")
  .trim()
  .replace(/\s+/g, " ")
  .split(" ")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(" ");

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
    return chip("Growing", { bg: "#ecfdf5", fg: "#047857", border: "#a7f3d0" });
  }
  if (v === "RESURGENT") {
    return chip("Resurgent", { bg: "#fefce8", fg: "#a16207", border: "#fde68a" });
  }
  if (v === "STABLE") return chip("Stable");
  if (v === "DORMANT") {
    return chip("Dormant", { bg: "#f3f4f6", fg: "#6b7280", border: "#e5e7eb" });
  }
  if (v === "RETIRED") {
    return chip("Retired", { bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" });
  }
  // Legacy values still present in older lifecycle rows.
  if (v === "STAGNANT") return chip("Stagnant");
  if (v === "DECLINING") {
    return chip("Declining", { bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" });
  }
  return chip(prettifyToken(v));
};

const heatChip = (heat) => {
  if (heat == null || Number.isNaN(Number(heat))) return "";
  const h = Number(heat);
  const label = `Heat ${h.toFixed(1)}`;
  if (h >= 75) {
    return chip(label, { bg: "#fff7ed", fg: "#c2410c", border: "#fed7aa" });
  }
  if (h >= 50) {
    return chip(label, { bg: "#fefce8", fg: "#a16207", border: "#fde68a" });
  }
  return chip(label);
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
  // TREND_NAME is the B2C-first coalesced headline from DT_TREND_DASHBOARD
  // (COALESCE(B2C, B2B, topic)). B2B is shown as a muted subtitle when it
  // exists and differs from the headline.
  const headline = row.TREND_NAME ?? "(untitled trend)";
  const b2b = row.TREND_NAME_B2B || null;
  const subtitle = b2b && b2b !== headline ? b2b : null;

  const summary = esc(row.SUMMARY_SHORT ?? "");
  const category = row.CATEGORY ? chip(prettifyToken(row.CATEGORY)) : "";
  const subcategory = row.SUBCATEGORY ? chip(prettifyToken(row.SUBCATEGORY)) : "";
  const macroTags = parseVariant(row.MACROTREND_TAGS) || [];
  const firstMacro = Array.isArray(macroTags) && macroTags.length > 0
    ? chip(prettifyToken(macroTags[0]))
    : "";
  const velocity = velocityChip(row.VELOCITY_DIRECTION);
  const heat = heatChip(row.HEAT_INDEX);

  // TOP_SIGNALS is the enrichment agent's curated source list for the card.
  // Top up from EVIDENCE (deduped by URL) when fewer than 3 are available.
  const topRaw = (parseVariant(row.TOP_SIGNALS) || []).filter((s) => s && (s.url || s.URL));
  const seenUrls = new Set(topRaw.map((s) => s.url || s.URL));
  const evidenceTopUp = (parseVariant(row.EVIDENCE) || [])
    .filter((ev) => ev && ev.url && !seenUrls.has(ev.url))
    .map((ev) => ({ url: ev.url, title: ev.claim || ev.source, source: ev.source }));
  const topSignals = [...topRaw, ...evidenceTopUp].slice(0, 3);
  const sourcesHtml = topSignals.length > 0
    ? `<div style="margin-top:14px;">
         <div style="font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px;">Sources</div>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
           ${topSignals.map(sourceRow).join("")}
         </table>
       </div>`
    : "";

  const relatedNames = (parseVariant(row.RELATED_TRENDS) || [])
    .slice(0, 2)
    .map((r) => r.trend_name || r.TREND_NAME)
    .filter(Boolean);
  const relatedHtml = relatedNames.length
    ? `<p style="margin:10px 0 0;font-size:12px;color:#9ca3af;line-height:1.5;">Related: ${relatedNames.map(esc).join(" · ")}</p>`
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
        ${velocity}${heat}${category}${subcategory}${firstMacro}
      </div>
      <div style="font-size:14px;color:#4b5563;line-height:1.6;">
        ${summary}
      </div>
      ${sourcesHtml}
      ${relatedHtml}
    </div>`;
};

// ---------- main component ----------

export default defineComponent({
  props: {
    dashboard_rows: {
      type: "any",
      label: "DT_TREND_DASHBOARD rows (NEW + GROWING)",
    },
    intro: {
      type: "string",
      label: "AI-generated editorial intro (1-2 sentences)",
      optional: true,
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    const introText = String(this.intro ?? "").trim();

    const dateStr = fmtDate(new Date());
    const subject = `Trend Digest - ${fmtDateShort(new Date())}`;

    const risingCount = rows.filter((r) => {
      const v = String(r.VELOCITY_DIRECTION ?? "").toUpperCase();
      return v === "NEW" || v === "GROWING" || v === "RESURGENT";
    }).length;
    const fillerCount = rows.length - risingCount;

    const countBlurb = risingCount === 0
      ? `${rows.length} top ${rows.length === 1 ? "trend" : "trends"} by heat`
      : fillerCount > 0
        ? `${risingCount} new and rising, plus ${fillerCount} top by heat`
        : `${risingCount} new and rising ${risingCount === 1 ? "trend" : "trends"}`;

    const introHtml = introText
      ? `<div style="margin:0 0 24px;padding:18px 22px;background:#ffffff;border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:8px;font-size:14px;line-height:1.6;color:#1f2937;font-style:italic;">
           ${esc(introText)}
         </div>`
      : "";

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
      <div style="font-size:12px;color:#9ca3af;margin-top:6px;">The digest will resume once fresh enrichment output lands in DT_TREND_DASHBOARD.</div>
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
      return v === "NEW" || v === "GROWING" || v === "RESURGENT";
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
          ${introHtml ? `<tr><td>${introHtml}</td></tr>` : ""}
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
