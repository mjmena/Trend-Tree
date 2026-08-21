# CRMA-754 — the selector's contract: prototype readout

Prototype for the sourcing selector (map CRMA-745). Run 2026-08-21 against the real
`gemini-3.7-flash` API, on candidate pools rebuilt from the CRMA-753 calibration corpus
(443 live trends × 187 products, persisted `TREND_VECTOR` × embed doc v1, floor 0.40,
TOP_N 10). 22 live calls total, ~$0.03.

## The contract

### What the selector sees

One trend, one tier's candidate pool, one call — per the CRMA-755 standing constraint.

- **Of the trend**: `TREND_NAME`, `SUMMARY_SHORT`, `CATEGORY / SUBCATEGORY` (labeled as
  context, per the "signal not filter" constraint).
- **Of each candidate**: `CATALOG_PRODUCT_ID` plus the tier's **embed doc** (v1: title,
  type, vendor, tags, body excerpt), capped at 700 chars — the selector judges exactly the
  text retrieval matched on.
- **Order**: `SEMANTIC_SCORE`-descending. **Raw scores are not shown.** Geometry stays out
  of the judgement (the standing constraint separates `SEMANTIC_SCORE` from
  `REASONED_FIT`); rank order alone carries the retrieval signal.
- **Slots**: the prompt states "at most {slots}" — the CRMA-755 slots-remaining input,
  `MAX_SOURCED_PRODUCTS` (5) minus picks already taken by higher tiers.

### What it may return

One forced call of a terminal emit tool, `propose_product_selection`:

```
outcome    "matched" | "no_match"
picks      [] — up to {slots} of:
  catalog_product_id   string (echoed from the pool)
  reasoned_fit         "strong" | "partial" | "weak"
  rationale            one sentence, ≤25 words, operator-facing
pool_note  one sentence on the pool as a whole — what was rejected and
           why, or why nothing matched
```

- The selector **filters; it does not rank.** Stored and displayed order stays tier block
  first, then `SEMANTIC_SCORE` within a tier (CRMA-751/755). No rank field exists for it
  to emit.
- **Refusal is a first-class outcome**: `outcome='no_match'` with empty picks. The prompt
  says most trends have no match and forbids filling space with the least-irrelevant items.
- **No numeric score from the model, ever** — `REASONED_FIT` is the enum the standing
  constraint requires.

### The `REASONED_FIT` definitions (as prompted)

- **strong** — the product *is* the trend item, or a direct instance of the behavior; an
  operator sees the connection instantly.
- **partial** — the product serves the trend's underlying need or ritual, but is not the
  trend item itself.
- **weak** — connected only through an ingredient, category, or audience; defensible but a
  stretch. Used sparingly; never to fill slots.

The measured behavior draws the line exactly where the definitions put it: a magnesium
*balm* for a magnesium-*spray* trend came back `partial` every run (same bedtime ritual,
different format), while bathroom scales for a toilet-biometrics trend were refused every
run (same room, different object).

### Call shape

- `gemini-3.7-flash`, **ungrounded** — no `google_search`, so the CRMA-757 head-truncation
  defect (grounded-only, 0 ungrounded truncations in every measurement) is out of the
  blast radius by construction.
- `toolConfig.functionCallingConfig.mode = "ANY"` pinned to the emit tool — every run
  emitted exactly one call, 22/22.
- `thinkingConfig.thinkingLevel = "low"`. No `temperature` (deprecated 2026-07-21; the
  CRMA-726 migration strips it fleet-wide). `medium` was probed on the hardest judgment
  case and changed nothing but thinking tokens.
- Emit-tool parameter schema is shallow (2 levels, 6 leaf paths) — deliberately near the
  `propose_audit_report` end of the CRMA-722 schema-hazard spectrum, not the 39-leaf
  `propose_enrichment` end.

### The lane

- `DIM_LLM_PROMPT` key **`sourcing.selector`**, v1, `MODEL='gemini-3.7-flash'`. Per the
  fleet fact recorded on CRMA-726, only the discovery lanes are registry-driven — the
  ecomm agent pins the model as a code const and the registry row is versioned prompt
  store + telemetry, like every other lane.
- CRMA-726 coordination: this is a **new pin born on 3.7 Flash**, ungrounded, already on
  the migration's target model and call-shape rules. Nothing for that map to migrate.

## Evidence

Seven contract cases (round 1), then 15 stability repeats (round 2). Every run:
`finishReason=STOP`, one emit call, all required fields present, every
`catalog_product_id` echoed verbatim from the pool.

