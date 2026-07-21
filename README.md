# Trend Tree

**McClatchy's always-on consumer-trend intelligence system.**

Trend Tree watches the public conversation across news, social, search, and commerce — decides what's worth calling a trend — and delivers each one as a named, scored, evidence-backed record. Fast enough for editorial to publish on. Sharp enough for sponsorship to sell on.

A new trend is detected, named, and on the dashboard in **~10–15 minutes** end-to-end. Every active trend is re-evaluated hourly, so the heat scores never go stale.

---

## Five agents, one pipeline

Trend Tree is a coordinated system of five specialized AI agents. Each owns exactly one kind of decision, runs continuously, and writes its reasoning to an immutable ledger — every promotion, naming, and lifecycle call is on record and auditable.

**Discovery** — Three frontier models (Gemini, Grok, ChatGPT) independently scan consumer culture every two hours, sharded across configurable verticals. Running them in parallel — different prompts, different cadences, different signal pools — surfaces angles any single model would miss.

**Distillation** — A Gemini 3.1 Pro lead with a clustering subagent reads the last 24 hours of signals and proposes candidate trends. It enforces a specificity rubric — *"consumers choosing X over Y because Z"* — so candidates describe real behavior, not categories.

**Promotion** — A second Gemini agent evaluates each candidate against the live portfolio and decides: new standalone trend, duplicate of one already tracked, or noise. Approved candidates fire the enrichment chain immediately.

**Enrichment** — A Claude Sonnet 4.6 agent loop produces the canonical trend record: a single clarity-first `TREND_NAME`, summary, audience profiles, and cited evidence. A four-layer naming pass — interleaved thinking, live grounding (Bluesky, GDELT, Grok search), in-prompt anti-cliché review, and a post-emission reviewer — keeps names sharp, specific, and brand-safe. (The earlier dual B2C/B2B naming was retired at the 2026-05-27 singular-name cutover — see ADR-0001.)

**Lifecycle** — A Gemini sweeper runs hourly. For each active trend it recomputes the heat index from linked-evidence velocity and breadth, classifies the trajectory (NEW / GROWING / STABLE / DECLINING / DORMANT / RESURGENT / RETIRED), flags meaningful narrative drift, and retires trends that have gone quiet.

---

## What you get

Each trend on the dashboard is a complete, ready-to-use intelligence record:

| Field | Example |
|---|---|
| **Name** (clarity-first) | *The White Cast Vanishing Act* |
| **Category** | beauty |
| **Heat index** | 63.8 / 100 |
| **Status** | STABLE |
| **Summary** | Consumers are ditching chemical SPF formulas and reaching for tinted mineral sunscreens that go on invisibly — driven by Korean centella formulas and TikTok's "no white cast" demand. |
| **Sources** | 21 signals across GDELT, Bluesky, Amazon, Google Trends |

A trend promoted today:

> **Topic:** Honey-note gourmand fragrances surging as the new feminine scent direction
> **Status:** NEW · **Initial heat:** 82.4 · **Promotion confidence:** 0.65

---

## Coverage

Three frontier AI scanners (Gemini, Grok, ChatGPT) sweep consumer culture every two hours. Each is web-search enabled, so they're free to surface anything publicly indexable — coverage is not capped at our structured sources.

That said, our structured ingestion runs continuously across five source families and feeds the same signal pool:

- **News** — GDELT global event stream
- **Social** — Bluesky
- **Search** — Google Trends
- **Commerce** — Amazon Movers & Shakers
- **Other** — Pinterest (the TikTok scraper was retired 2026-06-09; the Grok discovery lane now covers the TikTok cultural niche)

Verticals are configurable and tuned per-model, so coverage can be reweighted as editorial and sponsorship priorities shift.

---

## For technical readers

- **[`docs/dashboard/data-contract.md`](docs/dashboard/data-contract.md)** — Snowflake table reference / data contract for the downstream platforms: `DT_TREND_DASHBOARD`, `DT_TREND_DAILY`, `DT_TREND_CONNECTIONS`. Column schema, types, example values, quick-start queries.
- **[`docs/architecture.md`](docs/architecture.md)** — Pipedream workflow inventory, inter-workflow HTTP call map, shared library, design patterns, and debugging guide.
