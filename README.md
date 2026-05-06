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

**Enrichment** — A Claude Sonnet 4.6 agent loop produces the canonical trend record: B2C name (editorial), B2B name (sponsorship pitch), summary, audience profiles, and cited evidence. A four-layer naming pass — interleaved thinking, live grounding (Bluesky, GDELT, Grok search), in-prompt anti-cliché review, and a post-emission reviewer — keeps names sharp, specific, and brand-safe.

**Lifecycle** — A Gemini sweeper runs hourly. For each active trend it recomputes the heat index from signal velocity, classifies the trajectory (NEW / GROWING / STABLE / PEAK / STAGNANT / DECLINING), flags meaningful narrative drift, and retires trends that have gone quiet.

---

## What you get

Each trend on the dashboard is a complete, ready-to-use intelligence record:

| Field | Example |
|---|---|
| **B2C name** (editorial / consumer) | *The White Cast Vanishing Act* |
| **B2B name** (sponsorship pitch) | *Invisible Zinc Pivot* |
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
- **Video / Other** — TikTok, Pinterest

Verticals are configurable and tuned per-model, so coverage can be reweighted as editorial and sponsorship priorities shift.

---

## For technical readers

- **[`docs/schema.md`](docs/schema.md)** — Snowflake table reference, starting with `DT_TREND_DASHBOARD` (the surface Steeple reads). Quick-start queries included.
- **[`docs/architecture.md`](docs/architecture.md)** — Pipedream workflow inventory, inter-workflow HTTP call map, shared library, design patterns, and debugging guide.
