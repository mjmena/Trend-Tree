-- One-off backfill, 2026-07-08 — repair fabricated Bluesky post URLs (#69).
--
-- Root cause: the legacy `ingest_search_bluesky` enrichment tool never returned a
-- resolvable permalink. It handed the agent `signal_id` (`bsky_<sha256[:16]>`) +
-- `author_handle`, and the agent fabricated `bsky.app/profile/<handle>/post/<signal_id>`.
-- A sha256 fragment is not a valid AT-Protocol rkey, so those URLs 404.
-- Forward fix: #70 (tool now returns the canonical DID permalink) — on `production`.
--
-- Recovery key: the `bsky_<hash>` embedded in each broken URL *is* the join key —
-- it equals STG_EXTERNAL_SIGNALS.SIGNAL_ID, whose METADATA:uri retains the real
--   at://<did>/app.bsky.feed.post/<rkey>
-- from which we rebuild  https://bsky.app/profile/<did>/post/<rkey>  (200-resolving,
-- verified via public.api.bsky.app getPostThread).
--
-- Scope (decided 2026-07-08): the two dashboard-/digest-surfaced payload keys only —
--   * PAYLOAD:evidence[].url
--   * PAYLOAD:social_narrative[].evidence_url
-- Latest-per-trend rows: 79 evidence + 10 social_narrative instances across 41 trends,
-- all 88 hashes 100% recoverable via STG. The raw `llm_responses` transcript blob
-- (89 more instances, not surfaced anywhere) is deliberately LEFT UNTOUCHED — it is
-- honest audit history of what the agent actually emitted.
--
-- Method (ledger is append-only since the 2026-04-28 refactor; DT_TREND_DASHBOARD
-- takes latest-per-trend by WRITTEN_AT DESC): rebuild each affected trend's latest
-- PAYLOAD with corrected URLs and INSERT it as a NEW row (new ENRICHMENT_ID + later
-- WRITTEN_AT via defaults). Dashboard surfaces the corrected row automatically; the
-- buggy row stays as history. No in-place UPDATE, no view change, no LLM re-run.
--
-- Idempotent: `affected` selects only trends whose *current* latest row still carries
-- a broken URL in one of the two keys, so a re-run after success is a no-op.
--
-- Guards against silent array corruption:
--   * LEFT JOIN to STG (never inner) so non-bsky evidence elements pass through.
--   * ARRAY_AGG ... WITHIN GROUP (ORDER BY idx) preserves element order.
--   * A key is rewritten only when its rebuild CTE produced a non-null array
--     (guarded CASE, not OBJECT_INSERT(..., NULL, ...)). 3 affected trends carry an
--     explicit `social_narrative: null`; a blind OBJECT_INSERT would drop that key.
--     The guard leaves every non-rebuilt key byte-identical.

INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  (TREND_ID, WRITTEN_BY, ENRICHMENT_KIND, PAYLOAD, TREND_VECTOR)
WITH latest AS (
    SELECT TREND_ID, PAYLOAD, ENRICHMENT_KIND, TREND_VECTOR
    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) = 1
),
stg AS (
    SELECT SIGNAL_ID, METADATA:uri::string AS uri
    FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS
    WHERE METADATA:uri IS NOT NULL
),
-- Only trends whose current latest row still has a broken URL in a targeted key.
affected AS (
    SELECT TREND_ID
    FROM latest
    WHERE REGEXP_COUNT(TO_JSON(PAYLOAD:evidence), 'post/bsky_') > 0
       OR REGEXP_COUNT(TO_JSON(PAYLOAD:social_narrative), 'post/bsky_') > 0
),
-- ---- evidence[].url rebuild ----
ev_flat AS (
    SELECT l.TREND_ID, f.index AS idx, f.value AS elem,
           REGEXP_SUBSTR(f.value:url::string, 'bsky_[0-9a-f]+') AS hash
    FROM latest l
    JOIN affected a USING (TREND_ID),
         LATERAL FLATTEN(input => l.PAYLOAD:evidence) f
),
ev_join AS (
    SELECT e.TREND_ID, e.idx,
           CASE WHEN s.uri IS NOT NULL
                THEN OBJECT_INSERT(e.elem, 'url',
                       'https://bsky.app/profile/' || SPLIT_PART(s.uri, '/', 3)
                       || '/post/' || SPLIT_PART(s.uri, '/', -1), TRUE)
                ELSE e.elem END AS elem
    FROM ev_flat e
    LEFT JOIN stg s ON s.SIGNAL_ID = e.hash
),
ev_rebuilt AS (
    SELECT TREND_ID, ARRAY_AGG(elem) WITHIN GROUP (ORDER BY idx) AS new_evidence
    FROM ev_join GROUP BY TREND_ID
),
-- ---- social_narrative[].evidence_url rebuild ----
sn_flat AS (
    SELECT l.TREND_ID, f.index AS idx, f.value AS elem,
           REGEXP_SUBSTR(f.value:evidence_url::string, 'bsky_[0-9a-f]+') AS hash
    FROM latest l
    JOIN affected a USING (TREND_ID),
         LATERAL FLATTEN(input => l.PAYLOAD:social_narrative) f
),
sn_join AS (
    SELECT n.TREND_ID, n.idx,
           CASE WHEN s.uri IS NOT NULL
                THEN OBJECT_INSERT(n.elem, 'evidence_url',
                       'https://bsky.app/profile/' || SPLIT_PART(s.uri, '/', 3)
                       || '/post/' || SPLIT_PART(s.uri, '/', -1), TRUE)
                ELSE n.elem END AS elem
    FROM sn_flat n
    LEFT JOIN stg s ON s.SIGNAL_ID = n.hash
),
sn_rebuilt AS (
    SELECT TREND_ID, ARRAY_AGG(elem) WITHIN GROUP (ORDER BY idx) AS new_sn
    FROM sn_join GROUP BY TREND_ID
),
-- Stage 1: apply the evidence rebuild only when it produced a non-null array.
ev_applied AS (
    SELECT l.TREND_ID, l.ENRICHMENT_KIND, l.TREND_VECTOR,
           CASE WHEN ev.new_evidence IS NOT NULL
                THEN OBJECT_INSERT(l.PAYLOAD, 'evidence', ev.new_evidence, TRUE)
                ELSE l.PAYLOAD END AS payload
    FROM latest l
    JOIN affected a USING (TREND_ID)
    LEFT JOIN ev_rebuilt ev USING (TREND_ID)
),
-- Stage 2: apply the social_narrative rebuild the same way, on top of stage 1.
final AS (
    SELECT e.TREND_ID, e.ENRICHMENT_KIND, e.TREND_VECTOR,
           CASE WHEN sn.new_sn IS NOT NULL
                THEN OBJECT_INSERT(e.payload, 'social_narrative', sn.new_sn, TRUE)
                ELSE e.payload END AS new_payload
    FROM ev_applied e
    LEFT JOIN sn_rebuilt sn USING (TREND_ID)
)
SELECT TREND_ID, 'backfill/bsky-url-2026-07', ENRICHMENT_KIND, new_payload, TREND_VECTOR
FROM final;
