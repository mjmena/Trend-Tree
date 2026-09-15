# Ecomm in Trend Tree — compiled knowledge and open questions

Compiled 2026-09-09 by Martin Mena, from the recurring **Trend Hunter Tools Sync** meeting
(organizer Johnna Logan, 2x/week Google Meet — not biweekly), Jason Smith's architecture docs,
and Jira. Sources checked: the meeting series from 2026-03-23 through 2026-09-08 (11 transcripts
read in full, several more skimmed via Drive search), Jason Smith's "Trend Hunter B2C Agents (JS)"
doc, the CRMA Jira project (trend-tree component), and a Slack sweep. Every claim below cites its
source so it can be re-verified. What is already written up as a formal spec —
[`docs/prd/trend-to-product-sourcing.md`](docs/prd/trend-to-product-sourcing.md), CRMA-745/772,
ADRs 0001–0009 — is treated as known and not repeated here except where it conflicts with
something said in a meeting.

## 1. Three (really four) parallel product-sourcing efforts, never reconciled in writing

This is the central confusion running under everything else. At least four different systems
have tried to solve "match a trend to a product" over the life of this project, and nothing I
found ties them together into one decision.

1. **What actually got built** (`services/ecomm-agent`, CRMA-745/772): a cron-driven agent that
   vector-matches the Trend Tree's own persisted trend embedding against the McClatchy Shopify
   store catalog, with a Gemini 3.7 Flash selector that filters (never ranks, never invents).
   Internal-catalog-only, no external search, no business-development angle.
2. **Jason Smith's original vision** (his "Trend Hunter B2C Agents (JS)" doc, Component 4:
   "E-Commerce Product Agent" — see §2 below): an agent that autonomously **crawls external retail
   sites** (Ulta Beauty, Amazon, Sephora named explicitly) to find products matching a trend, and
   outputs a research report for **Business Development to pursue commerce partnerships** — a
   completely different job (prospecting, not catalog-matching), with three downstream agents
   (Collections Page, PDP, SEO Content) that trigger only once a commerce agreement exists.
3. **Gary Kirwan's own "ecommerce discovery API"** — built and tested independently since at
   least 2026-06-18 (Slack, group DM with Jason Smith/Martin/Patrick Al Khouri/Marcelo
   Freitas/Eric Stegeman). Takes a trend name plus a generated `product_query` description and
   returns matched products with pricing. Works well when the trend maps to a real product
   category (Fibermaxxing → 25 products; "Pucker & Crunch" → sour/crunchy snacks; "Protein
   Feelings" → protein snacks) and returns **empty** when the trend name is an invented editorial
   label with no product market. Marcelo asked Martin directly (Slack, 2026-06-18) whether
   Trend Tree's own Shopify data in Snowflake could serve as **"a validation layer for his output
   or a fallback when his discovery doesn't find anything."** I found no reply or resolution to
   that ask anywhere — it appears to be the seed of what became the built ecomm-agent, but the
   two were never explicitly connected in the PRD, the epic, or any ticket.
4. **Eric (a Shopify developer)'s scraping solution for "Shopify Collective"** — mentioned once,
   2026-08-21 meeting: Gary described the bottleneck as *scaling product ingestion into Shopify
   itself* (a different problem than matching trends to existing products), and said Eric is
   building automated import of new products into the store, based on trend topics, to supplement
   manual sourcing.

**Open question I could not find an answer to anywhere:** how (or whether) Gary's discovery API
and Eric's Shopify Collective importer relate to the built `services/ecomm-agent` — redundant,
complementary, superseded, or simply unaware of each other. None of the three has a Jira ticket
or repo reference tying it to CRMA-745/772.

## 2. Jason Smith's full agent architecture (context the repo doesn't have)

From "Trend Hunter B2C Agents (JS)" (Google Doc, owned by Jason Smith, last touched 2026-09-09).
The doc frames the whole system as a pipeline: **Anticipate (Trends) → Understand (Insights) →
Predict (Inclination) → Activate (Content & Commerce)**, across five components:

1. **Consumer Trend Agent** — signal ingestion and scoring (roughly maps to this repo's discovery
   → distillation → promotion chain, described at a higher level of abstraction).
2. **Insights Dashboard** — the human-in-the-loop hub. Its own text carries the doc's only
   explicit **"Key Decision Needed"** flag: *"Audience data tables needed should be unified for
   the entire system and not called separately through different agents. Determining where this
   central call happens is important."* This is the same theme as §5 below (audience/persona
   unification) — it shows up in JS's architecture doc and independently in the meeting series.
