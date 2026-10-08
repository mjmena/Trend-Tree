# CRMA-1204 — Deck outline: the thirteen-slide content spec

Resolves "Outline the deck: the twelve-slide content spec" on map CRMA-1199 (executive briefing deck for Trend Tree). Draft 1, 2026-10-07, for Martin to react to. A rendered storyboard of this outline is published as a private Artifact; the link is on the ticket.

Every number here comes from the CRMA-1203 snapshot of 2026-10-06 and is refreshed with that asset's queries the day before presenting. Every Future Plans item maps 1:1 to a lozenge on the Trend Tree Roadmap page, per CRMA-1200.

## The deck at a glance

| # | Section | Slide | Lands one sentence | Visual or number |
| --- | --- | --- | --- | --- |
| 1 | Open | Trend Tree | The intelligence pipeline behind ATLAS. | Tree mark, presenter, date |
| 2 | Open | Where Trend Tree shows up | Strategists never see the pipeline; they see its output in four places. | Four surface tiles; 590 trends |
| 3 | Open | What one trend carries | Every trend arrives ready to act on. | Annotated ATLAS card; May's three lenses |
| 4 | The tree | The tree | Thousands in at the roots, a few hundred up the trunk, only the proven reach the crown. | Full tree; 154,500 → 2,254 → 590 |
| 5 | The tree | Roots: discovery and ingestion | Listeners and AI scouts work around the clock; no human picks the searches. | Roots lit; 12 live sources; 36,831 signals in 30 days |
| 6 | The tree | Trunk: distillation and promotion | Agents cluster by meaning and decide: new trend, more proof, or not yet. | Trunk lit; the two-family bar; about 2 promotions a day |
| 7 | The tree | Crown: enrichment and lifecycle | Each trend is named, profiled, then tracked hourly on an append-only ledger. | Crown lit; three mini-cards; $0.13 median |
| 8 | Example | One trend, root to crown | The chosen trend traced through all three layers. | Mini tree with the trend's own numbers; a quote |
| 9 | Today | Where it stands today | Live since April 2026: 590 trends from 154,500 signals at 13 cents a profile. | Three stat tiles plus a secondary row |
| 10 | Today | What feeds it, what reads it | Twelve live sources in, four McClatchy surfaces out. | Left-to-right integration diagram |
| 11 | Ahead | Building now | Four things in build, led by predictions with a verdict. | Four lead-in rows |
| 12 | Ahead | Exploring | Three directions, none scheduled. | Three lead-in rows |
| 13 | Close | Trend Tree | Live, selective, and getting more so; here is where to find it. | Small tree with the funnel; links; contact |

## Decisions this outline makes

These are the choices to react to. Each one changes the build.

1. **Thirteen slides, not twelve.** The charting shape had one slot too few for a title slide plus a close. Slides 2 and 3 fold into one if twelve is a hard target; nothing else folds without losing a layer or a Future Plans bucket.
2. **Every slide carries its sentence.** The "Lands one sentence" column is rendered on the slide itself, as a single line under the title. That line is the narration a forwarded reader gets. Speaker notes beyond it are a build detail and stay out of this outline.
3. **The tree is the chapter marker.** Slide 4 shows the full tree. Slides 5, 6 and 7 repeat it small, next to the title, with one layer lit. That replaces the showcase deck's green tick as the running header mark and makes the tree the section map the map's Notes ask for.
4. **The three layers keep the May names.** Discovery & Ingestion, Distillation & Promotion, and Lifecycle were the three process cards the executives saw in May. The third becomes "Enrichment & Lifecycle" because naming and profiling is most of what the crown does. Everything else stays recognisable.
5. **Two-tone titles, one payload word.** Each title has exactly one word in the accent green, marked in bold below, following the showcase deck's pattern.
6. **The worked example is one slide.** It compresses May's Signal, Decision and Payoff rhythm into a single root-to-crown trace. It is the only slide that waits on an open ticket (CRMA-1201).
7. **Current state shows only what a strategist sees on ATLAS today.** The daily prediction score is current; the prediction engine with a verdict is future. Product matching is current; the external catalogue is future. This is CRMA-1200's boundary applied slide by slide.

