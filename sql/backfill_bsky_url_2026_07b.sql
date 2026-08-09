-- One-off backfill 2026-07-09 — class-B Bluesky URL cleanup (#69 follow-up).
--
-- The first backfill (backfill_bsky_url_2026_07.sql) fixed only URLs of the shape
-- `.../post/bsky_<16hex>`. Today's digest surfaced a *second* fabrication class the
-- enrichment agent produced pre-#70:
--   * `.../post/<16hex>`   — the same sha256 fragment, WITHOUT the `bsky_` prefix.
--                            Recoverable: SIGNAL_ID = 'bsky_'||<16hex> is in STG.
--   * `.../post/<junk>`    — invented rkeys (`/post/3`, `/post/meal-prep`,
--                            `/post/asthma`, 404-ing TID look-alikes). No join key.
-- All class-B rows are historical (WRITTEN_AT < the #70 deploy ~2026-07-08 20:00);
-- #70 stopped both classes going forward. Census 2026-07-09: 57 evidence + 6
-- social_narrative instances across ~35 trends; 40 recoverable, 17 not.
--
-- Remediation (decided 2026-07-09):
--   evidence[].url            recoverable → rebuild did: permalink; else DROP the item.
--   social_narrative[].evidence_url
--                             recoverable → rebuild; else STRIP the evidence_url key
--                             (keep the authored `point` text — only the link was bad).
--
-- Mechanism unchanged: rebuild each affected trend's latest PAYLOAD and INSERT a new
-- append-only ledger row (WRITTEN_BY='backfill/bsky-url-2026-07b'); DT_TREND_DASHBOARD's
-- WRITTEN_AT DESC pick surfaces it.
--
-- Recoverable-hash extraction: REGEXP group 2 of `post/(bsky_)?([0-9a-f]{16})` → the
-- 16-hex; SIGNAL_ID='bsky_'||hex; STG METADATA:uri = at://<did>/.../<rkey>.
-- Guards: LEFT JOIN to STG; ARRAY_AGG WITHIN GROUP (ORDER BY idx); evidence rebuild
-- COALESCEs to an empty array if a trend loses all items; only touch a key we rebuilt.

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
-- Trends carrying at least one non-did bsky *post* link (handle-form /post/) in
-- either key. Counts post-links only: bare /profile/<handle> links (no /post/) are
-- valid and must not pull a trend in, or we'd insert no-op rows.
affected AS (
    SELECT TREND_ID FROM latest
    WHERE (REGEXP_COUNT(TO_JSON(PAYLOAD:evidence), 'bsky.app/profile/[^/"]+/post/')
         - REGEXP_COUNT(TO_JSON(PAYLOAD:evidence), 'bsky.app/profile/did:[^/"]*/post/')) > 0
       OR (REGEXP_COUNT(TO_JSON(PAYLOAD:social_narrative), 'bsky.app/profile/[^/"]+/post/')
         - REGEXP_COUNT(TO_JSON(PAYLOAD:social_narrative), 'bsky.app/profile/did:[^/"]*/post/')) > 0
),
-- ---- evidence: recover or drop ----
ev_flat AS (
    SELECT l.TREND_ID, f.index AS idx, f.value AS elem,
           (f.value:url::string ILIKE 'https://bsky.app/profile/%/post/%'
            AND f.value:url::string NOT ILIKE '%/profile/did:%') AS is_bad,
           'bsky_' || REGEXP_SUBSTR(f.value:url::string, 'post/(bsky_)?([0-9a-f]{16})', 1, 1, 'e', 2) AS cand_id
    FROM latest l JOIN affected a USING (TREND_ID),
         LATERAL FLATTEN(input => l.PAYLOAD:evidence) f
),
ev_res AS (
    SELECT e.TREND_ID, e.idx, e.elem, e.is_bad, s.uri
    FROM ev_flat e
    LEFT JOIN stg s ON e.is_bad AND s.SIGNAL_ID = e.cand_id
),
ev_rebuilt AS (
    SELECT TREND_ID,
           ARRAY_AGG(
               CASE WHEN is_bad
                    THEN OBJECT_INSERT(elem, 'url',
                           'https://bsky.app/profile/' || SPLIT_PART(uri, '/', 3)
                           || '/post/' || SPLIT_PART(uri, '/', -1), TRUE)
                    ELSE elem END
           ) WITHIN GROUP (ORDER BY idx) AS new_evidence
    FROM ev_res
    WHERE (NOT is_bad) OR (is_bad AND uri IS NOT NULL)   -- drop unrecoverable items
    GROUP BY TREND_ID
),
ev_bad_trends AS (SELECT DISTINCT TREND_ID FROM ev_res WHERE is_bad),
-- ---- social_narrative: recover or strip (never drop the point) ----
sn_flat AS (
    SELECT l.TREND_ID, f.index AS idx, f.value AS elem,
           (f.value:evidence_url::string ILIKE 'https://bsky.app/profile/%/post/%'
            AND f.value:evidence_url::string NOT ILIKE '%/profile/did:%') AS is_bad,
           'bsky_' || REGEXP_SUBSTR(f.value:evidence_url::string, 'post/(bsky_)?([0-9a-f]{16})', 1, 1, 'e', 2) AS cand_id
    FROM latest l JOIN affected a USING (TREND_ID),
         LATERAL FLATTEN(input => l.PAYLOAD:social_narrative) f
),
sn_res AS (
    SELECT n.TREND_ID, n.idx, n.elem, n.is_bad, s.uri
    FROM sn_flat n
    LEFT JOIN stg s ON n.is_bad AND s.SIGNAL_ID = n.cand_id
),
sn_rebuilt AS (
    SELECT TREND_ID,
           ARRAY_AGG(
               CASE WHEN is_bad AND uri IS NOT NULL
                    THEN OBJECT_INSERT(elem, 'evidence_url',
                           'https://bsky.app/profile/' || SPLIT_PART(uri, '/', 3)
                           || '/post/' || SPLIT_PART(uri, '/', -1), TRUE)
                    WHEN is_bad AND uri IS NULL
                    THEN OBJECT_DELETE(elem, 'evidence_url')
                    ELSE elem END
           ) WITHIN GROUP (ORDER BY idx) AS new_sn
    FROM sn_res GROUP BY TREND_ID
),
sn_bad_trends AS (SELECT DISTINCT TREND_ID FROM sn_res WHERE is_bad),
-- Stage 1: apply evidence rebuild (empty-array guard if a trend lost all items).
ev_applied AS (
    SELECT l.TREND_ID, l.ENRICHMENT_KIND, l.TREND_VECTOR,
           CASE WHEN eb.TREND_ID IS NOT NULL
                THEN OBJECT_INSERT(l.PAYLOAD, 'evidence',
                       COALESCE(er.new_evidence, ARRAY_CONSTRUCT()), TRUE)
                ELSE l.PAYLOAD END AS payload
    FROM latest l
    JOIN affected a USING (TREND_ID)
    LEFT JOIN ev_bad_trends eb USING (TREND_ID)
    LEFT JOIN ev_rebuilt er USING (TREND_ID)
),
-- Stage 2: apply social_narrative rebuild only where it had a bad link.
final AS (
    SELECT e.TREND_ID, e.ENRICHMENT_KIND, e.TREND_VECTOR,
           CASE WHEN sb.TREND_ID IS NOT NULL
                THEN OBJECT_INSERT(e.payload, 'social_narrative', sr.new_sn, TRUE)
                ELSE e.payload END AS new_payload
    FROM ev_applied e
    LEFT JOIN sn_bad_trends sb USING (TREND_ID)
    LEFT JOIN sn_rebuilt sr USING (TREND_ID)
)
SELECT TREND_ID, 'backfill/bsky-url-2026-07b', ENRICHMENT_KIND, new_payload, TREND_VECTOR
FROM final;