3. **Inclination Scoring Agent** — predicts purchase likelihood per audience segment (6 pillars,
   35 segments, Audience Acuity data). Not something this repo builds; not raised in any meeting
   I read as ecomm-adjacent.
4. **E-Commerce Product Agent** ("EComm Agent") — see §1.2. This is the name overlap that likely
   caused confusion: the doc's "EComm Agent" and the repo's `services/ecomm-agent` share a name
   but not a job.
5. **MAIA** ("stacked LLMs for deep research") — referenced elsewhere in meetings as "Maya," an
   internal research tool feeding Atlas content briefs. Not ecomm-specific, but shows up
   constantly as an adjacent system (see the Aug 11/14/27 meetings on Maya scope and Atlas→Maya
   connections).

No other "Key Decision Needed" markers exist in the doc — the audience-unification one is the
only explicit open item Jason Smith flagged in writing.

## 3. Current state of the built ecomm-agent, as of 2026-09-09

- **Catalog size, tracked over time**: 159 products live (Slack, Gary Kirwan, 2026-07-29) → "around
  180 items, 23 product trends" (meeting, 2026-08-21 and 2026-08-27, Martin's own count from
  Shopify data) → **187 products, all active** (the canonical figure, from the 2026-08-20 admin CSV
  export recorded in CRMA-747 and the PRD).
- **The live Shopify Admin API token is still not provisioned.** CRMA-747's last comment
  (2026-08-20) reads: *"Parked 2026-08-20 — Shopify access is waiting on an email reply. Moved
  back to Backlog, still assigned."* I found no later comment or status change. The ticket is
  still **Backlog**.
- **Consequence**: CRMA-777 (the live daily catalog sync job) is blocked on CRMA-747 and is also
  still **Backlog** — nothing outside this repo can hand it the token. The catalog the ecomm-agent
  sources against today is the **static 2026-08-20 CSV snapshot**, now three weeks old. The PRD's
  own rule is that the agent declines to source against a catalog older than 7 days, and the
  audit agent grades catalog freshness YELLOW past 3 days / RED past 7. **CRMA-1033's "Scope
  note" (filed after CRMA-1029 shipped) names "the stale shopify catalog tier... blocked on the
  Shopify token in CRMA-747" as one of the causes currently holding the daily audit report at
  RED** (alongside CRMA-1031: audit-agent graded RED for 16 consecutive days). This is worth
  knowing before anyone asks "why is the ecomm agent's data stale" — it's not a bug, it's a known,
  externally-blocked ticket.
- **CRMA-780 (open, Backlog)**: a genuine unresolved design decision, deliberately deferred rather
  than fixed unilaterally by a code reviewer during CRMA-779. Once a second sourcing tier exists
  (Amazon or otherwise), the dashboard's "latest sourcing header per trend" query becomes
  ambiguous — a `no_match` from a low-priority tier could mask a real match from a higher one. Not
  urgent today (only one tier exists), but the ticket explicitly says it must be resolved as the
  first step of whichever story adds a second tier.
- **CRMA-749 (Done, but leaves two open questions addressed directly to Marcelo, never
  answered)**: does the Decision Page hydrate price/image live from Shopify at render time, or
  does the sourcing ledger need to be self-sufficient? And how should the panel render the new
  third state ("processed, nothing matched") alongside its existing `available:false` / empty-array
  distinction? The PRD's schema was deliberately built to not need an answer yet (`_AT_MATCH`
  snapshot columns cost three columns and work either way), but the actual UX behavior is still
  unresolved with Marcelo as of the ticket's last comment (2026-08-20).

## 4. The unresolved question: "is every article a commerce article?"

This is the single clearest open question in the whole meeting series, and it reads as still
unresolved. From the 2026-08-27 Trend Hunter Tools Sync transcript (Martin, Kathryn Sheplavy, Sara
Vallone, Jason Smith, Gary Kirwan):

- Martin described the ecomm-agent's approach in his own words: *"it uses like a really rough
  semantic score to find a handful of products that might be associated with trends and then it
  does reasoning on top of that... these will be bidding products, right? They're not going to be
  everything."*