## Slide by slide

Each slide lists what it **says** (the visible sentence), what it **shows**, where its content **comes from**, and the **rules** it must obey.

### 1. Trend **Tree**

- **Says:** Trend Tree is the intelligence pipeline behind ATLAS. It discovers cultural signals, identifies the real trends among them, names and scores them, and tracks them across their lifecycle.
- **Shows:** Eyebrow "Executive briefing · October 2026". The tree mark small. Presenter name and title. No agenda list; the tree on slide 4 is the agenda.
- **Comes from:** The roadmap page's own opening sentence, so the deck and the roadmap tell one story.
- **Rules:** Title-slide treatment from the style tokens: pale wash, white band for the title, Plus Jakarta Sans ExtraBold.

### 2. Where Trend Tree **shows up**

- **Says:** Strategists never see the pipeline. They see its output in four places.
- **Shows:** Four tiles, one per surface, each with who reads it and what it shows. ATLAS trend cards (the trend list; 590 trends today). The Predictions Queue in the Insights Agent (13 trends flagged today). The daily digest email (new trends each morning, under the ATLAS name). Product matches on the Decision Page (37 trends matched to the Trend Hunter store).
- **Comes from:** CRMA-1203 outbound consumers table.
- **Rules:** Only live surfaces. The handoff to the Content Scaling Agent is another squad's work in progress and is not shown. Screenshot thumbnails per tile are optional and sourced by the build ticket.

### 3. What one **trend** carries

- **Says:** Every trend arrives named, summarized, evidenced and scored, with the nearest McClatchy content and matching products attached, so a strategist can act without research.
- **Shows:** One annotated ATLAS trend card. Callouts map May's three payoff lenses to real card fields: Audience (the social narrative and the voice-of-customer quote), Content Gaps (nearest McClatchy content), Monetization (matched products). Also called out: the trend name, the short summary, the heat index, the lifecycle status, and the publisher count.
- **Comes from:** `docs/dashboard/data-contract.md` for field names. The showcase deck's slide 5 for the three lenses.
- **Rules:** Show only fields a strategist sees on ATLAS today. Count publishers, never sources. Use the trend name, never the trend topic.

### 4. The **tree**

- **Says:** Thousands of signals enter at the roots. A few hundred candidates climb the trunk. Only trends that clear the bar reach the crown.
- **Shows:** The full tree visual, three layers labelled, with the funnel on it: 154,500 signals since April 2026, 2,254 candidates, 590 trends. One secondary figure: 5,675 signals (3.7%) are linked to a trend as evidence.
- **Comes from:** CRMA-1203's funnel line. CRMA-1205 supplies the visual.
- **Rules:** This slide is the section map. The three layer labels are the titles of slides 5, 6 and 7, word for word.

### 5. The roots: discovery and **ingestion**

- **Says:** Autonomous listeners pull from platforms and AI scouts propose topics around the clock. No human decides what to search for.
- **Shows:** The tree small with the roots lit. The inbound inventory in three groups. Direct platform sources: Google Trends stories, Bluesky, Google Trends search interest, TikTok*. Discovery agents: seven lanes across Gemini, Grok and ChatGPT. On-demand search tools the reasoning agents call: Grok live search, Bluesky search, Google Trends search. One line on the foundation: every signal is embedded at ingest so it can be compared by meaning. Numbers: 12 live sources; 36,831 signals in the last 30 days.
- **Comes from:** CRMA-1203 inbound sources. `CONTEXT.md` for the three entry mechanisms.
- **Rules:** Name a source only if it wrote rows in the last 30 days. *TikTok stays only if the day-before refresh shows fresh rows. Never name Amazon, Pinterest or GDELT. No outage story.

### 6. The trunk: distillation and **promotion**

