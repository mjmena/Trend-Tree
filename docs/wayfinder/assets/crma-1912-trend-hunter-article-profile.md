# Trend Hunter article intake, November 13–19, 2026

Trend Hunter returned **2,513 accepted articles** first seen during these seven UTC days. Each had a distinct original article URL. Those URLs spanned 204 hosts, with 421 on PR Newswire (16.8%). The 140 rejected articles sampled across the same week contributed 140 more distinct URLs. Acceptance means Trend Hunter selected an item for a write-up. Whether it could advance a Trend Tree discovery requires a separate comparison. Measured November 20, 2026. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles) · [API field definitions](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)

## Volume and article evidence

| UTC date in November | Fri 13 | Sat 14 | Sun 15 | Mon 16 | Tue 17 | Wed 18 | Thu 19 | Week |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All accepted IDs | 359 | 150 | 116 | 410 | 519 | 487 | 472 | **2,513** |
| Rejected IDs sampled | 20 | 20 | 20 | 20 | 20 | 20 | 20 | **140** |

Each column below uses the cohort size in its heading unless it gives a different denominator. Counts are from the provider's [article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles).

| Measure | All accepted (2,513) | Rejected sample (140) |
| --- | ---: | ---: |
| Usable original URL | 2,513 | 140 |
| Distinct hosts of original URLs | 204 | 63 |
| Distinct provider feed labels (`source`) | 195 | 61 |
| Extra rows sharing an exact URL / normalized URL | 0 / 0 | 0 / 0 |
| Headline present | 2,513 | 140 |
| Source summary present | 2,510 | 136 |
| Trend Hunter write-up URL present (`th_article_url`) | 2,019 | 0 |
| Provider text kind `full` / `excerpt` / `summary_only` / `none` | 2,405 / 0 / 108 / 0 | 28 / 0 / 108 / 4 |
| `first_seen` with explicit time zone | 2,513 | 140 |
| `published_at` with explicit time zone / missing | 2,501 / 12 | 137 / 3 |

The `source` field names the intake feed. Five accepted feed labels led to multiple hosts, one to 30. Fifteen accepted hosts appeared under multiple labels. The largest hosts were `prnewswire.com` (421), `parade.com` (178) and `notebookcheck.net` (171). The rejected sample shared 46 hosts with the accepted cohort, with zero shared article URLs under either matching rule. A host identifies the site serving the URL. Wire syndication and stories about the same underlying event can span multiple URLs and hosts, so independent evidence requires article-level review. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles) · [Field definitions](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)

## Timing and verdicts

Among the **2,501 accepted articles with both timestamps**, `first_seen − published_at` had a median of 45 minutes and a 90th percentile of 1 hour 46 minutes. Sixteen publication times fell after pickup, 27 preceded it by more than a day, and the oldest was 29.9 days before pickup. Among the **137 sampled rejects with both timestamps**, the median was 59 minutes and the 90th percentile was 6 hours. Seven publication times fell after pickup and seven preceded it by more than a day, with a maximum of 970.5 days. The percentiles include negative intervals. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles)

The list defines `first_seen` as Trend Hunter’s pickup time. Publisher time describes the source article and can precede pickup by years. The API supplies the current status and verdict without a timestamp for editorial selection. A retrospective `first_seen` is therefore a proxy for availability. A prospective discovery comparison can record when a pilot poll first observes a qualifying article and compare that time with Trend Tree’s own evidence. [Article definitions](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)

Every accepted article had verdict `queued` (2,513/2,513). Sampled rejects had `prefilter_reject` (105/140), `screen_reject` (30/140), `fetch_failed` (4/140) and `duplicate_trend` (1/140). All 140 included a rejection reason. A separate whole-week request for `status=rejected&verdict=screen_error&limit=1` returned an empty terminal page. This independently confirms zero returned `screen_error` items for the window. The other rejected verdict counts and text-kind counts describe the 140 sampled items. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles) · [Verdict definitions](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)

## Repeatable request recipe

1. Send authenticated `GET /api/integrations/tie-signals/v1/articles` with `status=accepted`, `from=2026-11-13T00:00:00Z`, `to=2026-11-20T00:00:00Z`, `sort=oldest`, `limit=100` and `fields=-text`. For each page, pass its `next_cursor` as `cursor` with the same filters until `next_cursor` is null. The 26 pages returned 2,513 rows and 2,513 unique IDs. Check each row’s status and inclusive-start, exclusive-end `first_seen` window. [Paging and filters](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)
2. Within each UTC day, divide the day at 00:00, 06:00, 12:00, 18:00 and the following midnight. Issue one request per six-hour interval with `status=rejected`, its own `from` and `to`, `sort=oldest`, `limit=5` and `fields=-text`. Take only the first page in each interval. All 28 returned five distinct IDs and a further cursor. This gives each interval equal weight and favors the earliest arrivals in it. The weekly rejected total, acceptance rate and rejected population shares are unknown. The separate `screen_error` check contributed zero rows to the sample. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles)
3. Count a usable original `url` when it parses as HTTP(S) with a hostname, a valid port if supplied and no embedded credentials. Every observed URL also had a path or query beyond the site root and an external host. Measure the host in lowercase, dropping one leading `www.` and a trailing dot. Keep other subdomains. Live reachability, redirects, common ownership and syndication were outside this metadata check. [URL and feed definitions](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)
4. Check duplicates by exact URL and again after lowercasing scheme and host, dropping default ports and fragments, setting an empty path to `/`, removing `utm_*`, `fbclid`, `gclid`, `dclid`, `mc_cid`, `mc_eid` and `msclkid`, and sorting the remaining query key/value pairs. Count nonblank strings for headline and summary. `fields=-text` returned `text: null` throughout. Text availability comes from the provider’s `text_kind`. [Article list](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/articles) · [Text and metadata fields](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)
