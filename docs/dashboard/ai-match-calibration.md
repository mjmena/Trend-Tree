# AI Match collection and calibration review

The [AI Match requirement](https://github.com/mjmena/Trend-Tree/issues/29)
requires a confirmed collection grain and an editorial-calibrated
cosine-to-percent curve before dashboard exposure. This worksheet prepares
those decisions without inventing percentages or changing the live dashboard.
The [editorial calibration requirement](https://github.com/mjmena/Trend-Tree/issues/30)
describes the labels and sign-off needed.

## Proposed collection rule

Use `CUE_CONTENT_VECTORS.CLUSTER_ID` as the collection key and
`CLUSTER_DESCRIPTION` as its label. Among the latest content-match generation's
top-five retrieved articles, group by cluster and take each group's maximum
cosine. The highest group wins; cluster ID breaks equal-score ties. Its
highest-scoring article provides the supporting headline.

This measures alignment to a collection through its strongest retrieved
article. It does **not** measure coverage of the collection: retrieval stores
at most five articles per trend and excludes scores below 0.60. An average or
matched fraction would describe that truncated sample, not the collection.
The owner must confirm this meaning as well as the cluster grain before it
becomes a dashboard contract.

## Reproduce the review worksheet

Run the read-only query from the repository root:

```sh
snow sql -c claude --enable-templating NONE --format csv \
  -f sql/ai_match_calibration_sample.sql > /tmp/ai-match-calibration.csv
```

Keep generated worksheets and editorial labels in an approved internal
location; this public repository contains the query, not warehouse exports.

The output contains all non-retired dashboard trends, the content-match chain
and timestamp, a proposed top collection, raw cosine, the supporting article,
and blank editorial labels. `RETRIEVED_ARTICLES` counts the selected cluster's
articles within the top-five retrieval, not the entire content collection.

The query reads CUE metadata **at query time**. The match ledger does not store
cluster IDs or descriptions, so this is a worksheet, not a reproducible
historical assignment. A production implementation must snapshot the confirmed
collection metadata when computing a match generation. Duplicate CUE content
IDs are reduced deterministically before joining, so they cannot multiply
matches.

A missing proposed collection is **unknown**, not 0%: it can mean no article
cleared the retrieval threshold, missing cluster metadata, or a trend promoted
after the last nonempty match generation. An entirely empty recompute leaves
no ledger rows and cannot be distinguished from the preceding generation.
These cases must remain distinct from an editorial judgment of no alignment.

## Review inputs

Before the percentage can ship, the field owner/editorial review must provide:

1. The collection grain (CUE cluster or CSA section) and aggregation meaning
   (strongest-article alignment or another defined measure).
2. Labeled examples across strong, borderline, weak, and absent retrievals,
   including the expected collection and desired percentage.
3. An approved monotonic cosine-to-percent curve in the **768-dimensional
   arctic-m-v1.5, trend-name + short-summary** space, with endpoint and missing
   evidence behavior. The separate 1024-dimensional trend space and prediction
   descriptor thresholds cannot supply this curve.

The existing 0.60 retrieval cutoff was checked for article relevance under
CRMA-452. It does not establish what 0%, 50%, or 100% alignment means. Neither
`cosine * 100` nor an arbitrary stretch above 0.60 meets CRMA-454's requirement
for an editorial-calibrated mapping.

After those inputs are recorded, implementation can test the documented
mapping, snapshot collection metadata, expose the additive dashboard columns,
and verify a plausible collection **and percentage** against the approved
sample. SQL deployment is separate from a GitHub merge.