| Case | Pool | Expected | Result |
| --- | --- | --- | --- |
| Whole-Body Deodorant | 1 cand, 0.4496 (the CRMA-753 tie's *right* half) | pick, strong | **4/4 picked, strong** |
| Circadian Light Glasses | 2 red-light devices, 0.446/0.4165 (the tie's *wrong* half) | refuse | **4/4 `no_match`**, reason names the actual mismatch |
| Bedtime Magnesium Sprays | 1 cand: magnesium *balm*, 0.4835 | partial | **4/4 partial**, caveat "balm rather than spray" every time |
| Passive Toilet Biometrics | 3 smart scales, 0.4647– | judgment | **7/7 refused** (3 low + 3 medium + r1) — "scales, not toilet-integrated" |
| Tallow Skincare | 10 of 33 ≥0.40 | ≤5 sensible | 5 strong; lip balms and cooking tallow left behind |
| Adaptogenic Coffee Swaps | 10 mushroom coffees | 5 strong | 5 strong, sensible variety |
| — same, slots=2 | 10 | respect cap | exactly 2 picks |

**The selector earns its latency.** CRMA-753's score-tie at 0.453 — a perfect match and a
wrong match geometry cannot separate — was resolved correctly in *both directions*, every
repeat, at **~1.0–2.4 s** and **~$0.0013–0.0032 per call** (prompt ~1.3–3.3K tokens,
thinking 0–185 tokens). Projected first poll tick: ~95 of 443 trends have a non-empty pool
→ ~95 selector calls ≈ **$0.15**; steady state is noise. Zero spurious refusals on
matchable pools, zero quota-filling picks on junk pools.

### One schema consequence for CRMA-751's DDL

`pool_note` needs a home. It is run-level prose (why the pool was refused, or what was
rejected), belongs on the **header** row — a nullable `SELECTOR_NOTE` column on
`FCT_TREND_SOURCING_LEDGER` — and gives the Decision Page an operator-readable line for
the `no_match` state that would otherwise render as a bare status. The candidates table
is untouched: rejects stay rationale-less, `IS_PICKED=false`, `REASONED_FIT` NULL.

## The prompt (v1 verbatim)

```
You are the product selector for the Trend Tree sourcing pass.

A trend is an emerging consumer behavior our pipeline has verified. You receive one
trend and a short list of store products that a vector search ranked most similar to
it. Similarity is geometry, not fit: near-identical scores can hide both a perfect
match and an irrelevant product. Your job is the judgement the score cannot make.

Rules:
- Select only products a shopper following this trend would recognize as serving it.
- You may select at most {slots} products. Fewer is normal.
- Returning nothing is a first-class outcome, not a failure. If no candidate genuinely
  serves the trend, emit outcome "no_match" with an empty picks list. Most trends have
  no match in this small catalog; never return the least-irrelevant items to fill space.
- Sharing an ingredient, a category, or vocabulary with the trend is not fit. The
  product must serve the trend's actual behavior.
- Grade each pick honestly with reasoned_fit:
  - "strong": the product IS the trend item, or a direct instance of the behavior — an
    operator sees the connection instantly.
  - "partial": the product serves the trend's underlying need or ritual, but is not the
    trend item itself.
  - "weak": connected only through an ingredient, category, or audience; defensible but
    a stretch. Use sparingly; never to fill slots.
- rationale: one sentence (max 25 words) an operator will read on the Decision Page.
  Plain language, no scores, no hedging.
- pool_note: one sentence on the pool overall — what you rejected and why, or why
  nothing matched.
```

User content: the trend block (`Name / Category / Summary`), then the numbered candidate
list, each entry `catalog_product_id` + embed doc (700-char cap).

## Reproduction

Scratch tables (transient, `MCC_RAW.MARKETING_DEV`, **dropped after the run**):
`PROTO_CRMA754_TRENDS`, `PROTO_CRMA754_SCORES`, plus rebuilt `PROTO_CRMA753_CATALOG` /
`PROTO_CRMA753_CATD` from the surviving CRMA-753 loaders. Runner and result JSONs are
throwaway files in the session job dir (`selector_754.py`, `stability_754.py`,
`selector_results_r{1,2}.json`). The Gemini key is the `gemini-api` keychain entry.
`snow sql` needs `--enable-templating NONE` for any file carrying product text — `&` in
HTML entities trips the client-side renderer.
