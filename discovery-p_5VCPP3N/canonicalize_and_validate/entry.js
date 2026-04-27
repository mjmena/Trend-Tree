// Discovery — canonicalize_and_validate
//
// HEAD-resolves each proposal's evidence_url to its canonical form,
// strips tracking params, drops 4xx URLs (LLM hallucinations / dead
// links), and dedupes within-batch. Outputs signals_json ready for
// MERGE_EXTERNAL_SIGNALS to insert into STG_EXTERNAL_SIGNALS.
//
// Each proposal becomes one row with:
//   SIGNAL_ID    = canonical URL (slice-4 dedup key — collisions across
//                  models/sources skip on MERGE)
//   SOURCE_NAME  = 'agent_<model>_discovery' (e.g. agent_gemini_discovery)
//
// =====================================================================
// Inlined helpers (canonical: agents/lib/url_canon.mjs)
// =====================================================================

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_brand", "utm_social",
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid",
  "ref", "ref_src", "ref_url", "referrer",
  "_ga", "_gl", "_gac",
  "yclid", "wbraid", "gbraid",
  "igshid", "twclid",
]);

const PER_DOMAIN_STRIP = {
  "amazon.com": new Set(["psc", "th", "linkCode", "linkId", "tag", "ref_", "qid", "sr"]),
  "youtube.com": new Set(["si", "feature"]),
  "youtu.be":    new Set(["si"]),
};

function stripAndNormalize(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const domainParams = PER_DOMAIN_STRIP[u.hostname] || PER_DOMAIN_STRIP[u.hostname.replace(/^[^.]+\./, "")];
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k) || (domainParams && domainParams.has(k))) u.searchParams.delete(k);
  }
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  s = s.replace(/\?$/, "");
  return s;
}

async function canonicalizeContentUrl(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let resp;
    try {
      resp = await fetch(rawUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    } catch (e) {
      resp = await fetch(rawUrl, { method: "GET", redirect: "follow", signal: ctrl.signal });
    }
    const finalUrl = resp.url || rawUrl;
    const canonical = stripAndNormalize(finalUrl);
    return { canonical, http_status: resp.status };
  } catch (e) {
    return { canonical: null, http_status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Step entrypoint
// =====================================================================

export default defineComponent({
  props: {
    proposals: { type: "any", label: "rerank_claude output" },
  },
  async run({ $ }) {
    const kept = this.proposals?.kept_proposals || [];
    if (kept.length === 0) {
      console.log("No proposals to canonicalize");
      $.export("$summary", "0 proposals → 0 signals");
      return { signals_json: "[]", signal_count: 0, dropped_404: 0, dropped_dupe: 0, dropped_invalid: 0 };
    }

    // HEAD-resolve all URLs in parallel (5s timeout each).
    const resolved = await Promise.all(kept.map(async (p) => {
      if (!p.evidence_url) return { ...p, _canonical: null, _http_status: 0, _drop_reason: "missing_url" };
      const r = await canonicalizeContentUrl(p.evidence_url, { timeoutMs: 5000 });
      if (!r.canonical) return { ...p, _canonical: null, _http_status: r.http_status, _drop_reason: r.error ? `error:${r.error}` : "no_canonical" };
      if (r.http_status >= 400) return { ...p, _canonical: r.canonical, _http_status: r.http_status, _drop_reason: `http_${r.http_status}` };
      return { ...p, _canonical: r.canonical, _http_status: r.http_status, _drop_reason: null };
    }));

    // Dedupe within batch on canonical URL — keep highest-scored.
    const byUrl = new Map();
    let dropped404 = 0, droppedInvalid = 0, droppedDupe = 0;
    for (const r of resolved) {
      if (r._drop_reason) {
        if (r._drop_reason.startsWith("http_4")) dropped404++;
        else droppedInvalid++;
        continue;
      }
      const existing = byUrl.get(r._canonical);
      if (!existing || r.score > existing.score) {
        if (existing) droppedDupe++;
        byUrl.set(r._canonical, r);
      } else {
        droppedDupe++;
      }
    }

    const now = new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
    const signals = [];
    for (const r of byUrl.values()) {
      signals.push({
        SIGNAL_ID: r._canonical,
        SOURCE_NAME: `agent_${r.source_model}_discovery`,
        SIGNAL_TIMESTAMP: now,
        SIGNAL_TITLE: r.topic,
        SIGNAL_TEXT: `${r.topic} — ${r.why_now}`,
        URL: r._canonical,
        METADATA: JSON.stringify({
          source_model: r.source_model,
          source_model_full: r.source_model_full,
          rerank_score: r.score,
          rerank_reasoning: r.reasoning,
          why_now: r.why_now,
          vertical: r.vertical || null,
          original_url: r.evidence_url,
          canonical_url: r._canonical,
          http_status: r._http_status,
        }),
      });
    }

    console.log(
      `Canonicalize: ${kept.length} kept → ${signals.length} signals ` +
      `(${dropped404} 4xx, ${droppedDupe} dupe, ${droppedInvalid} invalid)`,
    );
    $.export("$summary", `${signals.length} signals (${kept.length}→: ${dropped404}4xx ${droppedDupe}dupe ${droppedInvalid}invalid)`);

    return {
      signals_json: JSON.stringify(signals),
      signal_count: signals.length,
      dropped_404: dropped404,
      dropped_dupe: droppedDupe,
      dropped_invalid: droppedInvalid,
    };
  },
});
