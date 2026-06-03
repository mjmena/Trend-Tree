# Plot-Driven PTO — Demo Throughline (curated real data)

**Frozen snapshot — 2026-05-28.** Every item below is real data pulled from the
production Snowflake (`MCC_PRESENTATION.TREND_AGENT`). This is *our own copy*, so
the presentation is immune to live re-runs changing the record underneath us.
News/commerce URLs were liveness-checked (all returned HTTP 200). Bluesky URLs are
built from the real AT-protocol post IDs the ingester captured.

- **Trend:** `Plot-Driven PTO` (consumer) / `Print-First Hospitality` (B2B)
- **TREND_ID:** `d6cf1523-cae7-4652-8cd6-6f25d7ff6891`
- **Topic:** Pursuing literary escapism via home libraries and dedicated reading vacations
- **Category:** social_lifestyle → literary_escapism
- **Detected:** 2026-05-21 · **Status:** STABLE · **Heat:** 51.5 · **Cluster:** 19 signals / 6 publisher-domains
- *(Note: the trend was detected May 21, 2026, but it fused social chatter stretching back to Oct 2025 — the identity is new, the cultural signal is 7 months old.)*

---

## Slide 1 — The social voices (raw, organic demand)

**Framing line:** *"Thousands of people are quietly saying the same thing. The hard part isn't the data — it's noticing the pattern before anyone else does."*

Real social posts — strangers who'd never met — independently wishing for the same thing over seven months: a "reading vacation." Lead with the most vivid:

| Date | Handle | Quote |
|---|---|---|
| 2026-05-03 | `@hotwingjack.bsky.social` | "what i really need is a reading vacation" |
| 2025-12-28 | `@chel-c-cam.bsky.social` | "I'm doing a reading vacation with my friend Liz in January. We booked a hotel and the plan is literally to sit and read in the same room and order room service." |
| 2026-02-16 | `@jeredolan2.bsky.social` | "Got my pile of books together for our upcoming reading vacation. Five days of nothing but relaxation and reading. #booksky" |
| 2025-12-02 | `@rosieethor.bsky.social` | "I know I JUST got back from a reading vacation, but damn I want another one so bad… crawl into a hole with like 10 books and not emerge until 2026" |
| 2025-10-27 | `@chel-c-cam.bsky.social` | "Planning my reading vacation with a friend for January… We're going to a hotel and will spend our time reading and eating and it's going to be AMAZING." |

**The clincher quote (great on its own slide):** `@hijaykayelle.bsky.social` (2025-12-01) —
*"At any given time I am in need of 3 vacations: a restorative vacation (stare at water and read escapist books); a reading vacation (be cozy and read more complex books); a tourist vacation (travel somewhere else)."*

**Platform note:** every individual social post we captured for this trend is Bluesky (pulled via the `"reading vacation"` search). Grok's live search contributed web-article *summaries* (see Slides 2–3), **not** individual X/Twitter posts — so there are none to add here. If someone asks "what about other platforms?", the honest line is: *social discovery for this trend ran on Bluesky; the open-web corroboration came through Grok.*

<details><summary>All 11 social posts (with post URLs)</summary>

1. 2025-10-27 · `@chel-c-cam.bsky.social` — "Planning my reading vacation with a friend for January…" — https://bsky.app/profile/chel-c-cam.bsky.social/post/3m477ikedqs2o
2. 2025-10-31 · `@septimusreviews.com` — "It's been on my to-read list forever, but I have an upcoming reading vacation…" — https://bsky.app/profile/septimusreviews.com/post/3m4ha7fsqos2v
3. 2025-10-31 · `@ardenpowell.bsky.social` — "I do not have a reading vacation (that sounds so nice)…" — https://bsky.app/profile/ardenpowell.bsky.social/post/3m4hag3youc2j
4. 2025-10-31 · `@septimusreviews.com` — "I highly recommend a reading vacation." — https://bsky.app/profile/septimusreviews.com/post/3m4hagqakck2v
5. 2025-11-15 · `@chumulu.bsky.social` — "reading vacation, nice / re-reading vacation, because its more than a linear word count" — https://bsky.app/profile/chumulu.bsky.social/post/3m5otq6cksc2g
6. 2025-11-28 · `@mismatched.bsky.social` — "ooh yeah! you got a good reading vacation ahead of ya" — https://bsky.app/profile/mismatched.bsky.social/post/3m6pbjtghgc24
7. 2025-12-01 · `@hijaykayelle.bsky.social` — "At any given time I am in need of 3 vacations…" — https://bsky.app/profile/hijaykayelle.bsky.social/post/3m6xftfz3mk2e
8. 2025-12-02 · `@rosieethor.bsky.social` — "I know I JUST got back from a reading vacation…" — https://bsky.app/profile/rosieethor.bsky.social/post/3m6zpggph3k2s
9. 2025-12-28 · `@chel-c-cam.bsky.social` — "I'm doing a reading vacation with my friend Liz…" — https://bsky.app/profile/chel-c-cam.bsky.social/post/3mazmxk7yac27
10. 2026-02-16 · `@jeredolan2.bsky.social` — "Got my pile of books together…" — https://bsky.app/profile/jeredolan2.bsky.social/post/3mex4hiq7nk2y
11. 2026-05-03 · `@hotwingjack.bsky.social` — "what i really need is a reading vacation" — https://bsky.app/profile/hotwingjack.bsky.social/post/3mky266i54s2v

</details>

---

## Slide 2 — Convergence: noise → one named trend

**Framing line:** *"Two completely different detectors — real people, and AI scouts reading the open web — landed on the exact same thing. That convergence is the signal."*

**The funnel:** **31,115 raw signals → 209 named trends**, across **17 ingestion channels**.

