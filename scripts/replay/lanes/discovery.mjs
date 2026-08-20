// Lane: the registry-driven discovery.gemini.search lane (CRMA-731).
//
// THIS LANE IS STRUCTURALLY DIFFERENT FROM EVERY OTHER ONE, and that
// difference is most of its decision. Every other lane pins its model in a
// `const MODEL` inside the step file, so moving it is a code change that
// ships through a Pipedream redeploy. This lane reads its model from
// DIM_LLM_PROMPT.MODEL at runtime, so moving it is an UPDATE statement —
// no deploy, no PR, effective on the next run, and reversible just as fast.
//
// Two consequences the lane ticket should weigh, neither of which shows up
// in an output diff:
//   - It is the cheapest lane in the fleet to try AND to roll back.
//   - It is the only lane where the running model can drift from the repo
//     without any commit, so whatever it is set to must be recorded
//     somewhere a reader of the code will actually look.
//
// The registry currently has this lane on gemini-2.5-flash, which is an
// OLDER model than the gemini-3-flash-preview the four hardcoded verticals
// run. The two discovery families have already drifted apart.
//
// Like the verticals, this lane is grounded in live Google Search and its
// prompt is dated today, so a historical run is not reproducible — compare
// both models fired now.

import { join } from "node:path";
import { readWorkflow, runStep } from "../lib/workflow.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { loadStep } from "../lib/entry_module.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const WF_DIR = "discovery-p_5VCPP3N";
const WORKFLOW = join(REPO_ROOT, WF_DIR, "workflow.yaml");
const CONTEXT_STEP = join(REPO_ROOT, WF_DIR, "build_discovery_context", "entry.js");
const GEMINI_STEP = join(REPO_ROOT, WF_DIR, "discover_gemini", "entry.js");
const CANON_STEP = join(REPO_ROOT, WF_DIR, "canonicalize_and_validate", "entry.js");

// canonicalize_and_validate/entry.js:287-289 — the step's own prop defaults.
const MAX_AGE_DAYS = 30;
const DROP_IF_NO_DATE = false;
const DROP_IF_TITLE_IRRELEVANT = true;

// Re-run of the drop decision at canonicalize_and_validate/entry.js:293-338,
// per proposal. This lane's verifier is STRICTER than the verticals'
// resolveAndVerify: it does a full GET and then also drops on staleness and
// on a title that shares no token with the proposed topic. CRMA-730 found
// 3.7 Flash citing bare homepages that passed a liveness-only check, so
// whether that failure survives THIS filter is the lane's decisive question.
async function verifyProposal(fns, p, nowMs) {
  const { fetchArticleMeta, titleOverlapsTopic } = fns;
  if (!p.evidence_url) return { drop_reason: "missing_url" };
  const r = await fetchArticleMeta(p.evidence_url, { timeoutMs: 8000 });
  if (!r.canonical) return { drop_reason: "no_canonical" };
  if (r.status_class === "dead") {
    return { canonical: r.canonical, http_status: r.http_status, drop_reason: `dead_${r.http_status || "x"}` };
  }
  const unverified = r.status_class !== "ok";
  const days = r.published_date
    ? Math.round((nowMs - new Date(r.published_date).getTime()) / 86400000)
    : null;
  const base = {
    canonical: r.canonical,
    http_status: r.http_status,
    status_class: r.status_class,
    unverified,
    article_title: r.article_title || null,
    published_date: r.published_date || null,
    days_since_published: days,
  };
  if (!unverified) {
    if (days != null && days > MAX_AGE_DAYS) return { ...base, drop_reason: `stale_${days}d` };
    if (!r.published_date && DROP_IF_NO_DATE) return { ...base, drop_reason: "no_date" };
    if (DROP_IF_TITLE_IRRELEVANT && r.article_title && !titleOverlapsTopic(p.topic, r.article_title)) {
      return { ...base, drop_reason: "title_irrelevant" };
    }
  }
  return { ...base, drop_reason: null };
}