- Martin also confirmed Amazon product data (newly accessible via Patrick Al Khouri's handoff)
  is being used for **guidance only right now, not insertion into ecom articles** — a decision he
  made informally in-meeting, not something settled beforehand.
- Sara Vallone raised the actual open question: *"Is the ecommerce team going to be writing
  content for Trend Hunter, or are we adding products to our content?... I think step one is
  deciding who's doing what."*
- Jason Smith agreed it's unresolved and explicitly punted: *"Before we start including that, at
  any point there's some decisions need to be made — is every article a commerce article, which
  kind of changes the whole thing... I don't yet think we need to worry about that unless we
  disagree... I want to get Andy involved in this conversation, so we're not making commerce
  decisions on our own."*
- Kathryn Sheplavy flagged the financial risk directly: *"What I don't want is for a bunch of
  Amazon links to go live and then we don't get paid when we're sending traffic to Amazon."* The
  open questions she named in-meeting: **who provides the links (Shopify and/or Amazon) with
  proper tracking so McClatchy gets paid, what does that process look like at launch, and what
  should it look like long-term?**
- The meeting's own recorded next step: *"[Jason Smith] Discuss Commerce Strategy: Coordinate with
  Andy to determine the fundamental commerce strategy and roles."*

I found no later meeting (through 2026-09-08) that revisits this. "Andy" is never further
identified in anything I read — presumably a commerce/revenue stakeholder who doesn't attend
Trend Hunter Tools Sync. **As of today, who decides which content gets commerce links, and the
tracking/attribution process for it, is an open question with no owner confirmed in writing.**

One side note from the same conversation: Jason Smith confirmed the legacy **"Bible" automatic
linking service is still active** on McClatchy sites and could be an easy integration path — but
"I haven't heard a word about it in like three months." Nobody has picked this back up as of the
last meeting I read.

## 5. Amazon: a second, informal track outside the documented multi-tier design

The PRD's "Out of Scope" section is explicit: building any second sourcing tier (Amazon or
otherwise) is not in scope; Shopify is the only implemented tier, and the multi-tier contract is
specified but unbuilt. In parallel, and apparently without reference to that document, an informal
Amazon track has been moving in meetings:

- 2026-08-27: Martin got Amazon Creator API access via Patrick Al Khouri's handoff. Explicit
  decision in-meeting (Martin, echoed by Marcelo): Amazon products are for **guidance, not direct
  article insertion**, "at the moment."
- Same meeting: Kathryn explained the Content Strategy Application (CSA) already has search/filter
  tooling built by Patrick for Amazon products (star rating, on-sale, etc.), but **the
  article-specific UTM link still has to be created manually** — no automated tracking-link
  generation exists for Amazon today.
- Gary Kirwan proposed extracting category/product keywords from content meta descriptions to feed
  the Amazon API for relevant product searches — a "presenting keywords" approach distinct from
  the ecomm-agent's vector-similarity approach.

This is a second, ad hoc Amazon integration effort, running through the CSA and the Amazon Creator
API rather than through the multi-tier contract the PRD specified for exactly this purpose. Nobody
in the meetings I read connected the two.

## 6. Audience/persona unification — the other recurring "Key Decision Needed"

This is the theme that shows up independently in Jason Smith's architecture doc (§2) and across
several meetings, always about *personas/audience*, not ecomm directly — but the user asked for
recurring open questions, and this is the clearest one after the commerce-ownership question above.

- **2026-06-26** ("Trend Hunter Tools Sync"): "Shared Audience" workstream initiated — teams
  agreed to build toward "a single source of truth for organizational data" and "an agentic tool
  for actionable cohort generation." (Same meeting also covered the Exploding Topics API decision
  and the CMS/Shopify ecomm items already known from the PRD.)
- **2026-08-07** ("Trendhunter Interaction Data Walkthrough" — Emil Penalo, Marcelo Freitas,
  Martin): reviewed Amplitude-based interaction signal tracking (scroll depth, dwell time,
  likes/shares, weighted 0–5), nightly Snowflake→Amplitude sync, 90-day interest-summary window.
  Martin proposed shifting from per-user tracking to **persona-based cohorts** for Harbor
  integration. Open action item, unresolved as far as I found: *"[Martin] Consult with Amanda
  regarding the scoping and automation of behavioral cohort creation in Amplitude."*
- **2026-08-14**: the group reached alignment **in principle** — personas are built and stored in
  Harbor as the single source of truth, and must be derived from real audience/behavioral data
  (McClatchy + Audience Acuity), not from content topics. This directly answers Jason Smith's
  "Key Decision Needed" from his own doc, at least at the principle level. But the *mechanics*
  were still being negotiated in the same meeting: who can create new personas (Harbor alone, or
  also CSA/Atlas?), whether personas need approval, a capping mechanism to avoid runaway
  generation, and a feedback loop so CSA can flag an ineffective persona back to Harbor. Martin's
  committed next step was *"start scoping that today"* — I found no later meeting confirming that
  scoping concluded.

## 7. Things Martin raised as proposals or open uncertainty, not settled decisions

The user specifically asked for places where he seemed unsure or was proposing rather than
deciding. Three surfaced clearly:

