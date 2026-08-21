// sourcing_run.mjs — the ecomm-agent sourcing-run core (CRMA-776, epic
// CRMA-772 "Trend-to-product sourcing").
//
// Pure functions only: no I/O, no Snowflake, no fetch, no Gemini call. Takes
// the retrieval pool the workflow already fetched and the selector's raw
// emit tool payload and derives the exact ledger write plan the workflow
// hands to PROC_SOURCING_APPLY's 'complete' call — the three-state header
// outcome (matched | no_match | failed) plus the full candidate-row list
// (picks AND rejects, rejects carrying SELECTED=false and NULL
// REASONED_FIT per fct_trend_sourcing_candidates.sql).
//
// =====================================================================
// IMPORTANT: This file is the SOURCE OF TRUTH. Pipedream GitHub-synced
// workflows do not bundle cross-file imports (see the pipedream-synced-
// project skill), so the deployed copy is INLINED in two places:
//   - ecomm-agent/run_sourcing/entry.mjs (the whole module: floor/TOP_N,
//     buildSourcingRunPlan, prompt formatting)
//   - ecomm-agent/fetch_context/entry.mjs (just checkCatalogFreshness,
//     as checkFreshness())
// Keep all three in exact sync. This module exists so the core logic can
// be unit-tested (sourcing_run.test.mjs) without the Pipedream runtime,
// mirroring agents/lib/promotion_gate.mjs's role for the promotion lead.
// =====================================================================
//
// Design decisions worth flagging (see the CRMA-776 report for the full
// reasoning):
//   - An EMPTY retrieval pool short-circuits to outcome='no_match' WITHOUT
//     ever calling the selector — there is nothing for a filter to judge.
//     This is the common case against the current 187-product Shopify
//     catalog (most trends have no candidate at or above the 0.40 floor).
//   - A hallucinated catalog_product_id (not in the shown pool) or an
//     invalid reasoned_fit enum value on one pick does NOT fail the whole
//     run — that single pick is dropped and recorded in `warnings`, never
//     silently trusted. If EVERY pick in an outcome='matched' emission
//     turns out invalid, the run is 'failed' (not 'no_match') — a
//     malformed emission is a distinct, operator-visible condition from a
//     genuine "the model judged nothing fits" verdict, and conflating the
//     two would hide a selector/prompt bug behind the ordinary shrug case.
//   - picks.length > slots is enforced by truncation (keep the first
//     `slots` valid picks, in the order the model emitted them) plus a
//     warning — the model violating "at most {slots}" is a soft contract
//     slip, not data corruption, so the run still completes.

export const SEMANTIC_THRESHOLD = 0.40;
export const TOP_N = 10;

// Slots for THIS single-tier (Shopify-only) build. The PRD's multi-tier
// top-up contract (slots-remaining = MAX_SOURCED_PRODUCTS minus picks
// already taken by higher tiers) is specified but not implemented — no
// second tier exists yet, so slots === MAX_SOURCED_PRODUCTS always here.
// Named (not inlined as a bare 5) so the future top-up story finds it fast.
export const MAX_SOURCED_PRODUCTS = 5;

export const CATALOG_FRESHNESS_MAX_DAYS = 7;

export const VALID_REASONED_FIT = new Set(["strong", "partial", "weak"]);

// Prompted guidance is "one sentence, max 25 words" — this cap is a
// generous safety net (~5x that in characters), not an attempt to enforce
// the word limit. A verbose rationale is trimmed, never a rejection
// reason; only emptiness/absence and the hallucination/enum checks reject
// a pick.
export const RATIONALE_MAX_CHARS = 400;

// Candidates shown to the selector carry the embed doc capped to this
// length (CRMA-754 prototype contract: "the selector judges exactly the
// text retrieval matched on").
export const CANDIDATE_EMBED_DOC_CAP = 700;

// ---------------------------------------------------------------------------
// Catalog freshness gate
// ---------------------------------------------------------------------------

