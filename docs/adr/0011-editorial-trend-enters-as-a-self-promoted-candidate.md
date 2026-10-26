# An editorial trend enters as a candidate that the endpoint promotes itself

**Status:** accepted (2026-10-26). Decided on
[CRMA-1429](https://mcclatchy.atlassian.net/browse/CRMA-1429), on the
[CRMA-1424](https://mcclatchy.atlassian.net/browse/CRMA-1424) map for an endpoint that
ingests an editorial trend.

## Context

An editorial trend is a trend that a person nominates by hand from ATLAS. CRMA-1425
fixed what ingesting one guarantees: a valid request always becomes a trend on ATLAS,
or returns the live trend it duplicates. No judgment rejects it. The person supplies
one or more URLs, and each URL becomes a linked signal.

Three facts about the pipeline constrained where such a trend can enter:

- **`PROC_PROMOTION_APPLY` is the only writer of `FCT_TRENDS`, and
  `FCT_TRENDS.CANDIDATE_ID` is `NOT NULL`.** Every trend comes from a candidate.
- **`PROC_PROMOTION_APPLY` accepts decisions from any caller.** It takes a VARIANT
  array of `PROMOTE_NEW` / `MERGE_INTO_EXISTING` / … decisions. The promotion agent is
  one caller, not a required step (`sql/proc_promotion_apply.sql:9-27`).
- **The promotion agent reads only candidates with `VERDICT IS NOT NULL`**
  (`promotion-p_xMC99jg/workflow.yaml`, the candidate query). A candidate with no
  distillation verdict never enters its queue.

## Decision

The endpoint takes three steps for each request:

1. It merges the person's URLs into `STG_EXTERNAL_SIGNALS` through
   `MERGE_EXTERNAL_SIGNALS`, after post-verification. It passes one `AGENT_SESSION_ID`
   for the request, so distillation cannot acquire these signals and cluster them into
   a second candidate.
2. It inserts one `STG_TREND_CANDIDATES` row with `VERDICT` NULL, the same
   `AGENT_SESSION_ID`, and the signal IDs in `SUPPORTING_SIGNAL_IDS`.
3. It calls `PROC_PROMOTION_APPLY` for that candidate. A new trend gets `PROMOTE_NEW`,
   and the endpoint then POSTs the dispatcher, the same way the promotion workflow's
   `fire_enrichment_chain` step does. A duplicate gets `MERGE_INTO_EXISTING` with the
   matching live trend as `target_trend_id`, and no dispatch.

`TASK_PROMOTE_TREND_SIGNALS` then writes the `supporting` links from
`SUPPORTING_SIGNAL_IDS`, for `PROMOTED_TO` and for `DEDUP_OF_TREND_ID` alike.

If step 3 fails, the endpoint returns an error. The candidate from step 2 stays in
place. No agent reads a candidate with `VERDICT` NULL, so the row is inert.

## Considered options (and why rejected)

- **As signals only.** Rows in `STG_EXTERNAL_SIGNALS`, and distillation decides whether
  a candidate forms. Rejected: distillation can form no candidate, and that is a
  judgment that rejects the trend. It breaks the CRMA-1425 guarantee.
- **As a hint.** Recognition context in the cluster-agent prompt, as CRMA-498 does for
  white-space predictions. Rejected for the same reason: a hint only biases a judgment.
- **As a candidate that the promotion agent judges.** Rejected: the promotion gate and
  the agent's `REJECT` / `DEFER` verdicts stand between the request and a trend.
- **As a direct `FCT_TRENDS` row.** Rejected: it needs a second writer beside
  `PROC_PROMOTION_APPLY` and a fake `CANDIDATE_ID`. It also gives up the ledger seeds
  and the `supporting` links that the proc and the link task already produce.

## Consequences

- `STG_TREND_CANDIDATES` gets a second writer beside distillation. A candidate with
  `VERDICT` NULL and a `PROMOTED_AT` now means "self-promoted by the endpoint", not
  "distillation forgot a verdict". Readers that assume every candidate carries a verdict
  must allow for this.
- The promotion gate's two-source doctrine (ADR-0004) does not apply to an editorial
  trend. An editorial trend can have one source family.
- The endpoint, not the promotion workflow, owns the enrichment dispatch for its trend.
- A URL that another session claimed first keeps that claim. It still links to the
  editorial trend, so one signal can sit under two trends.
- How an editorial trend stays distinguishable from a discovered trend is a separate
  decision ([CRMA-1430](https://mcclatchy.atlassian.net/browse/CRMA-1430)). This ADR
  fixes only the entry point.