- **Says:** Agents cluster signals by meaning into candidates. A promotion agent decides each one: a new trend, more proof for a trend we already track, or not yet.
- **Shows:** The tree small with the trunk lit. The bar, stated plainly: a candidate needs two independent source families, or one family plus a confirmed match from Exploding Topics, a licensed search-demand service the pipeline queries for confirmation (65 trends confirmed this way since July). Numbers: 2,254 candidates to 590 trends since April; about two new trends a day.
- **Comes from:** `CONTEXT.md` (corroboration oracle). The roadmap's "A second opinion that rescues promising single-source trends". CRMA-1203 rows 1a, 7, and the promotion rate.
- **Rules:** Exploding Topics is confirmation, never a source. "Source family", not "second source".

### 7. The crown: enrichment and **lifecycle**

- **Says:** Each promoted trend is named and profiled with live grounding, then tracked hourly, with every new signal attributed as evidence and every change kept on an append-only ledger.
- **Shows:** The tree small with the crown lit. Three mini-cards in the showcase deck's pipeline-stage pattern. Name and profile: one Gemini 3.1 Pro agent grounds the trend live, proposes names, and a reviewer pass checks them; $0.13 median per run. Track: an hourly heat index and lifecycle status; newly ingested signals are attributed to live trends (6,550 evidence links today). Predict: a daily prediction score feeds the Predictions Queue (13 eligible trends today).
- **Comes from:** `CLAUDE.md` enrichment section. CRMA-1203 rows 4, 5a, 5b.
- **Rules:** No lifecycle breakdown chart; it reads flat and lifecycle detection is a Building Now item. No per-trend Google Trends curve; that poller was removed. The prediction engine with a verdict is not on this slide.

### 8. One trend, root to **crown**

