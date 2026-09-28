# CRMA-1316: What SerpApi can return for TikTok, Reddit, and Kickstarter

Research date: 2026-09-28 (UTC). Sources: serpapi.com engine docs (read 2026-09-28) and 17 billable live calls against the SerpApi API. The query log is at the end.

Legend: **[LIVE]** means verified against the live API in this session. **[DOCS]** means read on serpapi.com and not exercised here.

## TL;DR

- **SerpApi has no dedicated engine for TikTok, Reddit, or Kickstarter.** [DOCS] The full engine sidebar on `serpapi.com/search-api` lists ~110 engines. The social ones are `facebook_profile`, `instagram_profile`, and the YouTube engines. The words "tiktok", "reddit", and "kickstarter" appear nowhere in the docs index. Every path below goes through Google.
- **TikTok** is the strongest fit. `engine=google_short_videos` with `q=site:tiktok.com <topic>` and `tbs=qdr:w` returned 12/12 TikTok videos, all posted in the last 7 days. [LIVE] That engine returns no date and no view counts. The TikTok video ID encodes the post time, so an absolute date can be derived. View counts appear only in the `short_videos` block of a regular `engine=google` search, and even there not reliably.
- **Reddit** can be reached two ways: `engine=google_forums` (Google's Forums tab), which has native `period_unit`/`period_value` recency filters, or `engine=google` with `site:reddit.com` plus `tbs=qdr:d|w`. [LIVE] Google's past-day index of Reddit is thin: `site:reddit.com/r/SkincareAddiction` with `qdr:d` returned **1** result. The Forums tab mixes Reddit with every other forum (4chan, Mumsnet, Facebook groups, spam "review" threads). You get comment counts and a relative date, but no upvotes on the post itself.
- **Kickstarter** only works as `engine=google` + `site:kickstarter.com/projects`. [LIVE] Snippets often carry parseable `N backers pledged $X` or `$X pledged of $Y goal · N days to go`. The `date` field is Google's crawl/update age, not the launch date. Results are dominated by update/community sub-pages and repeat creators. A query for active campaigns (`"pledged of" "days to go"`, past week) returned **1** result. This is weak as a scheduled source.
- **Top/trending:** SerpApi exposes no platform-native "top" or "trending" feed for any of the three. [DOCS+LIVE] A contentless `site:tiktok.com` past-day query returns a random multilingual grab-bag, not the most popular videos. Every access path is query-driven. The only trending engine is `google_trends_trending_now`, which covers Google search trends, not these platforms.
- **Cost / quota:** Big Data Plan, **$275/mo for 30,000 searches**, about **$0.0092 per search**. The account (`dev@trendhunter.com`) is **shared and already 80% consumed** this cycle: 24,078 used and 5,920 left before the 2026-10-07 renewal. [LIVE] Failed calls (param errors) were not billed. Identical queries repeated within 1 hour are served from cache for free. [DOCS + LIVE usage delta]

## Per-platform table

| | TikTok | Reddit | Kickstarter |
|---|---|---|---|
| Dedicated SerpApi engine | None [DOCS] | None [DOCS] | None [DOCS] |
| Best access path | `engine=google_short_videos`, `q=site:tiktok.com <topic>`, `tbs=qdr:w` [LIVE] | `engine=google_forums`, `period_unit=d\|w`, `period_value=1` [LIVE]; or `engine=google` + `site:reddit.com[/r/<sub>]` + `tbs=qdr:d\|w` [LIVE] | `engine=google` + `site:kickstarter.com/projects` + `tbs=qdr:w` [LIVE] |
| Other paths | `engine=google` organic with `site:tiktok.com` [LIVE]; `engine=google_videos` (`site:tiktok.com`) [LIVE]; `short_videos` SERP block of `engine=google` (no site filter; TikTok appears alongside YT/IG/FB) [LIVE] | `discussions_and_forums` block of `engine=google` (0-3 items, no recency) [LIVE] | none useful; generic "kickstarter gadget" queries return blogs, YouTube and `/discover` pages [LIVE] |
| URL | yes (canonical `tiktok.com/@handle/video/<id>`) | yes (`reddit.com/r/<sub>/comments/<id>/...`) | yes, but often a sub-page (`/posts/<n>`, `/community`, `/rewards`) that needs normalising to `/projects/<creator>/<slug>` |
| Title | yes (the caption, truncated) | yes (post title) | yes (project title) |
| Snippet / text | `google_short_videos`: none. `google_videos`/organic: snippet, sometimes "N Likes, TikTok video from X (@handle)" [LIVE] | `google_forums`: snippet, sitelinks with `answer_count`+`date`; on `device=mobile`, `answers[]` with `votes` [DOCS] | snippet, often with `N backers pledged $X` / `pledged of $Y goal` / `N days to go` / `Last updated <date>` [LIVE] |
| Date | `google_short_videos`: **none** [LIVE]. Organic/`google_videos`: relative ("13 hours ago", `rich_snippet.top.detected_extensions.hours_ago`) [LIVE]. **Absolute post time derivable from the video ID (`id >> 32` = unix seconds)** [LIVE, verified against the qdr:w window] | `google_forums`: relative inside `displayed_meta` ("180+ comments · 16 hours ago") or `date` [LIVE]. `engine=google` organic with `qdr:w`: **`date` was absent on all 10** [LIVE]; with `qdr:d` a relative date was present | relative `date` ("6 days ago") = Google's crawl/update age, **not launch date** [LIVE]. Snippet sometimes has an absolute "Last updated September 22, 2026" |
| Engagement | `short_videos` block (`engine=google`): `views` / `extracted_views` [DOCS]; **absent in our live sample** [LIVE]. `google_short_videos`: none. Organic snippet: sometimes "3532 likes, 112 comments" as free text, localized [LIVE] | comment count as text ("180+ comments", "30+ comments") [LIVE]; per-answer `votes` on mobile [DOCS]. No post score | backers + amount pledged + currency as snippet text [LIVE] |
| Author / handle | `channel` (= TikTok handle) in `google_short_videos` [LIVE]; `profile_name` in `short_videos` block [LIVE] | subreddit in `source` ("Reddit · r/Adulting") [LIVE]; no username | creator slug in URL; "by <creator>" in title sometimes |
| Thumbnails | `thumbnail` + `clip` (gstatic preview) [LIVE] | `favicon` only | `favicon` only |
| Freshness filter | `tbs=qdr:d\|w` works on `google_short_videos` and `google`/`google_videos` [LIVE] | `google_forums`: `period_unit` (s/n/h/d/w/m/y) + `period_value` (**required**, despite docs saying default 1), or `start_date`/`end_date` [LIVE]; `engine=google`: `tbs=qdr:*` [LIVE] | `tbs=qdr:w` [LIVE] |
| Freshness in practice | `qdr:w`: 12/12 posted 2026-09-21..28 (decoded IDs). `qdr:d` organic: all "8-23 hours ago" [LIVE] | `google_forums` `period_unit=d`: 10 threads, all < 1 day, but only 1 was Reddit. `site:reddit.com/r/SkincareAddiction` `qdr:d`: **1 result** [LIVE] | `qdr:w`: 10 results "3-7 days ago", mostly update pages of already-funded projects [LIVE] |
| Top / trending | No. Query-driven only; bare `site:tiktok.com` `qdr:d` = random multilingual noise [LIVE] | No. Query-driven only [DOCS+LIVE] | No. Kickstarter's `/discover` sort pages show up only as ordinary organic links, and SerpApi has no generic page scraper [LIVE] |
| Result volume per call | 12 (`google_short_videos`, paginate `start=12`) [LIVE]; 10 organic | 10 (`google_forums`); `site:` organic varies (1-10) | ≤ 10; `total_results` for tight shapes was 1-10 (the index is small) |
| Cost per pull (1 call) | ~$0.0092 | ~$0.0092 | ~$0.0092 |

## Query shapes that worked

**TikTok**
- `engine=google_short_videos&q=site:tiktok.com <topic>&tbs=qdr:w&gl=us&hl=en` returned 12/12 TikTok videos, all ≤ 7 days old, on topic. The best shape found.
- `engine=google&q=site:tiktok.com <topic>&tbs=qdr:d` returned fresh results, but topic relevance was poor (the top hits for "tiktok made me buy it" were unrelated French/Vietnamese/Chinese videos). Adding `lr=lang_en` would probably help but was not tested.
- `engine=google_videos&q=site:tiktok.com <topic>&tbs=qdr:d` returned on-topic, fresh results with `rich_snippet.top.detected_extensions.hours_ago` and a handle in `extensions[1]`.
- Derive the absolute post time with `datetime.utcfromtimestamp(int(video_id) >> 32)`.

**Reddit**
- `engine=google_forums&q=<topic>&period_unit=w&period_value=1` returned fresh threads (a Reddit r/snacking thread 5 days old with 30+ comments), mixed with other forums and SEO spam.
- `engine=google_forums&q=site:reddit.com <topic>&period_unit=w&period_value=1` returned **"Google Forums hasn't returned any results"**, although it was billed. Don't combine `site:` with the Forums engine.
- `engine=google&q=site:reddit.com "<phrase>" <topic>&tbs=qdr:w` returned 10 Reddit threads (149 total), but with no `date` field.
- `engine=google&q=site:reddit.com/r/<sub>&tbs=qdr:d` works but is sparse (1 result for a 2M-member sub).

**Kickstarter**
- `engine=google&q=site:kickstarter.com/projects "backers pledged"&tbs=qdr:w` returned 10 projects with backers and pledged in the snippet, but these are mostly *already-funded* campaigns being updated. `-inurl:posts` was partly ignored by Google.
- `engine=google&q=site:kickstarter.com/projects "pledged of" "days to go"&tbs=qdr:w` returned **1** active campaign.
- `engine=google&q=site:kickstarter.com/projects "notify me on launch"&tbs=qdr:w` was meant to find pre-launch pages. It returned 9 results, but they were live or funded pages that happen to carry that UI string, not true pre-launches.

## Sample result excerpts (trimmed)

`engine=google_short_videos`, `q=site:tiktok.com skincare`, `tbs=qdr:w` [LIVE]:
```json
{"position": 1, "title": "What is your Skincare routine? #BASED",
 "link": "https://www.tiktok.com/@based/video/7689529813559807246",
 "source": "TikTok", "channel": "based", "duration": "0:29",
 "thumbnail": "https://serpapi.com/searches/.../images/....jpeg",
 "clip": "https://encrypted-vtbn0.gstatic.com/video?q=..."}
```
(ID `7689529813559807246 >> 32` decodes to 2026-09-25.)

`engine=google`, `short_videos` block, `q=tiktok made me buy it` (no filter) [LIVE]:
```json
{"position": 1, "title": "TikTok Made Me Buy It: Must-Have Gadgets by kukoan.afpnicv on TikTok. Play on TikTok. 0:19",
 "source": "TikTok", "profile_name": "kukoan.afpnicv", "duration": "0:19",
 "link": "https://www.tiktok.com/@kukoan.afpnicv/video/7683875697940647181"}
```
The docs example of the same block includes `"date": "3 months ago", "views": "2.4M+ views", "extracted_views": 2400000` [DOCS]. None of the 10 live items carried `views` or `date`.

`engine=google_videos`, `q=site:tiktok.com viral product`, `tbs=qdr:d` [LIVE]:
```json
{"title": "3 winning dropshipping products will go viral in 2026. If you are ...",
 "link": "https://www.tiktok.com/@dailyfulfillsource/video/7690224114677697822",
 "snippet": "53 Likes, TikTok video from dailyfulfillsourcing (@dailyfulfillsource): ...",
 "duration": "0:58",
 "rich_snippet": {"top": {"detected_extensions": {"hours_ago": 13},
                          "extensions": ["TikTok", "dailyfulfillsource", "13 hours ago"]}}}
```

`engine=google_forums`, `q=obsessed with this new product`, `period_unit=d`, `period_value=1` [LIVE]:
```json
{"title": "Why are people obsessed with iPhones and buying ...",
 "link": "https://www.reddit.com/r/Adulting/comments/1wrhmzt/...",
 "displayed_meta": "180+ comments · 16 hours ago",
 "source": "Reddit · r/Adulting"}
```

`engine=google`, `discussions_and_forums` block, `q=best magnesium supplement` [LIVE]:
```json
{"title": "What is the best magnesium supplement and how much we need it ...",
 "link": "https://www.reddit.com/r/Biohackers/comments/pnntk1/...",
 "date": "5 years ago", "extensions": ["r/Biohackers", "4 comments"], "source": "Reddit"}
```
The block is evergreen: the top items were 2 weeks to 5 years old.

`engine=google`, `q=site:kickstarter.com/projects "backers pledged"`, `tbs=qdr:w` [LIVE]:
```json
{"title": "A Non-disposable Digital \"Film\" Camera by Rewindpix ...",
 "link": "https://www.kickstarter.com/projects/rewindpix/rewindpix-a-non-disposable-digital-film-cam...",
 "date": "4 days ago",
 "snippet": "8,925 backers pledged $1,369,135 to help bring this project to life. Last updated September 23, 2026 · Campaign · Rewards · FAQ 21. Updates 15. ..."}
```

## Quota and cost [LIVE, account.json]

| Field | Value |
|---|---|
| Plan | Big Data Plan (`bigdata_v4`) |
| Price | $275.00 / month |
| Searches / month | 30,000 (about $0.0092/search) |
| Used this cycle (after this research) | 24,078 |
| Left | 5,920 |
| Renewal | 2026-10-07 |
| Hourly rate limit | 6,000 |
| Account email | `dev@trendhunter.com`, a **shared account** whose consumer is not Trend Tree |

Rough sizing: one pull per query per day across 3 platforms × 20 queries is about 60/day, or 1,800/month (6% of plan). The real constraint is that the plan is already about 80% consumed by other users of the account this cycle.

Billing observations: the counter moved 24,061 → 24,078 (+17) across 19 calls. The 2 calls rejected for a missing `period_value` were not billed. The Forums call that returned "no results" was billed. [LIVE] The docs state that cached results (identical params within 1 h) are free. [DOCS]

## Unknowns

1. Whether the `short_videos` block's `views`/`date` fields show up for a meaningful share of TikTok items. The docs show them, but 0/10 live items had them. More sampling needed.
2. Whether `lr=lang_en` / `gl=us` meaningfully cleans up `engine=google` `site:tiktok.com` relevance. Untested.
3. How much Google's Reddit index lags. The single past-day result for a 2M-member subreddit suggests heavy under-coverage vs. Reddit's own API. No direct comparison was done.
4. Whether `google_forums` can be restricted to Reddit other than by post-filtering on `source`. Combining it with `site:` returns nothing.
5. Kickstarter pre-launch pages: no query shape was found that isolates genuine pre-launch/"launching soon" projects. `date` never reflects the launch date.
6. Who else consumes the shared `dev@trendhunter.com` quota, and whether Trend Tree may budget against it or needs its own key/plan.
7. The `google_short_videos` source mix without a `site:` filter (TikTok was 2/12 on one generic query). This single sample isn't enough to generalise.
8. SerpApi's own terms on derived/stored data (not reviewed).

## Live query log (19 calls, 17 billed)

| # | UTC | Name | Params (api_key omitted) | Outcome |
|---|---|---|---|---|
| 1 | 03:23:21 | sv_tiktok_w | `engine=google_short_videos&q=site:tiktok.com skincare&tbs=qdr:w` | 12 TikTok, all ≤ 7d |
| 2 | 03:23:27 | sv_plain | `engine=google_short_videos&q=viral kitchen gadget` | 12 mixed (YT3/FB3/IG3/TT2/Pin1) |
| 3 | 03:23:37 | g_tiktok_d | `engine=google&q=site:tiktok.com tiktok made me buy it&tbs=qdr:d&num=10` | 10 fresh, poor relevance |
| 4 | 03:23:38 | g_trend_blocks | `engine=google&q=tiktok made me buy it` | short_videos/inline_videos/perspectives blocks |
| 5 | 03:23:57 | gv_tiktok_d | `engine=google_videos&q=site:tiktok.com viral product&tbs=qdr:d` | 10 fresh, hours_ago |
| 6 | 03:24:09 | gf_d | `engine=google_forums&q=obsessed with this new product&period_unit=d` | error: period_value required (not billed) |
| 7 | 03:24:09 | gf_reddit_w | `engine=google_forums&q=site:reddit.com skincare new launch&period_unit=w` | error: period_value required (not billed) |
| 8 | 03:24:10 | g_reddit_d | `engine=google&q=site:reddit.com/r/SkincareAddiction&tbs=qdr:d&num=10` | 1 result |
| 9 | 03:24:23 | g_forums_block | `engine=google&q=best magnesium supplement` | discussions_and_forums: 3 |
| 10 | 03:24:37 | gf_d | same as 6 + `period_value=1` | 10 forum threads < 1d, 1 Reddit |
| 11 | 03:24:41 | gf_reddit_w | same as 7 + `period_value=1` | no results (billed) |
| 12 | 03:24:53 | g_reddit_w | `engine=google&q=site:reddit.com "just launched" product&tbs=qdr:w&num=10` | 10 Reddit, no date field |
| 13 | 03:25:27 | gf_w | `engine=google_forums&q=new snack flavor&period_unit=w&period_value=1` | 10, mixed forums + spam |
| 14 | 03:25:27 | g_ks_w | `engine=google&q=site:kickstarter.com/projects&tbs=qdr:w&num=10` | 10, mostly update pages |
| 15 | 03:25:32 | g_ks_blocks | `engine=google&q=kickstarter new gadget 2026` | blogs/YouTube/discover pages |
| 16 | 03:25:50 | g_ks_live | `engine=google&q=site:kickstarter.com/projects "backers pledged" -inurl:posts -inurl:community -inurl:comments -inurl:faqs&tbs=qdr:w&num=10` | 10 with backers/pledged |
| 17 | 03:25:51 | g_ks_prelaunch | `engine=google&q=site:kickstarter.com/projects "notify me on launch"&tbs=qdr:w&num=10` | 9, not true pre-launch |
| 18 | 03:26:20 | sv_tiktok_bare_d | `engine=google_short_videos&q=site:tiktok.com&tbs=qdr:d` | 12 random multilingual |
| 19 | 03:27:24 | g_ks_active | `engine=google&q=site:kickstarter.com/projects "pledged of" "days to go"&tbs=qdr:w&num=10` | 1 active campaign |

All calls also carried `gl=us&hl=en`.

## Docs consulted

- Engine index: https://serpapi.com/search-api (sidebar enumerated 2026-09-28)
- Google Forums API: https://serpapi.com/google-forums-api
- Google Short Videos API: https://serpapi.com/google-short-videos-api
- Google `short_videos` block: https://serpapi.com/short-videos
- Google `discussions_and_forums` block: https://serpapi.com/google-discussions-forums
- Google `perspectives` block: https://serpapi.com/perspectives
- Account API: https://serpapi.com/account-api
