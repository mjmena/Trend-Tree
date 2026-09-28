# CRMA-1344: hand-judgement of the 22 non-(a3), non-one-family-promotion mismatches

Source: `crma-1343-scorecard.json` mismatches (52), minus the 18 (a3) cases and the 12 one-family
incumbent PROMOTE_NEW → REJECT cases. That leaves 22, which matches the report's table. Candidate
topics, signals, neighbours and pair probabilities come from `crma-1222-cases.json` and
`crma-1222-results.jsonl`. Oracle answers come from `crma-1332-oracle-signal_frequency.jsonl`.
The incumbent's rationale is `FCT_PROMOTION_LEDGER.RATIONALE`, and trend names were checked in
`FCT_TRENDS`. All Snowflake queries were read-only.

P = pair_sameness probabilities (different / unsettled / same). "narrower" is the stored
`is_narrower_instance` Noul for that pair.

## Table

| # | Ledger → typed (mechanism) | Candidate (sources) | Incumbent target / typed target or top neighbour | Verdict | Harm if typed shipped | Reason |
|---|---|---|---|---|---|---|
| 1 | REJECT → MERGE (neighbour_merge) | Portable personal cooling fans as fashion accessories (chatgpt ×2, same glossy.co signal) | typed → "Accessorizing with Handheld and Portable Fans" (sim .79, P .18/.07/.75) | **TYPED_RIGHT** | — | Same thing. The incumbent's own rationale says it "overlaps completely", yet it rejected on single-family. |
| 2 | MERGE → REJECT (oracle, one family) | Non-Diabetic CGM Tracking (grok ×1, nypost) | inc → "Personalized Metabolic Wellness" (non-diabetics wearing CGMs; sim .65, P .78/.03/.19, narrower .89) | **INCUMBENT_RIGHT** | signal lost | The target's summary is exactly non-diabetic CGM use. The judge answered different_thing. |
| 3 | REJECT → PROMOTE_NEW (stands_alone) | In-store retailtainment events and fandom pop-ups (grok ×3: charlotteobserver, bnd, fresnobee) | top → "Gen Z Experiential Shopping" ('retailtainment' hubs; sim .76, P .84/.02/.14, narrower .92) | **INCUMBENT_RIGHT** | **duplicate trend** | The candidate is the same retailtainment trend. The three publishers are all McClatchy papers, so this is probably one syndicated origin and `stands_alone` is also wrong. |
| 4 | REJECT → PROMOTE_NEW (oracle promote) | Topical NAD+ serums for cellular longevity (grok ×2) | top → "Skin longevity topicals for cellular and barrier repair" (NAD+/PDRN; sim .72, P .63/.05/.32, narrower .90) | **INCUMBENT_RIGHT** | **duplicate trend** | The neighbour's sample signals include both of the candidate's signals word for word. The incumbent named it a direct duplicate. The oracle found "NAD serum", but the pair check had already missed the duplicate. |
| 5 | REJECT → MERGE (neighbour_merge) | GLP-1 users prioritizing high-protein, nutrient-dense foods (gemini_food_drink ×2) | typed → "GLP-1 Halo Effect — protein-forward grocery buying" (sim .76, P .29/.03/.68) | **TYPED_RIGHT** | — | The incumbent's rationale says "practically identical" but rejected on single-family. Merging is the better outcome. |
| 6 | REJECT → PROMOTE_NEW (stands_alone) | Acoustic art and moss panels for home sound dampening (chatgpt ×2: homedepot, rosenberryrooms) | top → "Peel-and-stick slatted acoustic panels for home office" (sim .63, P .96/.02/.02, narrower .60) | **INCUMBENT_RIGHT** | **duplicate trend** | The neighbour's signals are "Mounting acoustic panels as primary wall art" and "Installing decorative acoustic wall panels", which is the candidate's topic. Moss and slat are styles, not separate trends. |
| 7 | MERGE → REJECT (oracle, one family) | Removable stained-glass and privacy window films for renter decor (chatgpt ×1) | inc → "DIY Static-Cling Solar/Privacy Window Films" (sim .74, P .71/.09/.20, narrower .70) | **BOTH_DEFENSIBLE** | (1 signal lost) | The product and the renter framing overlap. The motive differs (decor vs heat/energy). With one signal, a reject is cheap. |
| 8 | MERGE → MERGE, target differs | Fast-dissolving oral supplement strips replacing gummies (chatgpt ×2) | inc → "Fast-dissolving oral strips as an on-the-go supplement delivery format" (P .48/.08/.44); typed → "Portable Wellness Strips" (P .26/.06/.68) | **BOTH_DEFENSIBLE** | minor wrong target | The two targets are themselves a pre-existing duplicate pair (promoted 2026-04-27 and 04-28). Either merge is correct. The incumbent picked the older one, which is the canonical choice. |
| 9 | MERGE → REJECT (oracle, one family) | At-home telehealth ketamine troche subscriptions (chatgpt ×1) | inc → "At-Home Ketamine Microdosing Protocols" (DTC telehealth subscriptions; sim .73, P .66/.10/.24, narrower .66) | **INCUMBENT_RIGHT** | signal lost | Same behaviour and same channel. |
| 10 | MERGE → REJECT (oracle, one family) | Buying exclusive drops and local food via TikTok Shop livestreams (chatgpt ×4) | inc → "Purchasing creator-led live micro-drops on TikTok Shop" (sim .72, P .78/.07/.15, narrower .35) | **INCUMBENT_RIGHT** | signals lost (4) | Same platform and same live-shopping behaviour. The candidate is a slightly broader restatement. |
| 11 | MERGE → PROMOTE_NEW (stands_alone) | Tinned fish as a portable high-protein snack (chatgpt + grok) | inc → "Premium tinned fish (conservas) as a daily snacking hobby" (high-protein daily snack; sim .73, P .54/.07/.39, narrower .59) | **INCUMBENT_RIGHT** | **duplicate trend** | Same thing. The typed path would create a second tinned-fish-snack trend. |
| 12 | MERGE → PROMOTE_NEW (stands_alone) | Delegating product discovery and checkout to AI shopping agents (gemini + grok) | inc → "AI-Powered Shopping" (agents handle discovery, comparison, checkout; sim .74, P .50/.02/.48, narrower .65) | **INCUMBENT_RIGHT** | **duplicate trend** | The target's summary is the candidate verbatim in substance. P was a near coin-flip (.50 vs .48). |
| 13 | MERGE → REJECT (oracle, one family) | At-home vaginal microbiome sequencing kits (chatgpt ×1) | inc → "At-home localized microbiome testing (vaginal and skin)" (sim .71, P .96/.01/.03, narrower .96) | **INCUMBENT_RIGHT** | signal lost (practically nil) | This is a narrower instance of the target. The target already carries "Ordering at-home vaginal microbiome sequencing". The judge gave P(different) .96 anyway. |
| 14 | MERGE → PROMOTE_NEW (stands_alone) | Banana flavor integration in coffee and beverages (grok ×2: linkedin, nytimes) | inc → "Banana lattes and banana-flavored RTD creamers" (sim .72, P .71/.06/.23, narrower .10) | **INCUMBENT_RIGHT** | **duplicate trend** | Same thing. The typed path would create a second banana-coffee trend. |
| 15 | MERGE → PROMOTE_NEW (stands_alone) | Pre-loved fashion pop-ups with on-site patch bars and repair stations (chatgpt ×2) | inc → "Attending clothing repair pop-ups & visible mending workshops" (sim .69, P .51/.15/.34, narrower .60) | **BOTH_DEFENSIBLE** | possible near-duplicate | The main behaviour is buying secondhand at resale markets. The existing trend is about mending. They overlap only on the on-site repair station. |
| 16 | MERGE → REJECT (oracle, one family) | Pistachio flavor layering in confections and beverages (grok ×1) | inc → "Pistachio Butter as a Premium Flavor Base" (sim .70, P .85/.05/.10, narrower .48) | **INCUMBENT_RIGHT** | signal lost | The target already holds "Pistachio flavor layering in foods/drinks" and "Pistachio as a Flavor Protagonist". In practice it is the pistachio-flavour trend. |
| 17 | PROMOTE_NEW → MERGE (neighbour_merge) | Kidults hunting in-store for limited-edition blind boxes and utility drops (chatgpt + grok) | typed → "Micro-dropping mundane utility items as hype status symbols" (sim .63, P .33/.08/.59) | **INCUMBENT_RIGHT** | **wrong target** (absorbed into a sibling) | The candidate is the consumer-side hunt across categories (blind boxes, collectibles). The target is brand-side micro-drops of utility goods. They are siblings, as CRMA-1343 also judged. One signal (grocery totes) does fit the target. |
| 18 | MERGE → REJECT (oracle, one family) | Drinking extra virgin olive oil as a wellness shot (bluesky ×2, same post) | inc → "Consuming single-ingredient whole-food functional beverages (olive oil, okra)" (sim .55, P .97/.01/.02, narrower .96) | **INCUMBENT_RIGHT** | signal lost | The target's summary names olive-oil shots explicitly. This is a textbook narrower instance. |
| 19 | MERGE → REJECT (oracle, one family) | Traveling abroad for aesthetic and skincare treatments (gemini_travel ×2, "Glowmads") | inc → "Booking multi-day wellness cruises and aesthetic 'glow-up' destination retreats" (sim .58, P .87/.05/.08, narrower .51) | **INCUMBENT_RIGHT** | signal lost | The target's sample signals are literally "Glowmads" ×3, the same source term. |
| 20 | PROMOTE_NEW → MERGE (neighbour_merge) | High-fiber meals and chia to support gut health and GLP-1 (chatgpt + grok) | typed → "Fibremaxxing" (sim .52, P .26/.07/.67) | **TYPED_RIGHT** | — | One of the two signals is "Fibermaxxing via bean bowls, chia puddings". The incumbent promoted a near-duplicate. |
| 21 | MERGE → REJECT (oracle, one family) | Dual-chamber skincare + makeup hybrids to streamline 'cocktailing' (chatgpt ×1) | inc → "Replacing heavy cosmetics with sheer, skincare-infused hybrids" (sim .55, P .70/.07/.23, narrower .83) | **BOTH_DEFENSIBLE** | (1 signal lost) | Dual-chamber pre-mixing is a packaging variant of skincare-makeup hybrids. Merging it and rejecting a lone signal are both fine. |
| 22 | REJECT → PROMOTE_NEW (oracle promote) | The Wet Lash Look (chatgpt ×1, vogue) | no neighbours | **TYPED_RIGHT** | — | There is no duplicate risk. ET returned "Wet look lashes" (4.4k volume) as corroboration, where the incumbent's ET query found nothing. |

