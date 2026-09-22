// Vendor-aware re-derivation of sourceFamilyOf() for CRMA-1231 ground-truth
// rule 4.
//
// agents/lib/promotion_gate.mjs's sourceFamilyOf() treats
// agent_gemini_discovery, gemini_food_drink, gemini_other, gemini_travel and
// gemini_wellness as FIVE distinct families, and agent_grok_discovery /
// grok_live as two -- all really one vendor each (CRMA-1220's finding: 43
// live trends promoted on same-vendor corroboration, plus 18 merges).
//
// Confirmed against the live distinct SOURCE_BREAKDOWN keys (2026-09-21,
// whole STG_TREND_CANDIDATES table): agent_chatgpt_discovery,
// agent_gemini_discovery, agent_grok_discovery, amazon_movers,
// amazon_trends, bluesky, food_beverage_trade, gdelt, gemini_food_drink,
// gemini_other, gemini_travel, gemini_wellness, global_wellness_summit,
// google_trends_explore, google_trends_rss, grok_live,
// health_trends_editorial, local_tv_news, mainstream_health_media,
// media_pfas_coverage, pinterest, tiktok, wikimedia. The six
// single-occurrence outlet-shaped names (food_beverage_trade,
// global_wellness_summit, health_trends_editorial, local_tv_news,
// mainstream_health_media, media_pfas_coverage) read as genuine distinct
// editorial/trade outlets an LLM's own live-search grounding cited -- left
// untouched, same as the buggy version.

export function sourceFamilyOfBuggy(sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (s.startsWith("amazon")) return "amazon";
  if (s === "agent_gemini_discovery") return "agent_gemini_discovery";
  if (s === "agent_grok_discovery") return "agent_grok_discovery";
  if (s === "agent_chatgpt_discovery") return "agent_chatgpt_discovery";
  if (s.startsWith("google_trends")) return "google_trends";
  if (s === "wikimedia") return "wikimedia";
  return s;
}

export function sourceFamilyOfVendorAware(sourceName) {
  const s = String(sourceName || "").toLowerCase();
  if (s.startsWith("amazon")) return "amazon";
  if (s === "agent_gemini_discovery" || s.startsWith("gemini_")) return "gemini";
  if (s === "agent_grok_discovery" || s.startsWith("grok_")) return "grok";
  if (s === "agent_chatgpt_discovery") return "chatgpt";
  if (s.startsWith("google_trends")) return "google_trends";
  if (s === "wikimedia") return "wikimedia";
  return s;
}

export function distinctFamilies(sourceBreakdown, fn) {
  if (!sourceBreakdown || typeof sourceBreakdown !== "object") return new Set();
  return new Set(Object.keys(sourceBreakdown).map(fn));
}

export function familyDelta(sourceBreakdown) {
  const buggy = distinctFamilies(sourceBreakdown, sourceFamilyOfBuggy);
  const fixed = distinctFamilies(sourceBreakdown, sourceFamilyOfVendorAware);
  return {
    buggy_count: buggy.size,
    fixed_count: fixed.size,
    buggy_families: [...buggy],
    fixed_families: [...fixed],
    disagrees: buggy.size !== fixed.size,
  };
}
