<!-- map: CRMA-1911 -->

# Pilot earlier trend discovery with Trend Hunter articles

## Destination

Define a one-week pilot that can tell whether Trend Hunter's third-party article feed would help Trend Tree discover an emerging trend earlier. The pilot specification must also show how to measure fresh evidence for existing ATLAS trends and what results would justify adopting the feed. [Jira map](https://mcclatchy.atlassian.net/browse/CRMA-1911)

## Notes

- Use seven complete UTC days of accepted articles and a sample of rejected articles. Keep the sampling rule, observation window and denominators with the results. A useful comparison follows a story from the first available article through the evidence Trend Tree had when it could first identify the trend.
- Use the vocabulary in [Trend Tree's domain model](../../CONTEXT.md). A source is how an article reaches Trend Tree. The publisher is the publication that originated it. A candidate can become a trend through promotion. ATLAS is where teams use that trend intelligence. See McClatchy Knowledge's *ATLAS – Audience Trends and Learning Activation System*, dated November 12, 2026, and its [product reference](https://mcclatchy.atlassian.net/wiki/spaces/ATLAS/pages/2081161217/ATLAS+Features+Capabilities).
- Use the research skill for empirical questions and the grilling and domain-modeling skills for decisions. Follow the [Trend Tree tracker conventions](../agents/issue-tracker.md#wayfinding-operations).

## Established facts

- On November 20, 2026, the article-scoped key returned six distinct accepted articles across two pages, three rejected articles, and a matching detail record. The API defines acceptance as selection for a Trend Hunter write-up. It filters dates on the provider's `first_seen`. With `fields=-text`, the sampled list rows contained `"text": null`. [Trend Hunter TIE API reference](https://nxt.trendhunter.com/api/integrations/tie-signals/v1/docs)
- On November 20, 2026, Trend Tree's staging merge matched on `SIGNAL_ID` and preserved the first writer's article metadata. Cross-feed duplicates therefore need an explicit matching rule in the comparison. [Signal merge](../../sql/proc_merge_external_signals.sql) · [Source identity decision](../adr/0010-source-name-carries-one-entry-mechanism.md)
- On November 20, 2026, distillation could use incoming signals to propose candidates, and the hourly attribution job could link new evidence to an active trend. The two outcomes have different timestamps and can be measured separately. [Distillation intake](../../distillation-p_mkCBBqb/acquire_signal_ids/entry.js) · [Attribution job](../../services/attribution/README.md)

## Standing constraints

- Earlier discovery is the primary outcome. Independently verified new evidence for an existing trend is the secondary outcome.
- An original publisher article supplies evidence. Trend Hunter's editorial verdict belongs to its provenance. Trend Tree applies its own promotion criteria, and the same article arriving through two feeds counts once.

## Decisions so far

## Not yet specified

The sample may reveal whole periods or publishers where the two systems cannot be compared reliably. The map will revisit the observation window or the pilot population if that materially changes what the measured lead time means.

## Out of scope

- Production deployment, scheduled ingestion and historical writes to the live pipeline belong to a subsequent implementation decision.
- Trend Hunter's scored-signal endpoints require separate access. The pilot concerns articles and uses Trend Tree's existing promotion, prediction and heat rules.
