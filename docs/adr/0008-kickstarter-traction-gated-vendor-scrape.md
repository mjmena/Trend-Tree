# Kickstarter enters as a traction-gated vendor scrape

**Status:** accepted (2026-09-07)

## Context

Kickstarter had no prior ingester and no prior ruling in this repo. The
expand-intake-sources map (CRMA-977) admits it as a **signal source only** —
the sourcing tier's multi-tier contract (CRMA-745) owns product sourcing, so
Kickstarter never feeds it.

Research (CRMA-980, 2026-09-06) found:

- **No official API.** Kickstarter operates no public developer API in 2026;
  the historical `api.kickstarter.com` surface is OAuth-gated and private. The
  map's API-first, scrape-fallback precedence collapses immediately to
  scrape-or-nothing.
- **`discover/advanced?format=json`** — the site's own discover surface —
  returns `id, name, blurb, goal, pledged, backers_count, state, category,
  created_at, launched_at, deadline, creator, urls.web.project`. It is
  undocumented and Cloudflare-gated: a direct fetch from a datacenter IP
  returns HTTP 403 with a Turnstile challenge, re-verified 2026-09-07 (even
  `robots.txt` is challenged). Any route needs an intermediary.
- **Shape passes both hard requirements.** Title plus blurb name a concrete
  product by construction ("gooseneck travel kettle"), and every item carries
  a canonical public `kickstarter.com/projects/<creator>/<slug>` URL.
- **Volume** ~25–40 trend-relevant projects/day launched site-wide.

Two facts checked during the decision sharpened it further:

- **Kickstarter's Terms of Use ban scraping explicitly** — no "robot, spider,
  scripts, or other automatic device… to scrape the Services for any purpose."
  Same risk class as Reddit (ADR-0006) and TikTok (ADR-0007).
- **`discover/advanced` filters traction server-side** — `raised` buckets,
  `state`, `category_id`, and `sort=most_funded` / `most_backed` alongside
  `newest`. This removes the need for the re-poll-and-diff velocity machinery
  the research assumed.

## Decision

Kickstarter enters as a **direct platform source** — one scheduled ingester,
fed by a **vendor scrape** through the shared scraping tool, **conditional on
the vendor decision (CRMA-985)** covering it. If no acceptable vendor covers
Kickstarter, the route lapses with no new decision needed.

- **One role only.** No `search-kickstarter` agent search tool is named, and
  none is deferred. Unlike TikTok's role B, a Kickstarter lookup answers a
  yes/no question — closer to an [oracle] than to a body of evidence — and
  ADR-0004 already set the bar an oracle must clear. The ingester deposits the
  same evidence into `FCT_SIGNALS`, where lifecycle-attribution can reach it. A
  named-but-deferred role is a debt the map would carry for no gain.
- **A signal means proven traction, not a launch.** The ingester queries
  `state=live` plus the funded `raised` bucket over the curated categories, and
  **first sighting of a project id is the signal**. Entering the funded pool
  *is* the event, so dedupe by project id yields "new entrant" for free. The
  only state is a seen-id key — ordinary ingester idempotency, not a
  watchlist or a snapshot table.
- **Query posture.** A curated, repo-maintained list of `category_id`s — Food,
  Design, Fashion, Technology, Crafts as the starting set — mirroring the
  curated-list pattern ADR-0007 set for TikTok. There is no keyword query at
  all, so the evidence-purity question TikTok had to answer does not arise
  here. **Daily cron**: campaigns run ~30 days, a funded project is still in
  the pool tomorrow, and a late sighting costs latency, not the signal.
- **What the source is for.** Kickstarter adds a **commercial-intent family**
  to trends other sources surface, and occasionally leads them. It is not a
  lead trend generator and **must not be judged by promotion rate**. It is the
  only surface in the pipeline where someone has paid for a specific product
  before it exists — every other source measures talk (Bluesky, Grok, GDELT),
  search demand (Google Trends), or post-hoc retail (Amazon).
- **Web Robots monthly dumps** are a build-time schema and QA reference only,
  never in the write path.
- **Risk acceptance and mitigations**: the scrape is limited to public data;
  the vendor decision weighs legal defensibility explicitly; the route carries
  audit-agent freshness coverage (CRMA-989) as a launch requirement, per the
  map's standing constraint for every approved scrape route.

## Considered options (and why rejected)

- **Rule Kickstarter out on volume.** ~25–40/day is modest, and a Kickstarter
  project is a singleton by construction — one creator, one product, one URL —
  so a stream of them risks clustering with nothing and inflating
  `FCT_SIGNALS` without moving `FCT_TRENDS`. Rejected because the traction
  gate shrinks that risk sharply: a funded project is far likelier to co-occur
  with chatter elsewhere, and the pre-market commercial-intent lane is
  otherwise uncovered.
- **Poll `sort=newest` and re-poll tracked ids to diff snapshots**
  (the research's recommendation). Rejected: it buys a watchlist and a
  snapshot table that no other source in this pipeline has, for a supporting
  player, when the `raised` filter expresses the same gate server-side.
- **Ingest launches ungated, for maximum earliness.** A launch is
  days-to-weeks earlier than the same project crossing its funding bar, and
  earliness is part of the source's case. Rejected anyway: an unfunded launch
  is evidence of one creator's guess, not of demand, and being three weeks
  earlier on noise is negative value.
- **A separate cheaper vendor path for Kickstarter** — a generic unblocker
  (Bright Data Web Unlocker, ~$1/mo at our volume) rather than the shared
  tool. Rejected: a second vendor is a second auth, billing relationship,
  failure mode, and thing the wrapper service must speak, for a supporting
  source — and owning the parser means owning it the next time the surface
  changes, which the retired TikTok scraper is the standing lesson about.
- **Third-party RSS shims** (Kicktracker, Kicktraq): hobby-tier, no SLA.
- **Kickstarter as a product-sourcing feed**: out of the map's scope; the
  sourcing tier owns it, the same boundary that applies to TikTok Shop.

## Consequences

- A **third** ToS-adverse route is knowingly headed for production. Kickstarter
  bans scraping as explicitly as Reddit and TikTok do, so the vendor's legal
  posture is part of the mitigation here too.
- CRMA-985 carries a **weak** Kickstarter constraint: the vendor must cover it
  by **either** a pre-built actor **or** a generic unblocker that defeats
  Turnstile on the discover JSON. Stated that way it keeps both Apify (which
  has actors) and Bright Data (which has no Kickstarter scraper but a
  qualifying Web Unlocker) alive — Kickstarter informs the vendor choice
  without dictating it.
- CRMA-985's paid pilot must **verify the `raised` filter survives the vendor
  route**. The buckets are coarse — reportedly `<75%` / `75–100%` / `>100%`, so
  75% is the only floor on offer and the choice is gate-or-don't, not
  gate-level. If the filter does not survive, this design falls back to
  re-poll diffing and the decision reopens.
- The undocumented discover endpoint can change or gain protection without
  notice, so freshness monitoring (CRMA-989) is a launch requirement, not an
  enhancement.
- The route is reversible by construction: it lapses if CRMA-985 finds no
  covering vendor, and the curated category list means shutting the source off
  is config removal, not schema surgery.
