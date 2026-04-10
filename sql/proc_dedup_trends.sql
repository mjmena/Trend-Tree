-- Procedure: One-time deduplication of existing trends via LLM reasoning
-- Database: MCC_RAW.MARKETING_DEV
--
-- Finds trend pairs with high vector similarity, asks LLM to confirm
-- whether they're the same trend, then merges duplicates by:
-- 1. Reassigning signals from the smaller trend to the larger one
-- 2. Recalculating metrics for the merged trend
-- 3. Deleting the absorbed trend from all presentation tables
--
-- Safe to run multiple times — converges when no more duplicates found.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_DEDUP_TRENDS()
RETURNS VARCHAR
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'pandas')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import json

LLM_MODEL = 'llama3.1-70b'
SIMILARITY_THRESHOLD = 0.55  # same as clustering pipeline
BATCH_SIZE = 500


def escape_sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def parse_json_response(text):
    if not text:
        return None
    text = text.strip()
    if text.startswith('```'):
        lines = text.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def run(session):
    session.sql("USE DATABASE MCC_RAW").collect()
    session.sql("USE SCHEMA MARKETING_DEV").collect()

    stats = {'pairs_found': 0, 'llm_merge': 0, 'llm_keep_separate': 0,
             'llm_failures': 0, 'signals_reassigned': 0, 'trends_deleted': 0}

    # ── Step 1: Find candidate duplicate pairs via vector similarity ──
    # Compare all trend pairs using TREND_VECTOR from FCT_TREND_METRICS
    pairs_df = session.sql(f"""
        WITH TREND_SIGNALS AS (
            SELECT
                m.TREND_ID,
                m.TREND_TOPIC,
                m.TOTAL_CLUSTER_SIZE,
                m.TREND_VECTOR,
                LISTAGG(s.TITLE, '||') WITHIN GROUP (ORDER BY RN) AS TOP_SIGNALS
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS m
            LEFT JOIN (
                SELECT TREND_ID, TITLE,
                       ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC, DETECTED_AT ASC) AS RN
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            ) s ON m.TREND_ID = s.TREND_ID AND s.RN <= 5
            GROUP BY m.TREND_ID, m.TREND_TOPIC, m.TOTAL_CLUSTER_SIZE, m.TREND_VECTOR
        )
        SELECT
            a.TREND_ID AS TREND_A_ID,
            a.TREND_TOPIC AS TREND_A_TOPIC,
            a.TOTAL_CLUSTER_SIZE AS TREND_A_SIZE,
            a.TOP_SIGNALS AS TREND_A_SIGNALS,
            b.TREND_ID AS TREND_B_ID,
            b.TREND_TOPIC AS TREND_B_TOPIC,
            b.TOTAL_CLUSTER_SIZE AS TREND_B_SIZE,
            b.TOP_SIGNALS AS TREND_B_SIGNALS,
            VECTOR_INNER_PRODUCT(a.TREND_VECTOR, b.TREND_VECTOR) AS SIMILARITY
        FROM TREND_SIGNALS a
        JOIN TREND_SIGNALS b
            ON a.TREND_ID < b.TREND_ID  -- avoid self-joins and duplicates
            AND VECTOR_INNER_PRODUCT(a.TREND_VECTOR, b.TREND_VECTOR) >= {SIMILARITY_THRESHOLD}
        ORDER BY SIMILARITY DESC
    """).collect()

    stats['pairs_found'] = len(pairs_df)
    if not pairs_df:
        return json.dumps({**stats, 'status': 'no duplicates found'})

    # ── Step 2: Build LLM prompts for each pair ──────────────────────
    prompt_values = []
    pair_info = []  # track pair metadata for processing results

    for idx, row in enumerate(pairs_df):
        a_signals = [s.strip() for s in str(row['TREND_A_SIGNALS'] or '').split('||') if s.strip()][:5]
        b_signals = [s.strip() for s in str(row['TREND_B_SIGNALS'] or '').split('||') if s.strip()][:5]

        a_list = '\n'.join(f'  {i+1}. {t}' for i, t in enumerate(a_signals))
        b_list = '\n'.join(f'  {i+1}. {t}' for i, t in enumerate(b_signals))

        prompt = f"""You are deduplicating a trend database for a news publisher. Two algorithmically-detected trends may be duplicates.

TREND A: "{row['TREND_A_TOPIC']}" ({row['TREND_A_SIZE']} signals)
Top signals:
{a_list}

TREND B: "{row['TREND_B_TOPIC']}" ({row['TREND_B_SIZE']} signals)
Top signals:
{b_list}

Vector similarity: {float(row['SIMILARITY']):.3f}

Are these the SAME consumer/lifestyle trend that should be merged, or DISTINCT trends that should stay separate?

Consider:
- Same underlying behavior/interest = MERGE, even if framed differently
- "mouth taping" and "sleep optimization mouth taping" = MERGE (same practice)
- "red light therapy face masks" and "near-infrared LED therapy panels" = MERGE (same wellness category)
- "cold plunge therapy" and "hot sauna recovery" = SEPARATE (different practices, even if both are recovery)
- A narrow subtopic and its parent trend = MERGE

Respond in valid JSON only:
{{
  "decision": "MERGE" or "SEPARATE",
  "reasoning": "1-2 sentences",
  "merged_topic": "if MERGE, the best 2-5 word name for the combined trend; if SEPARATE, null"
}}"""

        prompt_values.append(f"({idx}, {escape_sql_str(prompt)})")
        pair_info.append({
            'a_id': row['TREND_A_ID'],
            'b_id': row['TREND_B_ID'],
            'a_size': int(row['TREND_A_SIZE']),
            'b_size': int(row['TREND_B_SIZE']),
            'similarity': float(row['SIMILARITY']),
        })

    # Write prompts to temp table
    first_batch = prompt_values[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_DEDUP_PROMPTS (
            IDX NUMBER, PROMPT VARCHAR
        ) AS SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()
    for i in range(BATCH_SIZE, len(prompt_values), BATCH_SIZE):
        batch = prompt_values[i:i+BATCH_SIZE]
        session.sql(f"""
            INSERT INTO TEMP_DEDUP_PROMPTS
            SELECT * FROM VALUES {', '.join(batch)}
        """).collect()

    # ── Step 3: Batch LLM call ───────────────────────────────────────
    llm_results = session.sql(f"""
        SELECT IDX, SNOWFLAKE.CORTEX.COMPLETE('{LLM_MODEL}', PROMPT) AS LLM_RESPONSE
        FROM TEMP_DEDUP_PROMPTS
    """).collect()

    # ── Step 4: Process LLM decisions ────────────────────────────────
    # Build merge plan: for each confirmed merge, keep the larger trend,
    # absorb the smaller one. Use union-find to handle transitive merges
    # (if A merges with B and B merges with C, all three should merge).

    # Union-find
    parent = {}
    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x
    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    merge_topics = {}  # root_trend_id -> refined topic name

    for row in llm_results:
        idx = int(row['IDX'])
        result = parse_json_response(row['LLM_RESPONSE'])
        info = pair_info[idx]

        if not result:
            stats['llm_failures'] += 1
            continue

        decision = result.get('decision', 'SEPARATE').upper()

        if decision == 'MERGE':
            stats['llm_merge'] += 1
            # Keep the larger trend as primary
            if info['a_size'] >= info['b_size']:
                primary, secondary = info['a_id'], info['b_id']
            else:
                primary, secondary = info['b_id'], info['a_id']

            union(primary, secondary)
            # Track the best topic name
            topic = result.get('merged_topic')
            if topic:
                root = find(primary)
                merge_topics[root] = topic
        else:
            stats['llm_keep_separate'] += 1

    # Build final merge map: secondary_id -> primary_id
    # Group all trend IDs by their root
    all_ids = set()
    for info in pair_info:
        all_ids.add(info['a_id'])
        all_ids.add(info['b_id'])

    groups = {}  # root -> set of all IDs in group
    for tid in all_ids:
        root = find(tid)
        if root not in groups:
            groups[root] = set()
        groups[root].add(tid)

    # For each group, pick the trend with most signals as primary
    merge_ops = []  # (secondary_id, primary_id)
    for root, members in groups.items():
        if len(members) <= 1:
            continue
        # Find the member with the largest cluster
        sizes = {}
        for info in pair_info:
            sizes[info['a_id']] = info['a_size']
            sizes[info['b_id']] = info['b_size']
        primary = max(members, key=lambda t: sizes.get(t, 0))
        for tid in members:
            if tid != primary:
                merge_ops.append((tid, primary))

    if not merge_ops:
        return json.dumps({**stats, 'status': 'no merges confirmed by LLM'})

    # ── Step 5: Execute merges ───────────────────────────────────────
    for secondary_id, primary_id in merge_ops:
        # Reassign signals
        result = session.sql(f"""
            UPDATE MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            SET TREND_ID = {escape_sql_str(primary_id)}
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
              AND URL NOT IN (
                  SELECT URL FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
                  WHERE TREND_ID = {escape_sql_str(primary_id)}
              )
        """).collect()

        # Delete duplicate signals (same URL already in primary)
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary from metrics
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary from daily snapshots
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary from enrichment if exists
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.DIM_TREND_ENRICHMENT
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary from enrichment queue if exists
        session.sql(f"""
            DELETE FROM MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary source metrics (orphaned after FCT_TREND_METRICS delete)
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SOURCE_METRICS
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        # Delete secondary enrichment history
        session.sql(f"""
            DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_HISTORY
            WHERE TREND_ID = {escape_sql_str(secondary_id)}
        """).collect()

        stats['trends_deleted'] += 1

    # ── Step 6: Recalculate metrics for primary trends ───────────────
    primary_ids = set(p for _, p in merge_ops)
    for primary_id in primary_ids:
        # Update topic name if LLM provided one
        root = find(primary_id)
        new_topic = merge_topics.get(root)

        topic_set = f"TREND_TOPIC = {escape_sql_str(new_topic)}," if new_topic else ""

        session.sql(f"""
            UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
            SET {topic_set}
                TOTAL_CLUSTER_SIZE = agg.TOTAL_CLUSTER_SIZE,
                DISTINCT_SOURCE_COUNT = agg.DISTINCT_SOURCE_COUNT,
                DETECTED_AT = agg.DETECTED_AT,
                LAST_UPDATE_AT = agg.LAST_UPDATE_AT,
                TREND_DURATION_HR = GREATEST(TIMESTAMPDIFF(MINUTE, agg.DETECTED_AT, agg.LAST_UPDATE_AT) / 60, 0.1),
                SIGNALS_PER_SOURCE = ROUND((agg.TOTAL_CLUSTER_SIZE * 1.0) / GREATEST(agg.DISTINCT_SOURCE_COUNT, 1), 2)
            FROM (
                SELECT
                    COUNT(DISTINCT URL) AS TOTAL_CLUSTER_SIZE,
                    COUNT(DISTINCT SIGNAL_NAME) AS DISTINCT_SOURCE_COUNT,
                    MIN(DETECTED_AT) AS DETECTED_AT,
                    MAX(DETECTED_AT) AS LAST_UPDATE_AT
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
                WHERE TREND_ID = {escape_sql_str(primary_id)}
            ) agg
            WHERE TREND_ID = {escape_sql_str(primary_id)}
        """).collect()

        stats['signals_reassigned'] += 1

    stats['status'] = 'complete'
    return json.dumps(stats)
$$;
