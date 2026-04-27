-- Procedure: Cluster a subset of signals by vector cosine similarity.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Given a list of signal_ids and a target cluster count K, picks K
-- semantically-diverse seed signals (k-means++ style) and assigns every
-- input signal to its nearest seed. Returns flat assignments suitable
-- for fan-out to parallel agents.
--
-- Used by the daily revisit workflow to break the leftover-signal pool
-- into K coherent slices, one per parallel revisit subagent. Each slice
-- contains semantically-related signals so the agent has a real shot at
-- spotting cross-signal patterns the main pass missed.
--
-- Embeddings come from DT_EXTERNAL_TREND_EMBEDDINGS (joined to
-- STG_EXTERNAL_SIGNALS by URL). Signals without an embedding (NULL TITLE
-- or aged out of the dynamic table's 3-day window) are dropped — caller
-- should filter input to recent signals.
--
-- Usage:
--   CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(
--     PARSE_JSON('["sig-1","sig-2",...]'),
--     5
--   );
--
-- Returns: VARIANT array of objects:
--   { signal_id, cluster_id, signal_title, source_name, similarity_to_seed }

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(
    SIGNAL_IDS  ARRAY,
    K           NUMBER DEFAULT 5
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import json
import datetime
import random


def to_json_safe(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    return v


def sql_str_array(ids):
    """SQL VALUES clause for an array of string IDs."""
    if not ids:
        return "(NULL)"
    return "(" + ",".join("('" + str(i).replace("'", "''") + "')" for i in ids) + ")"


def run(session, SIGNAL_IDS, K):
    if not SIGNAL_IDS:
        return []
    if isinstance(SIGNAL_IDS, str):
        SIGNAL_IDS = json.loads(SIGNAL_IDS)
    k = max(1, int(K or 5))

    # Pull signals with embeddings, joining STG_EXTERNAL_SIGNALS to
    # DT_EXTERNAL_TREND_EMBEDDINGS via URL. Skip rows without an embedding.
    rs = session.sql(f"""
        WITH probe AS (
          SELECT VALUE::STRING AS SIGNAL_ID
          FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{json.dumps(list(SIGNAL_IDS))}'))) f
        )
        SELECT
            s.SIGNAL_ID,
            s.SIGNAL_TITLE,
            s.SOURCE_NAME,
            e.TITLE_VECTOR
        FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
        JOIN probe p ON p.SIGNAL_ID = s.SIGNAL_ID
        JOIN MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS e
          ON e.URL = s.SIGNAL_ID
        WHERE e.TITLE_VECTOR IS NOT NULL
    """).collect()

    if len(rs) == 0:
        return []

    # If the pool is smaller than k, each signal is its own cluster.
    if len(rs) <= k:
        return [
            {
                'signal_id': r['SIGNAL_ID'],
                'cluster_id': i,
                'signal_title': r['SIGNAL_TITLE'],
                'source_name': r['SOURCE_NAME'],
                'similarity_to_seed': 1.0,
            }
            for i, r in enumerate(rs)
        ]

    # K-means++ seeding via Snowflake VECTOR_COSINE_SIMILARITY. Avoids
    # pulling 1024-dim vectors into Python memory.
    #
    # Step 1: random first seed.
    seeds = [rs[random.randrange(len(rs))]['SIGNAL_ID']]

    # Step 2: pick remaining seeds as "most distant from existing seeds."
    # For each candidate, compute max similarity to any existing seed;
    # pick the candidate with the LOWEST max-similarity (most distant).
    while len(seeds) < k:
        seed_list = "','".join(seeds)
        seed_clause = f"'{seed_list}'"
        next_seed_rs = session.sql(f"""
            WITH candidates AS (
              SELECT s.SIGNAL_ID, e.TITLE_VECTOR
              FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
              JOIN MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS e
                ON e.URL = s.SIGNAL_ID
              WHERE s.SIGNAL_ID IN (
                SELECT VALUE::STRING
                FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{json.dumps(list(SIGNAL_IDS))}')))
              )
              AND s.SIGNAL_ID NOT IN ({seed_clause})
            ),
            seed_vecs AS (
              SELECT s.SIGNAL_ID, e.TITLE_VECTOR
              FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
              JOIN MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS e
                ON e.URL = s.SIGNAL_ID
              WHERE s.SIGNAL_ID IN ({seed_clause})
            ),
            max_sim AS (
              SELECT c.SIGNAL_ID,
                     MAX(VECTOR_COSINE_SIMILARITY(c.TITLE_VECTOR, sv.TITLE_VECTOR)) AS MAX_SIM
              FROM candidates c CROSS JOIN seed_vecs sv
              GROUP BY c.SIGNAL_ID
            )
            SELECT SIGNAL_ID FROM max_sim ORDER BY MAX_SIM ASC LIMIT 1
        """).collect()
        if not next_seed_rs:
            break
        seeds.append(next_seed_rs[0]['SIGNAL_ID'])

    # Step 3: assign every signal in the input to its nearest seed.
    seed_clause = "','".join(seeds)
    assignments_rs = session.sql(f"""
        WITH probe AS (
          SELECT VALUE::STRING AS SIGNAL_ID
          FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{json.dumps(list(SIGNAL_IDS))}'))) f
        ),
        signals AS (
          SELECT s.SIGNAL_ID, s.SIGNAL_TITLE, s.SOURCE_NAME, e.TITLE_VECTOR
          FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
          JOIN probe p ON p.SIGNAL_ID = s.SIGNAL_ID
          JOIN MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS e
            ON e.URL = s.SIGNAL_ID
          WHERE e.TITLE_VECTOR IS NOT NULL
        ),
        seed_vecs AS (
          SELECT s.SIGNAL_ID, e.TITLE_VECTOR,
                 ROW_NUMBER() OVER (ORDER BY s.SIGNAL_ID) - 1 AS CLUSTER_ID
          FROM MCC_RAW.MARKETING_DEV.STG_EXTERNAL_SIGNALS s
          JOIN MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS e
            ON e.URL = s.SIGNAL_ID
          WHERE s.SIGNAL_ID IN ('{seed_clause}')
        )
        SELECT
            sg.SIGNAL_ID,
            sg.SIGNAL_TITLE,
            sg.SOURCE_NAME,
            sv.CLUSTER_ID,
            ROUND(VECTOR_COSINE_SIMILARITY(sg.TITLE_VECTOR, sv.TITLE_VECTOR), 4) AS SIMILARITY
        FROM signals sg CROSS JOIN seed_vecs sv
        QUALIFY ROW_NUMBER() OVER (
            PARTITION BY sg.SIGNAL_ID
            ORDER BY VECTOR_COSINE_SIMILARITY(sg.TITLE_VECTOR, sv.TITLE_VECTOR) DESC
        ) = 1
    """).collect()

    return [
        {
            'signal_id': r['SIGNAL_ID'],
            'cluster_id': int(r['CLUSTER_ID']),
            'signal_title': r['SIGNAL_TITLE'],
            'source_name': r['SOURCE_NAME'],
            'similarity_to_seed': to_json_safe(r['SIMILARITY']),
        }
        for r in assignments_rs
    ]
$$;
