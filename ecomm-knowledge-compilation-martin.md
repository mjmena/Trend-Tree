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
