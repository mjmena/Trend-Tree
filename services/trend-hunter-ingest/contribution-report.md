# Review the first week of accepted articles

The source owner runs this report after seven complete UTC days of live intake. The first cohort and its publication are pending production enablement. The warehouse fixture contains synthetic cases.

## Freeze the evidence

Use Node 22 or newer and a Snowflake CLI connection with read access to the intake, distillation, attribution and presentation tables. The exporter creates session-temporary analysis tables in `MCC_RAW.MARKETING_DEV`. From the repo root, run the following after the forward checkpoint covers the window. The cutoff below uses the current UTC second. Supply a fixed past UTC timestamp to repeat a recent export.

```sh
export SNOWFLAKE_CONNECTION=claude
cutoff=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node services/trend-hunter-ingest/report.mjs capture "$cutoff" week-packet.json
node services/trend-hunter-ingest/report.mjs prepare week-packet.json > week-review-packet.json
```

The cohort starts at the first midnight at or after `ENABLED_AT_UTC` and ends seven days later, end exclusive. It contains accepted provider items first observed in that interval. Outcomes, native comparisons and subsequent repairs can accumulate through the explicit cutoff. Follow-up is in hours per item or candidate. Native warehouse NTZ clocks use the New York writer convention. An old wall clock in the repeated autumn hour can be ambiguous. New receipt clocks are UTC.

Every production table is read with Snowflake Time Travel at the cutoff. Capture promptly while all source tables still retain that version. The CLI returns an error if a required snapshot is unavailable. Preserve the exported packet, its SHA-256, the code commit and the review file together. Offline rendering can then reproduce the result after warehouse history expires. A later follow-up uses a new cutoff and its own packet and reviews.

## Compare the same movement

1. Start with `week-review-packet.json`. Its selection frame contains every distillation candidate created during the cohort week, including unsuccessful and pending candidates. The first four SHA-256-ranked IDs in each of two strata form the sample. Editorial nomination chains are outside the discovery sample. The strata indicate whether available cohort article evidence supported the candidate at its creation. The fixed seed, ranking and all candidate IDs are retained. This comparison covers candidate-seeded movements. A movement with no emitted candidate is outside the frame.
2. Use the candidate directory to group earlier, later, rejected or deferred descriptions of the **same movement**. Record the specific behavior, who exhibits it, and evidence for the match. The directory extends from seven days before enablement to the cutoff. Use one selected seed per movement. Include every other sampled seed for that movement in `candidates` to count the movement once. Keep unmatched and inconclusive seeds. Use the seed topic only to define the movement.
3. Create `week-reviews.json` using the structure below. Start with empty `judgments` and `facts`, then run `prepare week-packet.json week-reviews.json` to generate the opportunity packets for the selected candidate grouping. Optional `extra_ids` can add relevant signal IDs present in the frozen pools export. The export covers captured evidence cited by cohort items or candidates in the directory. Keep any purposive case outside the sampled denominator.
4. Read the packets in ascending UTC order, one arm at a time. Judge only the signal ID, credited story, source, title, body, rank, ingestion and embedding clocks available in that packet. Fix one atomic consumer search term for both arms. Use the seed query or set `query` on the movement. Decide whether the material documents the same specific movement. Independent reports or observed behavior can supply corroboration. Multiple receipts for one verified release count once. Record `meets`, `does_not_meet` or `uncertain`, the cited IDs and the reason at each plausible earlier opportunity. A missing earlier judgment or unknown native embedding can censor the first-time estimate.
5. A positive review requires a passed pool floor and two independent in-pool IDs with available vectors. The report applies the existing source-family classifier. For one family, record the arm-specific confidence and specificity. Each must reach 0.5. Supply `et_candidate` only when a captured decision for the same movement and query had already confirmed a same-concept Exploding Topics match with meaningful volume. The report verifies the corroboration record and its timestamp. An actual mint appears separately in the promotion history.

The augmented arm uses the recorded main or revisit selection. The native estimate re-ranks eligible native representations under each recorded opportunity's lookback, source cap, global cap, claims and floor. It includes captured native repeat submissions with their own source, receipt and text. A suppressed input can occupy a counterfactual slot while its own vector or later claim history remains unknown. It cannot borrow the feed's vector. The estimate holds the observed schedule and staging claims fixed. A different sequence of claims, earlier unseen submissions, displaced candidates and movements outside the captured support IDs can change the answer. The estimator measures qualification at recorded opportunities.