- **Says:** [Trend name]: [n] signals from [m] publishers over [span], promoted [date] on [families], named and profiled the same day, [status] today.
- **Shows:** The trend name as the big accent callout (May's reveal treatment). A mini tree with this trend's own numbers at each layer. One voice-of-customer quote in the two-panel quote layout. The ATLAS card thumbnail. Nearest McClatchy content and a matched product, if the trend has them.
- **Comes from:** CRMA-1201 picks the trend. The build pulls: `TREND_NAME`, `SUMMARY_SHORT`, `ORIGINALLY_SURFACED_AT`, `TOTAL_CLUSTER_SIZE`, `DISTINCT_PUBLISHER_COUNT`, `VOICE_OF_CUSTOMER`, `EVIDENCE`, `HEAT_INDEX`, `LIFECYCLE_STATUS`, `NEAREST_CONTENT`, `SOURCED_PRODUCTS` from `DT_TREND_DASHBOARD`, plus the promotion record (date, source families, Exploding Topics confirmation yes or no) from `FCT_TRENDS` and `STG_TREND_CANDIDATES`.
- **Rules:** What this slide asks of CRMA-1201's shortlist: promoted after May 2026, at least three publishers, more than one source family, legible to a non-technical executive, and ideally carrying both nearest content and a matched product so slide 3's three lenses all fill.

### 9. Where it stands **today**

- **Says:** Trend Tree has run in production since April 2026. Today it holds 590 trends built from 154,500 signals, at a median AI cost of 13 cents per trend profile.
- **Shows:** Three stat tiles in the showcase deck's 3-up pattern: 590 trends on ATLAS; 154,500 signals ingested; $0.13 median enrichment cost. A secondary row: about 2 new trends a day; 36,831 signals in the last 30 days; 37 trends matched to products; 13 prediction-eligible trends. Optional callback for the May audience: "200+ trends in May, 590 today", only if the build verifies the May count from `FCT_TRENDS`.
- **Comes from:** CRMA-1203 metrics table.
- **Rules:** Numbers only from the snapshot, refreshed the day before. No outage candor. No lifecycle breakdown.

### 10. What feeds it, what **reads** it

- **Says:** Trend Tree sits between twelve live sources and four McClatchy surfaces, with a licensed demand service for confirmation and three model vendors doing the reasoning.
- **Shows:** A left-to-right diagram. Inbound: the platforms (Google Trends, Bluesky, TikTok*), the discovery lanes (Gemini, Grok, ChatGPT), and confirmation (Exploding Topics, drawn apart from the sources). Centre: Trend Tree on Snowflake, reasoning on Gemini 3.1 Pro with Claude on four steps, running on Pipedream and Google Cloud Run. Outbound: ATLAS, the Predictions Queue, the daily digest, product matching against the Trend Hunter store.
- **Comes from:** CRMA-1203 inbound, outbound, and vendors sections.
- **Rules:** Exploding Topics sits in its own "confirmation" slot, not among sources. The CSA handoff is absent. Vendor names are plain, with no logos unless the build has rights to them.

### 11. Building **now**

- **Says:** Four things are in build: a prediction engine that makes checkable calls, a wider intake, sharper lifecycle reads, and the move onto our own infrastructure.
- **Shows:** Four rows in the inline labeled-sentence pattern (bold green lead-in, plain continuation), one sentence each on what changes for the audience. **Predictions with a verdict** leads: the engine already writes specific, checkable calls every day; next it reaches strategists as a short list with Approve and Dismiss and a running track record. Running now, reaching strategists next. **A wider intake:** Reddit and Kickstarter join as feeds and TikTok returns built on creator posts, so trends corroborate from a broader evidence base. **Sharper lifecycle detection:** the lifecycle read gets the treatment the heat score got, so strategists see momentum rather than inertia. **Our own infrastructure**, the closing beat: two of the newest services, product matching and the prediction engine, already run on managed infrastructure of our own; the rest follows piece by piece.
- **Comes from:** CRMA-1200 sub-decisions 1, 2, 3 and 5. Roadmap lozenges IN DEVELOPMENT and SCOPED & SCHEDULED.
- **Rules:** No dates, no quarter labels, no "in final review". No vendor grievance. The quiet-feeds repair is folded into the intake item as pure expansion.

### 12. **Exploring**

- **Says:** Three directions are being explored, none scheduled: connections that explain themselves, products beyond our own store, and proving quality rather than asserting it.
- **Shows:** Three rows in the same pattern. **Reasoned Connections:** an AI explains why a set of trends belongs together and writes the story, and connections persist week to week. **Beyond the internal store:** product matching extended to a broad external catalogue, once commercial access is settled. **Proving quality:** versioned prompts, then A/B-tested prompts, then a regression safety net, so a change to the AI is proven to improve trends before it goes live.
- **Comes from:** CRMA-1200 sub-decision 3. Roadmap lozenges DIRECTIONAL, with the prompt-governance item folded into the proving-quality arc as decided.
- **Rules:** Nothing unwritten. The deck never scoops the roadmap page.

### 13. Trend **Tree**

- **Says:** Trend Tree is live, selective, and getting more so. Find it on ATLAS, in the morning digest, and on the Trend Tree Roadmap.
- **Shows:** The tree small with the three funnel numbers. Three links: ATLAS, the daily digest, the roadmap page. Contact: Martin Mena, backend and pipeline.
- **Comes from:** The roadmap page footer.
- **Rules:** No ask. No "next steps" list; the deck is informational.

## What this outline asks of the open tickets

- **CRMA-1205, the tree visual,** needs two states: the full tree for slide 4 and slide 13, and a small glyph with one layer lit for slides 5, 6 and 7. The three layer labels on it are the slide titles above, word for word. The funnel numbers sit on the full state only.
- **CRMA-1201, the worked example,** gets the shortlist criteria in slide 8's rules and the field list the build will pull. The pick should be made against those.
- **CRMA-1206, the build,** inherits decisions 2, 3 and 5 above as layout rules, and the per-slide rules as copy rules.

## Fog this outline clears

- Presenter narration for forwarded readers: carried by the visible sentence on each slide (decision 2). Whether to add speaker notes beyond it is a build choice, not a map decision.
- Per-slide imagery beyond the tree: specified above per slide. Slides 2, 3 and 8 take ATLAS screenshots or card thumbnails; slides 9 and 10 take typographic tiles and a diagram; no other imagery.