// maxLastSeenAt: the catalog's MAX(LAST_SEEN_AT) over CATALOG_STATUS='active'
// rows for the tier — a Date, an ISO string, or null/undefined (no active
// rows at all, which is treated the same as "stale": nothing to source
// against). Returns { fresh, ageDays, reason } — reason is null when fresh.
export function checkCatalogFreshness(maxLastSeenAt, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeDays = options.maxAgeDays ?? CATALOG_FRESHNESS_MAX_DAYS;

  if (maxLastSeenAt === null || maxLastSeenAt === undefined || maxLastSeenAt === "") {
    return { fresh: false, ageDays: null, reason: "catalog has no active rows (MAX(LAST_SEEN_AT) is null)" };
  }

  const seenAt = maxLastSeenAt instanceof Date ? maxLastSeenAt : new Date(maxLastSeenAt);
  if (Number.isNaN(seenAt.getTime())) {
    return { fresh: false, ageDays: null, reason: `unparseable catalog LAST_SEEN_AT: ${String(maxLastSeenAt)}` };
  }

  const ageDaysRaw = (now.getTime() - seenAt.getTime()) / (1000 * 60 * 60 * 24);
  const ageDays = Math.round(ageDaysRaw * 100) / 100;
  const fresh = ageDaysRaw <= maxAgeDays;

  return {
    fresh,
    ageDays,
    reason: fresh
      ? null
      : `catalog MAX(LAST_SEEN_AT) is ${ageDays} days old, exceeds the ${maxAgeDays}-day freshness gate`,
  };
}

// ---------------------------------------------------------------------------
// Retrieval pool — defense-in-depth re-application of floor/TOP_N
// ---------------------------------------------------------------------------

