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

// ---------- digest ordering ----------
//
// NEW always sorts to the very top — those are what readers scan for — then
// other rising statuses (GROWING/RESURGENT), then everything else (filler).
// Heat breaks ties within a tier. This single comparator backs both the
// subject-line top-3 and the card render order so they can't drift apart.
const velocityRank = (r) => {
  const v = String(r?.VELOCITY_DIRECTION ?? "").toUpperCase();
  if (v === "NEW") return 0;
  if (v === "GROWING" || v === "RESURGENT") return 1;
  return 2;
};

// "Rising" = new or moving (tiers 0-1); drives the subject/count copy.
const isRising = (r) => velocityRank(r) < 2;

// NEW is the headline tier — counted separately so the subject/header can
// lead with "N new" rather than lumping NEW in with GROWING/RESURGENT.
const isNew = (r) => velocityRank(r) === 0;

const byTierThenHeat = (a, b) =>
  velocityRank(a) - velocityRank(b) || (b.HEAT_INDEX ?? 0) - (a.HEAT_INDEX ?? 0);

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

// TOP_SIGNALS is the enrichment agent's curated source list for the card.
// Top up from EVIDENCE (deduped by URL) when fewer than 3 are available.
// Shared by the HTML card and the plaintext renderer so both show the same
// sources.
const topSignalsFor = (row) => {
  const topRaw = (parseVariant(row.TOP_SIGNALS) || []).filter((s) => s && (s.url || s.URL));
  const seenUrls = new Set(topRaw.map((s) => s.url || s.URL));
  const evidenceTopUp = (parseVariant(row.EVIDENCE) || [])
    .filter((ev) => ev && ev.url && !seenUrls.has(ev.url))
    .map((ev) => ({ url: ev.url, title: ev.claim || ev.source, source: ev.source }));
  return [...topRaw, ...evidenceTopUp].slice(0, 3);
};

const relatedNamesFor = (row) => (parseVariant(row.RELATED_TRENDS) || [])
  .slice(0, 2)
  .map((r) => r.trend_name || r.TREND_NAME)
  .filter(Boolean);

// Tier labels for the section dividers, indexed by velocityRank
// (0=NEW, 1=GROWING/RESURGENT, 2=filler).
const TIER_LABELS = ["New today", "Also rising", "Top by heat"];

// A section divider: small uppercase label over a hairline rule. Groups the
// cards by lifecycle tier so the NEW-first ordering reads at a glance.
const sectionHeader = (label) =>
  `<div style="margin:8px 2px 12px;padding-bottom:8px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.1em;text-transform:uppercase;">${esc(label)}</div>`;

// Prefer-light hints. Best-effort — Gmail/Outlook.com still force-invert in
// dark mode regardless — but this stops well-behaved clients (Apple Mail,
// Outlook desktop) from auto-darkening the light palette.
const HEAD_META = `<meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <style>:root{color-scheme:light;supported-color-schemes:light;}</style>`;

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

  const topSignals = topSignalsFor(row);
  const sourcesHtml = topSignals.length > 0
    ? `<div style="margin-top:14px;">
         <div style="font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px;">Sources</div>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
           ${topSignals.map(sourceRow).join("")}
         </table>
       </div>`
    : "";

  const relatedNames = relatedNamesFor(row);
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

