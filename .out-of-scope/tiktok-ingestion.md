# TikTok Ingestion

Trend Tree does not run a TikTok ingester. The `ingestion/tiktok-p_yKCm9Am`
workflow was deactivated on 2026-04-25 and scrapped on 2026-06-09; we will not
reshape or reactivate it.

## Why this is out of scope

Two independent reasons, either of which is sufficient:

**1. The data source no longer exists.** The ingester scraped TikTok's Creative
Center Radar page. TikTok retired that surface — the page now 301-redirects to
"TikTok One Creative Suite" and the underlying `creative_radar_api` XHR the
scraper depended on is gone. There is no maintained, low-friction TikTok
trending feed left to ingest without a paid provider or a brittle headless-browser
arms race.

**2. The output never fit the distillation specificity rubric.** Even when the
scrape worked, it emitted hashtag-level rows — `skills`, `nfldraft2026`,
`maincharacter`, `idulfitri2026`, `photopostcampaign`. These are generic memes,
news cycles, holidays, and platform meta: exactly the ≤4-word category
hypotheses the distillation lead's SPECIFICITY FLOOR is designed to reject
locally. Activating as-is burned agent budget on guaranteed rejections.

**The niche is already covered.** The discovery workflow's Grok lane
(`discovery-p_5VCPP3N/discover_grok`) pulls X/social-driven cultural signals with
citation URLs and `why_now` framing — better signal/noise than hashtag rankings,
and it covers the same emergent-culture territory TikTok ingestion was meant to
provide.

A future TikTok signal source is not forbidden in principle, but it would need a
genuine data source (a paid trends API, not page-scraping) **and** a reshape that
emits concrete noun-verb consumer behaviors rather than raw hashtags. Absent
both, this stays closed.

## Prior requests

- #18 — "Reshape TikTok ingester before re-routing to production"
- #20 — "ingest-tiktok-trending workflow deactivated — reactivate after reshape"