/** A deep link carries a path; a bare homepage is the CRMA-730 failure mode. */
function isDeepLink(u) {
  try {
    const { pathname } = new URL(u);
    return pathname.replace(/\/+$/, "").length > 1;
  } catch {
    return false;
  }
}
const PROMPT_KEY = "discovery.gemini.search";

export const name = "discovery";
export const summary =
  "The one registry-driven lane: its model comes from DIM_LLM_PROMPT, so moving it is an UPDATE, not a deploy.";
export const incumbentModel = "gemini-2.5-flash";
export const ticket = "CRMA-731";
export const requiresRerun = true;

export async function cases({ limit = 1, caseId = null }) {
  const loaded = loadPrompts([PROMPT_KEY]);
  const p = loaded[PROMPT_KEY];

  // The shard list comes from the deployed step, not from this file.
  // discover_gemini/entry.js:94 falls back to ["consumer"] only when the
  // context step publishes nothing, and build_discovery_context always
  // publishes its six. Replaying "consumer" tests a vertical production
  // never sends, against a broad prompt the narrow shards do not produce.
  const { VERTICALS } = await loadStep(CONTEXT_STEP, ["VERTICALS"]);

  const picked = caseId ? [caseId] : VERTICALS.slice(0, limit);
  return picked.map((vertical) => ({
    id: vertical,
    label: `${PROMPT_KEY} v${p.version} · registry model ${p.model} · vertical "${vertical}"`,
    incumbentAt: null,
    // Registry rows are per-shard prompts, not per-run outputs, and the
    // signals this lane writes are merged in with every other discovery
    // source. There is no clean per-run incumbent to diff.
    incumbent: {
      emission: null,
      telemetry: { model: p.model, registry_driven: true, prompt_version: p.version },
    },
  }));
}

export async function build(c) {
  const { extractJsonArray } = await loadStep(GEMINI_STEP, ["extractJsonArray"]);
  const verifier = await loadStep(CANON_STEP, ["fetchArticleMeta", "titleOverlapsTopic"]);
  const wf = readWorkflow(WORKFLOW);
  const activeRows = runStep(wf, "q_load_active_trends", {});
  const exampleRows = runStep(wf, "q_load_examples", {});

  const loaded = loadPrompts([PROMPT_KEY]);
  const p = loaded[PROMPT_KEY];

  // build_discovery_context/entry.js:30-42
  const active_trends_formatted =
    activeRows.map((r, i) => `${i + 1}. ${r.TREND_TOPIC || "(untitled)"}`).join("\n") ||
    "(no active trends in last 30d)";

  const valuable_examples_formatted =
    exampleRows
      .map((r, i) => {
        const b2b = r.TREND_NAME_B2B || "";
        const b2c = r.TREND_NAME_B2C || "";
        const cat = `${r.CATEGORY || "?"}/${r.SUBCATEGORY || "?"}`;
        const summary = (r.SUMMARY_SHORT || "").replace(/\s+/g, " ").trim().slice(0, 240);
        return `${i + 1}. "${b2b}" / "${b2c}" — ${cat}: ${summary}`;
      })
      .join("\n") || "(no examples available)";

  const rendered = render(p.template, {
    active_trends: active_trends_formatted,
    valuable_examples: valuable_examples_formatted,
    vertical: c.id,
    current_date: new Date().toISOString().slice(0, 10),
  });

  return {
    mode: "single",
    system: null,
    contents: [{ parts: [{ text: rendered }] }],
    // Both come from MODEL_PARAMS in the registry, with the step's defaults.
    tools: p.params.tools ?? [{ google_search: {} }],
    temperature: p.params.temperature ?? 0.5,
    // discover_gemini/entry.js:104-108 sends `tools` and `temperature` and
    // nothing else. null here means omit the key, so the model applies its
    // own default — for 3.7 Flash that is thinking_level medium, which is
    // the level a switch would actually ship. Pinning "low" would price and
    // judge a call production never makes.
    thinkingLevel: null,
    maxOutputTokens: null,
    functionCallingMode: null,
    // The deployed extractor, loaded from the step — it is string- and
    // escape-aware, so a bracket inside a topic string does not truncate
    // the array. A simplified copy fails differently from production.
    parse: async (text) => {
      const arrText = extractJsonArray(String(text));
      if (!arrText) return null;
      let parsed;
      try {
        parsed = JSON.parse(arrText);
      } catch {
        return null;
      }
      if (!Array.isArray(parsed)) return null;
      // entry.js:121-123 — a proposal without a topic never leaves the step.
      const proposals = parsed.filter((x) => x && typeof x === "object" && x.topic);
      const nowMs = Date.now();
      const verified = [];
      for (const prop of proposals) {
        const v = await verifyProposal(verifier, prop, nowMs);
        verified.push({ ...prop, deep_link: isDeepLink(prop.evidence_url || ""), verify: v });
      }
      return { proposals: verified };
    },
    promptProvenance: provenance(loaded),
    notes: {
      registry_model: p.model,
      prompt_version: p.version,
      active_trends: activeRows.length,
      examples: exampleRows.length,
      vertical: c.id,
      how_to_switch: `UPDATE MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT SET MODEL='<id>' WHERE PROMPT_KEY='${PROMPT_KEY}' AND IS_ACTIVE=TRUE`,
      drift_note: "registry has this lane on gemini-2.5-flash while the hardcoded verticals run gemini-3-flash-preview",
    },
  };
}