**This trend's 19-signal cluster, by detection path:**

| Path | Count | What it caught |
|---|---|---|
| **Organic social** (Bluesky) | 11 | Real people posting "reading vacation" (Oct 2025 → May 2026) |
| **AI discovery — travel scout** (`gemini_travel`) | 3 | "Beach Readaways", "Literary Tourism" — surfaced from Las Vegas Sun, Morningstar, IndexBox |
| **AI discovery — home scout** (`gemini_other`) | 1 | "Immersive home libraries / digital disconnection" — surfaced from Houzz |
| **Live web + X search** (`grok_live`) | 4 | One macro summary (web + X search → returned **article** citations, not X posts): *"'reading vacations,' 'bookstagram retreats,' and 'literary travel' are rising 2026 trends driven by BookTok… group retreats at resorts in the Catskills or Cotswolds"* (4 citation rows → 1 distinct summary) |

*Insight to say out loud:* the humans didn't know about the trade-press articles; the AI scouts didn't know about the Bluesky posts. The system fused both into one trend on **May 21, 2026**.

---

## Slide 3 — The agent goes to work (live grounding + tools)

**Framing line:** *"Then a single AI agent picks up the cluster and does in 74 seconds what a strategist would spend an afternoon on."*

**Enrichment run telemetry (real):**
- Agent model: `gemini-3.1-pro-preview` · reviewer: `claude-sonnet-4-6`
- **9 reasoning turns · 8 live tool calls** (Bluesky / Grok live-search / GDELT)
- **74 seconds · $0.24**

**What it grounded against — verified, recognizable outlets (all HTTP 200):**

| Source | Type | URL |
|---|---|---|
| National Geographic | news | https://www.nationalgeographic.com/travel/article/book-vacations-are-trending |
| Good Housekeeping | news | https://www.goodhousekeeping.com/entertainment/books/a65960407/reading-retreat-helped-tbr-essay/ |
| Saturday Evening Post | news | https://www.saturdayeveningpost.com/2026/05/the-ultimate-book-club-the-rise-of-the-reading-retreat/ |
| Book Riot | news | https://bookriot.com/how-to-take-a-reading-vacation/ |
| Domes Resorts | commerce | https://domesresorts.com/read-retreat-repeat-why-literary-travel-is-the-most-sophisticated-trend-of-2026/ |
| Romancing the Phone | reference | https://romancingthephone.substack.com/p/how-to-plan-a-reading-vacation |

**The agent's output (its summary of the trend):**
> "Consumers are actively carving out dedicated time and space for literary escapism, both by booking immersive 'reading retreats' and by investing heavily in home libraries. Unlike traditional vacations aimed at sightseeing, these getaways and domestic sanctuaries prioritize uninterrupted solitude, digital disconnection, and the completion of personal reading goals — functioning as a restorative antidote to modern burnout."

**Cultural drivers it identified:** aesthetic romanticization of reading on social platforms · widespread digital fatigue / burnout · the rise of BookTok / "bookstagram" culture.

---

## Slide 4 — Why you can trust it (the ledger)

**Framing line:** *"Every name, score, and status this system has ever assigned is on the record. Nothing is overwritten."*

- **Agent-owned, append-only ledgers** — each decision (enrichment, lifecycle status, heat) is a permanent, timestamped row. You can replay any trend's entire life.
- **Frozen identity vs. evolving enrichment** — the trend's name lives in `FCT_TRENDS` (immutable); its description and evidence live in a separate ledger that refreshes as the world changes. Stable identity, living detail.
- **Right model for each job** — Gemini reasons, Claude audits, three more LLMs (Gemini / Grok / ChatGPT) scout independently.
- **It watches itself** — a daily audit agent + real-time error alerting monitor the whole pipeline.
- **Lifecycle is biological:** NEW → GROWING → STABLE → DECLINING → DORMANT → RESURGENT → RETIRED. Plot-Driven PTO is currently **STABLE** at heat **51.5**.

---

## Slide 5 — Impact + the award

**Framing line:** *"Plot-Driven PTO: born from noise, named by AI, grounded in real reporting, fully traceable — and a McClatchy strategist can act on it today. Now multiply by 209."*

- **System scale:** 31,115 signals · 209 live trends · 17 channels · **646 enrichment runs · 13,859 lifecycle evaluations** (the system is continuously alive, not a one-shot batch).
- Close on the award.

---

## Appendix — provenance & data-quality notes

- **Snapshot taken:** 2026-05-28 from `MCC_PRESENTATION.TREND_AGENT` (FCT_TREND_SIGNALS ⋈ FCT_SIGNALS, FCT_TRENDS, FCT_TREND_ENRICHMENT_LEDGER, DT_TREND_DASHBOARD).
- **URL verification:** the 6 news/commerce/reference URLs in Slide 3 were `curl`-checked → all HTTP 200 on 2026-05-28.
- **No X/Twitter posts:** every individual social post for this trend is Bluesky. Grok live search returned web-article summaries + article citations, not X posts — confirmed by scanning all `grok_live` signals for this topic.
- **Cluster count nuance:** the cluster is 19 signals but the 4 `grok_live` rows are the same summary split across 4 citations, so distinct evidence is ~16. Use "19-signal cluster" as the headline number; don't over-claim distinct sources.
- **Discovery source URLs** (Houzz, IndexBox, Las Vegas Sun, Morningstar) were captured by the Gemini scouts but **not** liveness-checked — cite them by name, not as live links, unless you verify first.
- **Why this doc exists:** the live dashboard record for this trend was degraded by a write-path re-run on 2026-05-28 (curated EVIDENCE lost its social quotes — see `/tmp/handoff-plot-driven-pto-override-investigation.md`). This frozen copy preserves the strong data regardless of the live state.
