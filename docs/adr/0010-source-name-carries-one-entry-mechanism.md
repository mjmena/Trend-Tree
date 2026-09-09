# A source name carries exactly one entry mechanism

**Status:** accepted (2026-09-08). Decided on
[CRMA-1006](https://mcclatchy.atlassian.net/browse/CRMA-1006), the last decision
on the CRMA-977 intake-sources map.

## Context

`CONTEXT.md` names three entry mechanisms — direct platform source, discovery
agent, agent search tool — and flags that `SOURCE_NAME` does not encode which
one produced a signal. Three names are mixed or tool-provenance: `bluesky` and
`google_trends_explore` are written by both a passive ingester and an agent
search tool, and `gdelt` is now written only by `search-gdelt`. Telling passive
from tool-sourced signals today means parsing `METADATA.search_query`. The
shared naming was accidental — the search tools simply reused the platform
label — and `CONTEXT.md` has carried it as a cleanup target since 2026-05-28.

The CRMA-977 map adds three sources at once — Reddit (ADR-0006), TikTok
(ADR-0009), Kickstarter (ADR-0008) — all direct platform sources, all
vendor-scraped through `scrape-gateway`. Deciding their names one platform at a
time is how the current inconsistency was created, so the map deferred all
three to a single decision.

Two properties of the existing pipeline constrained the answer far more than
the naming question itself.

**`sourceFamilyOf()` treats an unlisted name as its own family.**
`agents/lib/promotion_gate.mjs:42` falls through to `return s`. The promotion
gate's two-source doctrine (ADR-0004) counts distinct source *families*, and the
`amazon` and `google_trends` prefix rules above that fallthrough exist precisely
to stop two variants of one platform reading as independent corroboration. Any
scheme that gives one platform two source names therefore lets a single-platform
candidate clear a gate designed to require two.

**The signal MERGE is insert-only on `SIGNAL_ID`.**
`sql/proc_merge_external_signals.sql` updates only `AGENT_SESSION_ID` on a
match. `SOURCE_NAME` and `METADATA` are frozen by whichever writer arrives
first and are never corrected. A source name that depends on *which* lane or
*which* caller reached a URL first is therefore not a stable fact about the row.

## Decision

**A source name identifies the platform and exactly one entry mechanism.** The
name is the provenance record; no `METADATA` provenance flag is written.

- A **direct platform source** takes the bare platform name — `tiktok`,
  `reddit`, `kickstarter`.
- An **agent search tool** on a platform that already has a source takes
  `<platform>_search`. It never reuses the ingester's name.
- A **discovery agent** keeps the existing `agent_<model>_discovery` form.

**One platform, one family — enforced in the same change.** Any new source name
on a platform that already has one must ship its `sourceFamilyOf()` collapse
rule in that same change, so the two names count as one family at the promotion
gate. Nothing is added to `sourceFamilyOf()` preemptively: while each platform
has one name, the existing fallthrough is already correct.

**TikTok's two lanes share the name `tiktok`.** ADR-0009 runs a `profile_url`
lane and a `#`-keyword lane. Both write signals under `tiktok`, with the lane
recorded as a `METADATA.lane` key.

**`tiktok` is reused, not retired.** The 445 rows written by the Creative Center
hashtag scraper before 2026-05-15 keep the name.

**The existing mixed names are not migrated here.** `bluesky`,
`google_trends_explore` and `gdelt` stay as they are, tracked on
[CRMA-1026](https://mcclatchy.atlassian.net/browse/CRMA-1026). `grok_live` also
predates this rule and keeps its name.

## Considered options (and why rejected)

**A dedicated `METADATA.entry_mechanism` flag** — the option `CONTEXT.md` names
first. Rejected because it would be written by 3 of 17 sources. A consumer
reading the other 14 still needs the `CONTEXT.md` lookup table, so the flag
buys no query it could not already write, while presenting itself as
authoritative on rows where it is absent. Backfilling it across every existing
source is the migration this decision defers to CRMA-1026.

**A source name per TikTok lane** (`tiktok_creator` / `tiktok_keyword`).
Rejected on the family bug above: the lanes' measured coverage overlap is 1 in
239 (CRMA-1023), so a candidate drawing from both would show two families from
one platform. The insert-only MERGE compounds it — on that overlap the recorded
lane freezes to whichever pull arrived first and never corrects, so a per-lane
source name would be wrong on exactly the rows where it mattered.

**A fresh name for the reopened TikTok source** (`tiktok_video`). Rejected
because it reintroduces the same bug against history rather than against the
present. The 445 retired hashtag rows are still in `FCT_SIGNALS` and still
reachable by `distillation-revisit`, so a candidate could draw one 2026-05
`tiktok` signal plus new `tiktok_video` signals and present two families from
one platform. Reusing the name makes that impossible by construction, and the
two eras stay distinguishable by `METADATA` — the retired rows carry `hashtag`
and `rank`, the new rows carry `lane`.

## Consequences

The three new sources are unambiguous by name, and the ambiguity `CONTEXT.md`
flags cannot spread to a fourth platform. It is not resolved for the three names
that already carry it; those stay mixed until CRMA-1026 is worked.

The rule has teeth only if the family-collapse requirement travels with it. A
future `search-reddit` that writes `reddit_search` without adding
`if (s.startsWith("reddit")) return "reddit"` to `sourceFamilyOf()` would let
Reddit alone satisfy the two-source doctrine. That failure is silent — it
promotes trends rather than throwing — which is why the requirement is stated as
part of this decision rather than left to the implementing ticket. Note that
`agents/lib/promotion_gate.mjs` is inlined into
`promotion-p_xMC99jg/run_lead_agent/entry.js`, so both copies move together.

`sourceFamilyOf()` needs no change today. `tiktok`, `reddit` and `kickstarter`
each fall through to their own family, which is correct.

CRMA-989's audit registry stays exactly three entries — `tiktok`, `reddit`,
`kickstarter` — because the TikTok lanes share a name.

The source name is also the distillation quota unit: `acquire_signal_ids`
partitions by `SOURCE_NAME` and caps each at 320 slots per run. TikTok's two
lanes share one cap. At ADR-0009's 157–262 usable videos per day that is not
binding, but it becomes binding if either lane's volume grows.
