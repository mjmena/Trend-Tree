-- FN_TREND_EMBED_DOC — single source of truth for the text doc that gets
-- embedded into FCT_TREND_ENRICHMENT_LEDGER.TREND_VECTOR
-- (SNOWFLAKE.CORTEX.EMBED_TEXT_1024 / 'snowflake-arctic-embed-l-v2.0', 1024-dim).
--
-- Called inline by:
--   * PROC_ENRICHMENT_APPLY  — go-forward, whenever the write workflow passes
--     a NULL vector (the normal case).
--   * backfill_enrichment_vector_recipe.sql — one-time re-embed of the current
--     vector for every trend.
-- Keeping both on this one UDF guarantees go-forward and historical vectors
-- share one recipe, so DT_TREND_DASHBOARD.RELATED_TRENDS cosine stays coherent.
--
-- Recipe (issue #26): TREND_TOPIC | summary_long | cultural-driver names |
-- social-narrative points. Article/evidence titles are intentionally EXCLUDED
-- — those are noisy publisher headlines, and article-level matching lives in
-- the separate 768-dim content-match space (issues #27-#29), not in this
-- internal trend-identity vector.
--
-- A SQL UDF can't FLATTEN its VARIANT argument (Snowflake rejects the subquery),
-- so this is JavaScript — it also mirrors the construction PROC_ENRICHMENT_APPLY
-- would otherwise do in Python.

CREATE OR REPLACE FUNCTION MCC_RAW.MARKETING_DEV.FN_TREND_EMBED_DOC(TOPIC VARCHAR, PAYLOAD VARIANT)
RETURNS VARCHAR
LANGUAGE JAVASCRIPT
COMMENT = 'Canonical trend-embedding doc (arctic-embed-l-v2.0/1024). Recipe: TREND_TOPIC | summary_long | cultural drivers | social narrative. Used by PROC_ENRICHMENT_APPLY + the vector backfill so all trend vectors share one recipe. Article titles excluded (that is the 768 content-match space). See issue #26.'
AS
$$
  function clean(s) { return (s === null || s === undefined) ? '' : String(s).trim(); }
  var p = PAYLOAD || {};
  var parts = [];
  var topic = clean(TOPIC);
  if (topic) parts.push(topic);
  var sl = clean(p.summary_long);
  if (sl) parts.push(sl);
  var drivers = Array.isArray(p.cultural_drivers) ? p.cultural_drivers : [];
  var dtext = drivers.map(function (d) { return clean(d && d.driver); })
                     .filter(function (x) { return x.length > 0; }).join('; ');
  if (dtext) parts.push(dtext);
  var narr = Array.isArray(p.social_narrative) ? p.social_narrative : [];
  var ntext = narr.map(function (s) { return clean(s && s.point); })
                  .filter(function (x) { return x.length > 0; }).join('; ');
  if (ntext) parts.push(ntext);
  return parts.join(' | ');
$$;