## Tally

| Verdict | n | Cases |
|---|---:|---|
| TYPED_RIGHT | 4 | 1, 5, 20, 22 |
| BOTH_DEFENSIBLE | 4 | 7, 8, 15, 21 |
| INCUMBENT_RIGHT (real typed-path defect) | 14 | 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19 |

### The 14 defects, by harm class

| Harm class | n | Cases |
|---|---:|---|
| Duplicate trend created | **6** | 3 retailtainment, 4 NAD+ serums, 6 acoustic panels, 11 tinned fish, 12 AI shopping agents, 14 banana coffee |
| Signals lost to reject (should have merged) | **7** | 2 CGM, 9 ketamine, 10 TikTok Shop live (4 signals), 13 vaginal microbiome, 16 pistachio, 18 olive-oil shots, 19 Glowmads |
| Wrong target (merged into a sibling) | **1** | 17 kidults → micro-drops |
| Wrongly promoted junk | **0** | — |

Case 8 is also a wrong target in a narrow sense, but both targets are the same thing, so I counted it as defensible.

## Observations

- **Every defect is the pair judge answering `different_thing` on a narrower instance or a restatement of the neighbour.** 13 of the 14 are missed same-thing pairs. The exception is case 17, a false same-thing. The missed pairs sit at similarity 0.55–0.76 with P(same_thing) 0.02–0.48.
- **The judge had the evidence and still said "different".** In cases 2, 10, 11, 12, 13, 14, 16, 18 and 19, the incumbent's target trend's `sample_signals` contain the candidate's own signal text or source term. In case 4, the neighbour holds both of the candidate's signals word for word. Some of that overlap is probably leakage from the incumbent's own merge. Even so, the overlap was visible to the judge.
- **`is_narrower_instance` is ≥ 0.5 on 10 of the 13 missed pairs.** The exceptions are TikTok (.35), banana (.10) and pistachio (.48). A rule of "narrower instance → merge" is a possible lever, but it has not been validated. In an unrelated case I spot-checked, the same Noul reads 0.89 on a pair that is clearly different, so it may not discriminate.
- **Of the 4 MERGE → PROMOTE_NEW cases, 3 create real duplicates** (tinned fish, AI shopping, banana). One is defensible (repair pop-ups). Three more duplicates come from incumbent REJECTs that the typed path promotes (cases 3, 4, 6). The duplicate count is therefore 6, not 4.
- **Case 3 is also an evidence_quality miss.** Charlotte Observer, BND and Fresno Bee are all McClatchy titles, so they are one syndicated origin. `stands_alone` should not have fired.
- **The incumbent is inconsistent on single-family duplicates.** It merged most of them (2, 7, 9, 13, 16, 18, 19, 21). It rejected three others even though its own rationale called them duplicates (1, 4, 5). The typed path's two merges in 1 and 5 are real improvements.
- **The signals-lost harm is soft.** A signal the typed path rejects still lives in FCT_SIGNALS. The hourly lifecycle-attribution agent may re-link it to the live trend, though that is not verified per case. Duplicate trends are not self-healing. They show up on the dashboard and get enriched as separate trends.