```json
{
  "packet_sha256": "<hash from prepare>",
  "movements": [{
    "seed": "<selected candidate ID>",
    "candidates": ["<selected candidate ID>", "<earlier ID for the same movement>"],
    "reviewer": "<name>",
    "reason": "<how the records identify the same movement>",
    "judgments": [{
      "op": "<opportunity ID>", "arm": "native", "disposition": "meets",
      "query": "<atomic search term>", "ids": ["<signal ID>", "<independent signal ID>"],
      "confidence": 0.8, "specificity": 0.8,
      "reason": "<what these two contemporaneous records establish>"
    }]
  }],
  "facts": []
}
```

## Reconcile outcomes and fresh facts

```sh
node services/trend-hunter-ingest/report.mjs render week-packet.json week-reviews.json > week-report.json
```

`article_cases` retains original publisher URLs, item and surviving signal IDs, eligibility, first writer, replay origin, native clocks, follow-up, associated candidate IDs and linked target IDs. The two article timing summaries use literal original URL matches. A positive value means the first documented native receipt came later. Pickup uses the provider's `first_seen`. Eligible-poll lead uses the first received usable accepted version. Reconciliation keeps its real poll time. Historical replay items are listed separately. The six instrumented URL lanes and their recorded receipts are shown in `coverage.native_sources`. Within-run deduplication, RSS caps, older discarded native submissions and other lanes limit the comparison. An unmatched case has an unknown lead.

`candidate_cases` traces embedded signal IDs through candidate support. A confirmed pipeline mint requires the candidate's trend identity and a `PROMOTE_NEW` audit for exactly that trend, with the editorial category excluded. Merges require the committed post-decision state. Candidate-to-candidate merges may mirror a reject or defer. Unmatched audits, identities missing an audit and pending candidates remain visible. A native-first article can overlap a successful candidate. Use the first-writer breakdown when describing the feed's contribution.

`link_cases` deduplicates each independent story and trend pair across link kinds. A verified active attribution requires a prior mint, an active lifecycle state at the first accepted observation, a first `attributed` link and the same signal in a collected sweep pool between handling and that link. Membership records the observed top-20 selection, similarity, rank and embedding window. The run uses the last lifecycle evaluation at or before the observation and defaults to `NEW` for a minted trend with no evaluation. It reports prior links, supporting links, inactive targets, pending sweeps and unverified links separately.

For each verified pair, read the article, earlier linked signal records and dated enrichment citations in `prior_facts`. Identify a concrete fact and what the target already documented. Append a `facts` entry containing `story`, `trend`, `reviewer`, `fact`, `reason`, `prior_ids` and a `disposition` of `fresh`, `already_known` or `unknown`. Cite actual prior signal or enrichment IDs. Choose `unknown` when the prior record or article is insufficient. “Fresh” describes the recorded evidence on that trend at receipt. Rerun `render` with the completed review.

## Publish the observed result

Record the UTC bounds, outcome cutoff, receipt coverage against 168 expected hourly slots, checkpoint, source coverage and origin counts. `awaiting_seven_complete_utc_days` leaves the outcome table pending. `incomplete_intake_coverage` gives recorded cases and `observed_subset` counts for the available hours. State the missing coverage alongside any limited yield.

Report the article and independent-story denominators, supported candidates, confirmed new trends, merged targets, distinct active attributed stories, story–trend pairs and target trends. Give pickup and eligible-poll medians with their separate matched/unknown denominators. For discovery, report sample size, reviewed movements, paired positive/zero/negative estimates, median and unknown cases with follow-up. A numeric zero on a confirmed outcome describes the observed window through the cutoff. A null lead or unresolved fresh-fact review remains unknown.

Use `examples` to find real provider IDs in `article_cases`, then cite the publisher URL, receipt time and verified candidate, promotion or trend-link evidence. Include an unlinked case and its follow-up when present. If the complete cohort is empty, publish its measured size and coverage. Preserve the packet and review beside the release record and link the results from the delivery story. [Contribution story](https://mcclatchy.atlassian.net/browse/CRMA-1920)