- **2026-06-26**: Martin *proposed* (didn't decide) either softening the hard gate used for
  prediction scoring or restructuring the heat index, after noting Google Trends data is
  inconsistent and makes up ~20% of the heat index value, and many trends were clustering below a
  score of 40. This appears to have been superseded by the separate **Prediction Pillar v1**
  rewrite already tracked in this repo (CRMA-761, `docs/wayfinder/prediction-pillar-strategy.md`),
  which replaces the old heat-index-based scoring with verdict-based predictions — so this looks
  resolved, just not in the way it was first framed.
- **2026-05-22**: Chris Palo and Pierce Williams openly said the heat index and audience-match
  scores felt "semi-probabilistic or random" with no clear scaling — an explainability complaint,
  not a decision. Martin's next step was to draft metric documentation. **This looks resolved**:
  [`docs/confidence.md`](docs/confidence.md) ("Trend Tree — Confidence & Explainability," last
  updated 2026-07-21) is explicitly written for exactly this audience and problem. Worth a quick
  confirmation with Chris/Pierce that it actually answers their complaint, since I can't verify
  that from the doc alone.
- **2026-09-08**: Martin proposed purchasing the Bright Data API to source Reddit/TikTok/Kickstarter
  data, pending Jason Smith's approval ("Submit request for Bright Data API procurement to Jason
  for approval by tomorrow"). This looks like it was already actioned — Bright Data access already
  exists (Secret Manager + Keychain), and the technical integration work (CRMA-977's map:
  vendor research CRMA-981, provisioning CRMA-986, both Done) predates this meeting. The Sep 8
  ask reads as a cost/approval formality catching up to work already in motion, not a live
  blocker.

## 8. Where product sourcing belongs — a proposed boundary, and the Amazon call

**This section is a proposal, not a compiled finding.** Sections 1–7 record what people said
and what is built, each claim cited. This section argues a position from that evidence, so the
Amazon question has something concrete to be argued against.

### 8.1 What Trend Tree's sourcing pass actually answers

The `ecomm-agent` runs at **trend time**. A poll tick picks up a trend once enrichment has
written its ledger row, long before any article exists. It vector-matches the trend's persisted
embedding against `DIM_CATALOG_PRODUCT`, and a Gemini 3.7 Flash selector filters the result. Its
consumer is the **Decision Page** in `insights-agent`, which the PRD names as the only consumer
surface it designs for.

The pass does not answer "what products go in this article". It answers two narrower questions:

1. **Does this trend have a purchasable shape at all?** A trend the selector rejects wholesale
   has no product market — the same failure mode Gary Kirwan's API shows when it returns empty
   for an invented editorial label (§1.3).
2. **Does our own store stock it?** That is user story 17: the sourcing ledger doubles as a buy
   list, read as a query over Shopify-tier `no_match` headers.

Both answers are strategist-facing, and both are produced before an angle is chosen. Neither is
a link a reader clicks.

### 8.2 The ~91% no-match rate is the buy list working, not a gap to fill

The last recorded measurement is **23 matched against 230 `no_match`** — a ~9% match rate, taken
during the backfill drain of 2026-08-25. It is not re-measured for this document; re-run it
before quoting it.

That number reads as a failure only if you expect the Decision Page to show products for every
trend. A 187-product store cannot stock 253 consumer trends. The pass was specified to say so
honestly rather than fill the quota: the per-tier floor is never relaxed, and a trend no catalog
stocks returns nothing.

So the 9% is a **merchandising readout**, not a defect. Its fix is more owned inventory — Eric
Stegeman's automated Shopify Collective importer (§1.4) — not a marketplace tier that makes
every trend look stocked.

### 8.3 An Amazon tier does not fit the multi-tier contract

The contract defines a tier as **one product catalog** ranked by commercial preference. User
story 22 promises that a new tier costs a sync job, a tier config, and rows in the same
dimension and ledger. Both assume a catalog you can sync and embed. `DIM_CATALOG_PRODUCT` holds
persisted vectors refreshed by a daily full sweep, with a revisit trigger at roughly 2,500
products.

Amazon has no catalog to sync. An Amazon tier must query a live API and then embed or judge the
result at runtime. That is a different retrieval path, a different cost shape, and a different
freshness model from the one the audit agent grades. **The specified contract does not
accommodate Amazon. It accommodates a second owned catalog.**

This is the sharpest reason to stop, and it is written down nowhere — the PRD only records that
a second tier is out of scope, not that the tier abstraction itself excludes a marketplace.

The mechanism that *would* work is the one Gary already built: a live query API taking a trend
name plus a generated `product_query` (§1.3).

### 8.4 Three reasons the timing is wrong even if the fit were right

- **Tier 1 is broken first.** The Shopify catalog is a static CSV snapshot from 2026-08-20, the
  live sync (CRMA-777) is blocked on the token (CRMA-747, still Backlog), and the stale catalog
  is one of the causes holding the daily audit at RED (CRMA-1033). Adding a second tier while
  the first sources against a three-week-old export is the wrong order.
- **CRMA-780 is the stated gate.** That ticket says the multi-tier header ambiguity must be
  resolved as the first step of whichever story adds a second tier. It is still Backlog, and
  nobody has taken that step.
- **Commerce ownership is unowned.** Who decides which content carries commerce links, and how
  McClatchy gets paid for the traffic, is open with no confirmed owner (§4). Jason Smith punted
  it to Andy on 2026-08-27 and no later meeting revisits it. Trend Tree cannot settle it, and
  matches nobody may publish are worth nothing. Martin's own in-meeting decision from the same
  day still stands: Amazon product data is **guidance, not article insertion**.

### 8.5 The recommendation

**Amazon is not worth bringing into Trend Tree as a sourcing tier now.** It belongs to the
article step, where Gary's discovery API and CSA's Amazon search already operate.

| Step | Owner | Question it answers | Input | Output |
|---|---|---|---|---|
| Trend time | Trend Tree `ecomm-agent` | Is this trend commercial, and do *we* stock it? | trend embedding | Decision Page panel + buy list |
| Article time | Gary's discovery API / CSA ecomm mode | Which SKUs go in *this* piece? | `product_query` or meta-description keywords | linked, tracked products |

Trend Tree's contribution to the article step is not a product list. It is the
**commercial-shape verdict and the product-category description** that Gary's API takes as
input — which Trend Tree already derives and currently discards.

### 8.6 The seam nobody answered

Marcelo Freitas asked Martin directly on 2026-06-18 whether Trend Tree's Shopify data could
serve as *"a validation layer for his output or a fallback when his discovery doesn't find
anything"* (§1.3). No reply exists anywhere.

Under the boundary above, the answer to both halves is yes, and it costs far less than a tier.
House inventory outranks a marketplace item — that is user story 18 — so "Shopify first, Gary's
discovery as fallback" is the same commercial-preference order the multi-tier contract already
encodes. It is executed across two systems instead of inside one.

### 8.7 What would reopen the Amazon question

- Commerce ownership resolves, and the decision is that **trend-level** Amazon matches are what
  gets published.
- Gary's discovery API is retired, or proves insufficient at article time.
- Shopify Collective grows to the point where the buy list stops being the main value of the
  Shopify tier.

### 8.8 One contradiction to resolve first

Section 5 records that the article-specific Amazon tracking link *"still has to be created
manually"* (2026-08-27). A later note holds the opposite: that the in-CSA Amazon search already
emits tracked links, and that Amazon attribution is a 24-hour cookie window rather than a
per-article UTM parameter. Both cannot be current.

This bears directly on the recommendation. If CSA already emits tracked Amazon links, Trend Tree
adds nothing on the monetization axis and the case for an Amazon tier weakens further. One
question to Patrick Al Khouri or Kathryn Sheplavy settles it.

## Sources

- **Meeting transcripts read in full** ("Trend Hunter Tools Sync" / earlier "Trend Agent Sync"):
  2026-03-23, 2026-05-22, 2026-06-26, 2026-08-07 (side meeting), 2026-08-11, 2026-08-14,
  2026-08-18, 2026-08-21, 2026-08-27, 2026-09-08. (2026-08-25 produced no usable transcript — Meet
  recorded under 10 seconds of audio.)
- **Jason Smith's docs**: "Trend Hunter B2C Agents (JS)" (Google Doc,
  `1nz7kXx0ZAyfxrDI-ESYlO4q2qwFv6123XPfW_cYVFwQ`); "Trend Hunter B2C Documents" planning doc and
  "Trend Agent Evolution" deck skimmed for context, not deeply mined.
- **Jira (CRMA, trend-tree component)**: CRMA-745, 747, 749, 772, 773–780, 1033, 725, 781, 442.
- **Slack**: one search sweep (`ecomm OR shopify OR ecommerce trend hunter`) across DMs with
  Jason Smith, Gary Kirwan, Patrick Al Khouri, Marcelo Freitas, Eric Stegeman.
- **Repo docs treated as already-known, not re-summarized**:
  `docs/prd/trend-to-product-sourcing.md`, ADRs 0001–0009, `docs/confidence.md`.