// Plaintext counterpart of renderCard — the MIME text/plain alternative.
// Same fields, no markup: headline, optional B2B subtitle, a meta line,
// summary, sources (title + bare URL), related.
const renderCardText = (row) => {
  const headline = row.TREND_NAME ?? "(untitled trend)";
  const b2b = row.TREND_NAME_B2B || null;
  const subtitle = b2b && b2b !== headline ? b2b : null;

  const status = row.VELOCITY_DIRECTION ? prettifyToken(row.VELOCITY_DIRECTION) : "";
  const heatVal = Number(row.HEAT_INDEX);
  const heat = row.HEAT_INDEX != null && !Number.isNaN(heatVal)
    ? `Heat ${heatVal.toFixed(1)}`
    : "";
  const cat = [row.CATEGORY, row.SUBCATEGORY].filter(Boolean).map(prettifyToken).join(" / ");
  const meta = [status, heat, cat].filter(Boolean).join(" · ");

  const summary = String(row.SUMMARY_SHORT ?? "").trim();

  const sourceLines = topSignalsFor(row)
    .map((s) => {
      const url = s.url ?? s.URL;
      const title = s.title ?? s.TITLE ?? s.source ?? s.SOURCE ?? url;
      return `  - ${title}\n    ${url}`;
    })
    .join("\n");

  const related = relatedNamesFor(row);

  const lines = [headline];
  if (subtitle) lines.push(`(${subtitle})`);
  if (meta) lines.push(meta);
  if (summary) lines.push(summary);
  if (sourceLines) lines.push(`Sources:\n${sourceLines}`);
  if (related.length) lines.push(`Related: ${related.join(" · ")}`);
  return lines.join("\n");
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
    preheader: {
      type: "string",
      label: "AI-generated short editorial preheader (≤85 chars)",
      optional: true,
    },
  },
  async run({ $ }) {
    const rows = Array.isArray(this.dashboard_rows) ? this.dashboard_rows : [];
    const introText = String(this.intro ?? "").trim();
    const preheaderEditorial = String(this.preheader ?? "").trim();

    const dateStr = fmtDate(new Date());
    const shortDate = fmtDateShort(new Date());

    const risingCount = rows.filter(isRising).length;
    const newCount = rows.filter(isNew).length;
    const otherRisingCount = risingCount - newCount; // GROWING / RESURGENT
    const fillerCount = rows.length - risingCount;

    // Pick the top 3 names for the subject in the same order the cards
    // render: NEW first, then other rising, then filler; heat desc within tier.
    const topNames = rows
      .slice()
      .sort(byTierThenHeat)
      .slice(0, 3)
      .map((r) => r.TREND_NAME)
      .filter(Boolean)
      .join(", ");

    // Lead the count copy with NEW — that's the tier readers scan for — and
    // only name "rising" for the GROWING/RESURGENT remainder. Shared by the
    // subject line and the header/preheader blurb so they stay in step.
    // Yields "2 new + 3 rising", "2 new", or "3 rising" (only used when
    // risingCount > 0).
    const risingNoun = risingCount === 1 ? "trend" : "trends";
    const risingPhrase = newCount > 0 && otherRisingCount > 0
      ? `${newCount} new + ${otherRisingCount} rising`
      : newCount > 0
        ? `${newCount} new`
        : `${otherRisingCount} rising`;

    // Subject names what's in this issue, leading with new. Friendly-from
    // already says "Trend Digest" so the wordmark isn't repeated.
    const subject = rows.length === 0
      ? `Trend Digest · ${shortDate}`
      : risingCount > 0
        ? `${risingPhrase} ${risingNoun}: ${topNames}`
        : `${rows.length} top ${rows.length === 1 ? "trend" : "trends"}: ${topNames}`;

    const countBlurb = risingCount === 0
      ? `${rows.length} top ${rows.length === 1 ? "trend" : "trends"} by heat`
      : fillerCount > 0
        ? `${risingPhrase}, plus ${fillerCount} top by heat`
        : `${risingPhrase} ${risingNoun}`;

    const introHtml = introText
      ? `<div style="margin:0 0 24px;padding:18px 22px;background:#ffffff;border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:8px;font-size:14px;line-height:1.6;color:#1f2937;font-style:italic;">
           ${esc(introText)}
         </div>`
      : "";

    // Hidden preheader — the short inbox-preview line shown after the
    // subject in Gmail/Outlook/Apple Mail. Prefers the AI-generated
    // editorial teaser; falls back to the count blurb if Gemini failed.
    const preheaderText = preheaderEditorial || countBlurb;
    const preheaderHtml = `<div style="display:none;font-size:1px;color:#fafafa;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheaderText)}</div>`;

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
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${HEAD_META}
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:48px 20px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  ${preheaderHtml}
  <div style="max-width:600px;margin:0 auto;">
    ${header}
    <div style="padding:32px 24px;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">
      <div style="font-size:15px;color:#4b5563;">No new or rising trends right now.</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:6px;">The digest will resume once fresh enrichment output lands in DT_TREND_DASHBOARD.</div>
    </div>
  </div>
</body></html>`;
      const emptyText = [
        "TREND INSIGHTS DAILY",
        dateStr,
        "",
        "No new or rising trends right now.",
        "The digest will resume once fresh enrichment output lands.",
        "",
        "--",
        `Open dashboard: ${DASHBOARD_URL}`,
      ].join("\n");
      $.export("$summary", `${subject} — empty`);
      return { subject, html_body: emptyHtml, text_body: emptyText };
    }

    // Sort NEW-first, then bucket by lifecycle tier so each tier can get its
    // own section divider ("New today" / "Also rising" / "Top by heat"). One
    // grouping feeds both the HTML cards and the plaintext body.
    const sorted = rows.slice().sort(byTierThenHeat);
    const tierGroups = [0, 1, 2].map((tier) => sorted.filter((r) => velocityRank(r) === tier));

    const sections = tierGroups
      .map((group, tier) => (group.length
        ? sectionHeader(TIER_LABELS[tier]) + group.map(renderCard).join("")
        : ""))
      .join("");

    const textSections = tierGroups
      .map((group, tier) => (group.length
        ? `== ${TIER_LABELS[tier].toUpperCase()} ==\n\n${group.map(renderCardText).join("\n\n")}`
        : ""))
      .filter(Boolean)
      .join("\n\n\n");

    // Plaintext MIME alternative — deliverability + watch/notification/screen
    // reader fallback. Mirrors the HTML: masthead, count blurb, optional
    // editorial intro, then the same tiered sections.
    const textParts = ["TREND INSIGHTS DAILY", dateStr, countBlurb];
    if (introText) textParts.push("", introText);
    textParts.push(
      "",
      textSections,
      "",
      "--",
      `Open dashboard: ${DASHBOARD_URL}`,
      `Generated by Trend Tree · ${dateStr}`,
    );
    const text_body = textParts.join("\n");

    const html_body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${HEAD_META}
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
  ${preheaderHtml}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <tr><td>${header}</td></tr>
          ${introHtml ? `<tr><td>${introHtml}</td></tr>` : ""}
          <tr><td>${sections}</td></tr>
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
    return { subject, html_body, text_body };
  },
});
