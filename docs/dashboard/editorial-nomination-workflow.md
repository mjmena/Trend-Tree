<!-- Title: Trend Tree Editorial Nomination Workflow -->
<!-- Parent: ATLAS Dashboard -->

**Audience:** Jason Smith and the ATLAS product team.

**Purpose:** Show how an editorial nomination moves from the ATLAS form to the dashboard, and where an editorial trend sits next to the trends the pipeline discovers. The request contract for developers is on [Trend Tree Editorial Nomination API](editorial-nomination-api.md).

**Last updated:** 2026-11-10.

## Two words first

- An **editorial trend** is a trend that a strategist or an editor nominates by hand from ATLAS. It is **not** the trend entity that Trend Hunter editors write in the Trend Hunter CMS. The Product Growth Squad uses the same phrase for that CMS entity.
- A **discovered trend** is a trend the pipeline finds on its own, from signals that the discovery agents and the ingestion sources collect.

Both kinds of trend are rows in the same dashboard table, `DT_TREND_DASHBOARD`. One column, `TREND_ORIGIN`, tells them apart: `EDITORIAL` or `DISCOVERED`.

## The flow

```
 ATLAS form                      Trend Tree (in the background, about 1-3 minutes)
 ----------                      ---------------------------------------------------
 person writes a brief
 and 1-10 URLs
      |
      v
 ATLAS backend --POST--> editorial-ingest
                          checks each URL
                          |
                          +-- every URL dead ------> 422: ATLAS shows the reasons
                          |
                          +-- accepted ------------> 202: "the trend appears later"
                                  |
                                  v
                          writes a topic from the brief and the page titles
                                  |
                                  v
                          compares the topic with every trend, retired ones too
                                  |
              +-------------------+---------------------+
              |                   |                     |
          no match          match: live trend     match: retired trend
              |                   |                     |
              v                   v                     v
          NEW trend         URLs attach as         URLs attach, trend
          origin EDITORIAL  evidence; trend        comes back RESURGENT;
          named + enriched  keeps its origin       keeps its origin
              |              (usually DISCOVERED)  (usually DISCOVERED)
              |                   |                     |
              +-------------------+---------------------+
                                  |
                                  v
                    DT_TREND_DASHBOARD (refreshes every ~15 minutes)
                    same table, same scores, same lifecycle as every trend
```

## Step by step

1. A person fills in the ATLAS form: a short brief in their own words and one to ten URLs that show the trend.
2. ATLAS sends the nomination to Trend Tree. Trend Tree checks each URL and drops only the dead or malformed ones.
3. If at least one URL survives, Trend Tree answers `202` at once. ATLAS can tell the person that the trend appears later. If every URL is dead, Trend Tree answers `422` with the reasons, and the person can fix the URLs.
4. In the background, Trend Tree writes a topic for the trend and compares it with every trend it already has, including retired trends.
5. The URLs become evidence for the trend, under the source name `editorial`.
6. One of three outcomes follows. The next section describes each one.
7. The dashboard table refreshes about every 15 minutes. A new trend can take up to about 20 minutes to show in ATLAS.

A valid nomination is never rejected on judgment. It always becomes a new trend or adds evidence to a trend that exists.

## The three outcomes

| Outcome | When | What the dashboard shows |
| --- | --- | --- |
| **New trend** | No trend matches the topic | A new row with `TREND_ORIGIN = 'EDITORIAL'` and `LIFECYCLE_STATUS = 'NEW'`. The pipeline names and enriches it like any other trend. |
| **Merged into a live trend** | A trend that is not retired matches | No new row. The URLs attach to the matching trend as evidence. That trend keeps its own origin, usually `DISCOVERED`. |
| **Merged into a retired trend** | A retired trend matches | No new row. The URLs attach, and the trend returns with `LIFECYCLE_STATUS = 'RESURGENT'`. It keeps its own origin, usually `DISCOVERED`. |

**The merge case matters for the display.** A nomination that matches a discovered trend does not make that trend editorial. Origin records how a trend first came to exist, and a later nomination does not change it. The dashboard has no column that marks the merge.

## Where editorial trends sit next to discovered trends

An editorial trend is a normal trend after it is created:

- It sits in the same table, `DT_TREND_DASHBOARD`, as every discovered trend.
- It gets the same scores. `HEAT_INDEX`, `PREDICTION_SCORE` and the opportunity score do not read the origin, so a nomination does not raise or lower a trend's score.
- It moves through the same lifecycle: `NEW`, `GROWING`, `STABLE`, `DECLINING`, `DORMANT`, `RESURGENT`, `RETIRED`.
- Discovery keeps adding evidence to it, the same way it does for a discovered trend.

## Tag or separate tab

`TREND_ORIGIN` supports both displays. Neither needs a backend change.

- **A tag:** show a badge on every row where `TREND_ORIGIN = 'EDITORIAL'`. Editorial and discovered trends stay in one list.
- **A separate tab:** filter the list on `TREND_ORIGIN = 'EDITORIAL'` for the editorial tab, and on `'DISCOVERED'` for the other.

The choice is an ATLAS decision. One effect of the merge case applies to both, and most to the tab: **a nomination that merges into a discovered trend does not appear in an editorial tab and gets no tag.** The person nominated it, but the trend they see stays discovered. If the separate tab must show every nomination, ATLAS needs the outcome of each nomination, not only the origin of each trend.

## What is not settled yet

- **The outcome of each nomination.** Today ATLAS gets only the `202`. Nothing on the dashboard links a nomination to the trend it created or merged into, and ATLAS cannot see a nomination that failed in the background. Trend Tree is deciding how ATLAS reads that outcome on the map [Map: editorial nomination outcomes for ATLAS](https://mcclatchy.atlassian.net/browse/CRMA-1719).
- **A test path.** Every accepted nomination writes to production. ATLAS builds against a mock until a test path is decided on the same map.
- **No real nomination has run yet.** The endpoint is live since 2026-10-26. The only two nominations so far were Trend Tree's own deploy tests.