// The retrieval SQL should already apply the 0.40 floor, sort
// score-descending, and LIMIT 10 — this re-applies all three so the plan
// never trusts a caller-supplied pool blindly (e.g. a future retrieval
// refactor that forgets the WHERE clause doesn't silently widen what the
// selector sees or what gets persisted).
export function applyFloorAndTopN(pool, options = {}) {
  const threshold = options.threshold ?? SEMANTIC_THRESHOLD;
  const topN = options.topN ?? TOP_N;
  return (Array.isArray(pool) ? pool : [])
    .filter((c) => c && typeof c.semantic_score === "number" && Number.isFinite(c.semantic_score) && c.semantic_score >= threshold)
    .sort((a, b) => b.semantic_score - a.semantic_score)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Prompt formatting — candidates as shown to the selector (no raw scores)
// ---------------------------------------------------------------------------

export function capEmbedDoc(doc, capLen = CANDIDATE_EMBED_DOC_CAP) {
  const s = doc === null || doc === undefined ? "" : String(doc);
  return s.length > capLen ? s.slice(0, capLen) : s;
}

// pool entries: { catalog_product_id, embed_doc, semantic_score, ... }.
// Returns the numbered candidate block for the user message — score-
// descending (the pool is expected to already be in that order; this does
// NOT re-sort, so the caller's chosen order is what the model sees), one
// line per candidate, embed doc capped, no score shown.
export function formatCandidatesForPrompt(pool) {
  return (Array.isArray(pool) ? pool : [])
    .map((c, i) => `${i + 1}. catalog_product_id: ${c.catalog_product_id}\n   ${capEmbedDoc(c.embed_doc)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Selector emit -> ledger write plan
// ---------------------------------------------------------------------------

function trimRationale(raw, capLen = RATIONALE_MAX_CHARS) {
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s) return "";
  return s.length > capLen ? s.slice(0, capLen) : s;
}

// { pool, selectorEmit, slots } -> {
//   outcome: 'matched' | 'no_match' | 'failed',
//   selector_note: string | null,
//   error_message: string | null,
//   candidates: [...] ready for PROC_SOURCING_APPLY('complete', ..., candidates),
//   warnings: string[]   -- telemetry only, never persisted to the ledger
// }
//
// `pool` entries are expected to carry everything PROC_SOURCING_APPLY's
// candidate shape needs except selected/reasoned_fit/reasoned_fit_rationale
// (those come from the selector): catalog_product_id, product_handle,
// product_title, product_type, vendor, product_url, price_at_match,
// image_url_at_match, available_at_match, semantic_score, catalog_payload.
//
// `selectorEmit` is the raw propose_product_selection tool-call args (or
// null/undefined if the selector was never called, or a malformed object if
// the model's emission couldn't be parsed) — { outcome, picks, pool_note }.
export function buildSourcingRunPlan({ pool, selectorEmit, slots = MAX_SOURCED_PRODUCTS } = {}) {
  const safePool = applyFloorAndTopN(pool);
  const poolById = new Map(safePool.map((c) => [String(c.catalog_product_id), c]));
  const warnings = [];

  // Nothing to judge — the selector was never a factor. This is the common
  // case against the current catalog and is NOT a failure.
  if (safePool.length === 0) {
    return {
      outcome: "no_match",
      selector_note: "Retrieval found zero candidates at or above the similarity floor in the active catalog.",
      error_message: null,
      candidates: [],
      warnings,
    };
  }

  if (!selectorEmit || typeof selectorEmit !== "object") {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: "selector produced no usable emission (missing, non-object, or the call itself errored)",
      candidates: [],
      warnings,
    };
  }

  const rawOutcome = selectorEmit.outcome;
  if (rawOutcome !== "matched" && rawOutcome !== "no_match") {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: `selector emitted an invalid outcome: ${JSON.stringify(rawOutcome)}`,
      candidates: [],
      warnings,
    };
  }

  const poolNote = selectorEmit.pool_note === null || selectorEmit.pool_note === undefined
    ? ""
    : String(selectorEmit.pool_note).trim();

  if (rawOutcome === "no_match") {
    return {
      outcome: "no_match",
      selector_note: poolNote || "Selector found no candidate serving the trend.",
      error_message: null,
      candidates: [],
      warnings,
    };
  }

  // rawOutcome === 'matched'
  const rawPicks = Array.isArray(selectorEmit.picks) ? selectorEmit.picks : [];
  if (rawPicks.length === 0) {
    return {
      outcome: "failed",
      selector_note: null,
      error_message: "selector emitted outcome=matched with an empty picks list (contract violation — use outcome=no_match for a refusal)",
      candidates: [],
      warnings,
    };
  }

  const validPicks = [];
  for (const pick of rawPicks) {
    const id = pick && pick.catalog_product_id !== null && pick.catalog_product_id !== undefined
      ? String(pick.catalog_product_id)
      : "";
    if (!id || !poolById.has(id)) {
      warnings.push(`hallucinated_pick:${id || "(missing catalog_product_id)"}`);
      continue;
    }
    if (!VALID_REASONED_FIT.has(pick.reasoned_fit)) {
      warnings.push(`invalid_reasoned_fit:${id}:${JSON.stringify(pick.reasoned_fit)}`);
      continue;
    }
    validPicks.push({ id, reasoned_fit: pick.reasoned_fit, rationale: trimRationale(pick.rationale) });
  }

  // De-dup: guard against the model echoing the same catalog_product_id
  // twice (each row in the ledger must be unique per SOURCING_RUN_ID).
  const seen = new Set();
  let deduped = [];
  for (const p of validPicks) {
    if (seen.has(p.id)) {
      warnings.push(`duplicate_pick:${p.id}`);
      continue;
    }
    seen.add(p.id);
    deduped.push(p);
  }

  if (deduped.length > slots) {
    const dropped = deduped.length - slots;
    deduped = deduped.slice(0, slots);
    warnings.push(`picks_exceeded_slots:dropped_${dropped}`);
  }

  if (deduped.length === 0) {
    // Every pick was hallucinated / invalid-enum / duplicate. This is a
    // malformed emission, not a legitimate "nothing fits" verdict — keep it
    // distinguishable from outcome='no_match' so an operator can tell a
    // selector bug from an honest refusal.
    return {
      outcome: "failed",
      selector_note: null,
      error_message: `selector emitted outcome=matched but every pick was invalid: ${warnings.join("; ")}`,
      candidates: [],
      warnings,
    };
  }

  const pickedById = new Map(deduped.map((p) => [p.id, p]));
  const candidates = safePool.map((c) => {
    const cid = String(c.catalog_product_id);
    const picked = pickedById.get(cid) || null;
    return {
      catalog_product_id: c.catalog_product_id,
      product_handle: c.product_handle ?? null,
      product_title: c.product_title ?? null,
      product_type: c.product_type ?? null,
      vendor: c.vendor ?? null,
      product_url: c.product_url ?? null,
      price_at_match: c.price_at_match ?? null,
      image_url_at_match: c.image_url_at_match ?? null,
      available_at_match: c.available_at_match ?? null,
      semantic_score: c.semantic_score,
      selected: !!picked,
      reasoned_fit: picked ? picked.reasoned_fit : null,
      reasoned_fit_rationale: picked ? (picked.rationale || null) : null,
      catalog_payload: c.catalog_payload ?? null,
    };
  });

  return {
    outcome: "matched",
    selector_note: poolNote || null,
    error_message: null,
    candidates,
    warnings,
  };
}