export function compareRows(incumbent, candidate) {
  const a = incumbent?.emission?.proposals ?? [];
  const b = candidate?.emission?.proposals ?? [];

  const survivors = (x) => x.filter((p) => p.verify?.drop_reason == null);
  const deep = (x) => x.filter((p) => p.deep_link);
  // The CRMA-730 metric: proposals that are BOTH a deep link and survive
  // this lane's own verifier. Raw proposal count overstates every model.
  const usable = (x) => x.filter((p) => p.deep_link && p.verify?.drop_reason == null);
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "0/0 (—)");

  const bucket = (r) => String(r).replace(/^(dead|stale)_.*$/, "$1_*");
  const reasons = (x) => {
    const t = {};
    for (const p of x) {
      const r = p.verify?.drop_reason;
      if (r) t[bucket(r)] = (t[bucket(r)] || 0) + 1;
    }
    const e = Object.entries(t).sort((m, n) => n[1] - m[1]);
    return e.length ? e.map(([k, v]) => `${k}=${v}`).join(", ") : "none";
  };

  const titles = (x) =>
    x
      .map((t, i) => {
        const r = t.verify?.drop_reason;
        const mark = r ? `DROP ${r}` : t.deep_link ? "keep" : "keep, homepage";
        return `${i + 1}. [${mark}] ${t.topic ?? "(no topic)"}`;
      })
      .join("\n") || "—";

  const hosts = (x) =>
    [
      ...new Set(
        x
          .map((t) => {
            try {
              return new URL(t.evidence_url).host.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      ),
    ]
      .sort()
      .join(", ") || "—";

  return [
    { field: "proposals (raw)", left: a.length, right: b.length, note: "pre-filter; production never stores this many" },
    { field: "survive verifier", left: pct(survivors(a).length, a.length), right: pct(survivors(b).length, b.length) },
    { field: "deep links", left: pct(deep(a).length, a.length), right: pct(deep(b).length, b.length), note: "a bare homepage is the CRMA-730 failure mode" },
    { field: "USABLE (deep + survives)", left: pct(usable(a).length, a.length), right: pct(usable(b).length, b.length), note: "the decision metric" },
    { field: "drop reasons", left: reasons(a), right: reasons(b) },
    { field: "hosts", left: hosts(a), right: hosts(b) },
    { field: "titles", left: titles(a), right: titles(b) },
  ];
}

export default { name, summary, incumbentModel, ticket, requiresRerun, cases, build, compareRows };
