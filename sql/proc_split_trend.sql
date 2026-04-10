-- Procedure: Split an over-broad trend into specific sub-trends
-- Database: MCC_RAW.MARKETING_DEV (temp tables); writes to MCC_PRESENTATION.TREND_AGENT
--
-- Re-runs Louvain community detection on a single trend's signals using a
-- HIGHER similarity threshold (0.72) and HIGHER resolution (2.0) to find
-- tighter sub-communities than the original pipeline. Each sub-community
-- becomes a new child trend with:
--   - Copied signals with recalculated PageRank
--   - Fresh FCT_TREND_METRICS row (cluster size, source count, heat index)
--   - Daily snapshot for today
--   - Queued for full LLM enrichment
--   - LLM-generated topic name (more specific than parent)
--
-- The parent trend gets VELOCITY_DIRECTION = 'SUPERSEDED' and is excluded from
-- future merge candidates. Its historical data (signals, snapshots, enrichment) is
-- preserved unchanged. Each child trend has PARENT_TREND_ID set to the parent's UUID.
--
-- Usage: CALL MCC_RAW.MARKETING_DEV.PROC_SPLIT_TREND('trend-uuid-here');
-- Returns: JSON summary with child trend IDs, topics, signal counts.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_SPLIT_TREND(TREND_ID VARCHAR)
RETURNS VARCHAR
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'networkx', 'pandas', 'scipy')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import networkx as nx
import json
import uuid

# Higher thresholds than main pipeline to produce tighter sub-communities
SPLIT_SIMILARITY_THRESHOLD = 0.72   # main pipeline uses 0.55
SPLIT_LOUVAIN_RESOLUTION = 2.0      # main pipeline uses 1.0
MIN_CHILD_SIZE = 3                   # same as main pipeline
BATCH_SIZE = 500
LLM_MODEL = 'llama3.1-70b'


def escape_sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''").replace("\\", "\\\\") + "'"


def parse_json_response(text):
    """Extract JSON from LLM response, handling markdown code blocks."""
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


def run(session, TREND_ID):
    tid = TREND_ID
    stats = {'parent_trend_id': tid, 'children': []}

    session.sql("USE DATABASE MCC_RAW").collect()
    session.sql("USE SCHEMA MARKETING_DEV").collect()

    # ── Step 1: Validate ───────────────────────────────────────────
    trend_row = session.sql(f"""
        SELECT TREND_ID, TREND_TOPIC,
               CASE WHEN VELOCITY_DIRECTION = 'SUPERSEDED' THEN TRUE ELSE FALSE END AS IS_SUPERSEDED,
               TOTAL_CLUSTER_SIZE, TREND_HEAT_INDEX
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
        WHERE TREND_ID = {escape_sql_str(tid)}
    """).collect()

    if not trend_row:
        return json.dumps({'error': 'Trend not found', 'trend_id': tid})
    if trend_row[0]['IS_SUPERSEDED']:
        return json.dumps({'error': 'Trend already superseded', 'trend_id': tid})

    parent_topic = trend_row[0]['TREND_TOPIC']
    parent_size = int(trend_row[0]['TOTAL_CLUSTER_SIZE'] or 0)

    # ── Step 2: Collect signals for graph building ─────────────────
    # Get LLM signal names so we can identify external sources
    llm_names_rows = session.sql("""
        SELECT DISTINCT SIGNAL_NAME
        FROM MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS
    """).collect()
    llm_signal_names = {row['SIGNAL_NAME'] for row in llm_names_rows}

    signals_df = session.sql(f"""
        SELECT URL, TITLE, SIGNAL_NAME, DOMAIN, DETECTED_AT, INGESTION_ID
        FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
        WHERE TREND_ID = {escape_sql_str(tid)}
    """).collect()

    if len(signals_df) < MIN_CHILD_SIZE * 2:
        return json.dumps({
            'error': f'Too few signals ({len(signals_df)}) to split — need at least {MIN_CHILD_SIZE * 2}',
            'trend_id': tid,
        })

    attr_cache = {}
    for row in signals_df:
        attr_cache[row['URL']] = {
            'title': row['TITLE'],
            'signal_name': row['SIGNAL_NAME'],
            'is_external': row['SIGNAL_NAME'] not in llm_signal_names,
        }

    # ── Step 3: Compute edges within this trend's signals ──────────
    # Uses ALL edges (same-source + cross-source) with a higher threshold.
    # Same-source edges help Louvain find tight topical sub-groups.
    edges_df = session.sql(f"""
        WITH ALL_EMBEDDINGS AS (
            SELECT URL, TITLE_VECTOR, DESCRIPTION_VECTOR
            FROM MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS
            UNION ALL
            SELECT URL, TITLE_VECTOR, DESCRIPTION_VECTOR
            FROM MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS
        ),
        TREND_SIGNALS AS (
            SELECT s.URL, e.TITLE_VECTOR, e.DESCRIPTION_VECTOR
            FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s
            JOIN ALL_EMBEDDINGS e ON s.URL = e.URL
            WHERE s.TREND_ID = {escape_sql_str(tid)}
            QUALIFY ROW_NUMBER() OVER (PARTITION BY s.URL ORDER BY 1) = 1
        )
        SELECT
            a.URL AS SOURCE, b.URL AS TARGET,
            (VECTOR_INNER_PRODUCT(a.TITLE_VECTOR, b.TITLE_VECTOR) * 0.8 +
             VECTOR_INNER_PRODUCT(a.DESCRIPTION_VECTOR, b.DESCRIPTION_VECTOR) * 0.6
            ) / 1.4 AS WEIGHT
        FROM TREND_SIGNALS a
        JOIN TREND_SIGNALS b ON a.URL < b.URL
        WHERE (VECTOR_INNER_PRODUCT(a.TITLE_VECTOR, b.TITLE_VECTOR) * 0.8 +
               VECTOR_INNER_PRODUCT(a.DESCRIPTION_VECTOR, b.DESCRIPTION_VECTOR) * 0.6
              ) / 1.4 >= {SPLIT_SIMILARITY_THRESHOLD}
    """).collect()

    # ── Step 4: Build graph + Louvain + PageRank ───────────────────
    G = nx.Graph()
    for url in attr_cache:
        G.add_node(url)
    for row in edges_df:
        G.add_edge(row['SOURCE'], row['TARGET'], weight=float(row['WEIGHT']))

    communities = nx.community.louvain_communities(
        G, weight='weight', resolution=SPLIT_LOUVAIN_RESOLUTION, seed=42
    )

    def distinct_sources(comm):
        return len({
            attr_cache[url]['signal_name']
            for url in comm if url in attr_cache
        })

    def has_external_signal(comm):
        return any(
            attr_cache.get(url, {}).get('is_external', False)
            for url in comm
        )

    valid_communities = [
        c for c in communities
        if len(c) >= MIN_CHILD_SIZE and distinct_sources(c) >= 2
    ]

    size_filtered = [c for c in communities if len(c) >= MIN_CHILD_SIZE]
    rejected_single_source = [c for c in size_filtered if distinct_sources(c) < 2]

    if len(valid_communities) <= 1:
        return json.dumps({
            'status': 'no_split',
            'message': f'Trend "{parent_topic}" — {len(valid_communities)} community with 2+ sources at resolution {SPLIT_LOUVAIN_RESOLUTION}',
            'total_communities': len(communities),
            'passed_size_filter': len(size_filtered),
            'rejected_single_source': len(rejected_single_source),
            'community_sizes': sorted([len(c) for c in communities], reverse=True),
        })

    # ── Step 5: PageRank per sub-community ─────────────────────────
    children = []
    for comm_nodes in valid_communities:
        subgraph = G.subgraph(comm_nodes)
        pr = nx.pagerank(subgraph, weight='weight')
        leader = max(pr, key=pr.get)
        ranked = sorted(
            [n for n in comm_nodes if n in attr_cache],
            key=lambda n: pr.get(n, 0), reverse=True
        )

        children.append({
            'trend_id': str(uuid.uuid4()),
            'leader': leader,
            'topic': attr_cache[leader]['title'] if leader in attr_cache else 'Unknown',
            'ranked': ranked,
            'nodes': list(comm_nodes),
            'pr': pr,
        })

    # ── Step 6: Write node-to-child mapping ────────────────────────
    mapping_values = []
    for child in children:
        for url in child['nodes']:
            mapping_values.append(
                f"({escape_sql_str(child['trend_id'])}, {escape_sql_str(url)}, "
                f"{escape_sql_str(child['leader'])}, {child['pr'].get(url, 0)})"
            )

    first_batch = mapping_values[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_SPLIT_MAP (
            NEW_TREND_ID VARCHAR, URL VARCHAR, LEADER_URL VARCHAR, NEW_PAGERANK FLOAT
        ) AS
        SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()
    for i in range(BATCH_SIZE, len(mapping_values), BATCH_SIZE):
        batch = mapping_values[i:i+BATCH_SIZE]
        session.sql(f"""
            INSERT INTO TEMP_SPLIT_MAP
            SELECT * FROM VALUES {', '.join(batch)}
        """).collect()

    # ── Step 7: LLM naming for each child ──────────────────────────
    prompt_values = []
    for idx, child in enumerate(children):
        signal_titles = [attr_cache[u]['title'] for u in child['ranked'][:10] if u in attr_cache]
        signal_text = '\\n'.join(f'  {i+1}. {t}' for i, t in enumerate(signal_titles))

        prompt = (
            f'You are a consumer trends analyst naming a sub-trend split from a broader trend.\\n\\n'
            f'PARENT TREND: "{parent_topic}"\\n\\n'
            f'SUB-CLUSTER SIGNALS ({len(signal_titles)} shown):\\n'
            f'{signal_text}\\n\\n'
            f'This sub-cluster was separated because it represents a more specific niche '
            f'within the parent trend. The name should be MORE SPECIFIC than the parent — '
            f'narrow enough to target a single consumer behavior or product category.\\n\\n'
            f'Respond in valid JSON only:\\n'
            f'{{"refined_topic": "concise 2-5 word consumer trend name (more specific than parent)", '
            f'"reasoning": "one sentence on what distinguishes this sub-cluster"}}'
        )
        prompt_values.append(
            f"({idx}, {escape_sql_str(child['trend_id'])}, {escape_sql_str(prompt)})"
        )

    first_batch = prompt_values[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_SPLIT_PROMPTS (
            IDX NUMBER, CHILD_TREND_ID VARCHAR, PROMPT VARCHAR
        ) AS
        SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()

    llm_results = session.sql(f"""
        SELECT IDX, CHILD_TREND_ID,
               SNOWFLAKE.CORTEX.COMPLETE('{LLM_MODEL}', PROMPT) AS LLM_RESPONSE
        FROM TEMP_SPLIT_PROMPTS
    """).collect()

    for row in llm_results:
        idx = int(row['IDX'])
        result = parse_json_response(row['LLM_RESPONSE'])
        if result and result.get('refined_topic'):
            children[idx]['topic'] = result['refined_topic']
            children[idx]['reasoning'] = result.get('reasoning', '')

    # Update mapping table with LLM-refined topics for the metrics insert
    for child in children:
        session.sql(f"""
            UPDATE TEMP_SPLIT_MAP
            SET LEADER_URL = LEADER_URL  -- no-op, just need the WHERE for scoping
            WHERE NEW_TREND_ID = {escape_sql_str(child['trend_id'])}
        """).collect()
        # We'll pass topics via a separate temp table

    # Write child metadata for SQL joins
    meta_values = []
    for child in children:
        meta_values.append(
            f"({escape_sql_str(child['trend_id'])}, {escape_sql_str(child['topic'])}, "
            f"{escape_sql_str(child['leader'])}, {escape_sql_str(tid)})"
        )
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_SPLIT_META (
            TREND_ID VARCHAR, TREND_TOPIC VARCHAR, LEADER_URL VARCHAR, PARENT_TREND_ID VARCHAR
        ) AS
        SELECT * FROM VALUES {', '.join(meta_values)}
    """).collect()

    # ── Step 8: Copy signals from parent via SQL ───────────────────
    # Preserves original DETECTED_AT, SIGNAL_NAME, etc. Only TREND_ID and
    # PAGERANK_SCORE change.
    session.sql(f"""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            (TREND_ID, URL, TITLE, SIGNAL_NAME, DOMAIN, DETECTED_AT, INGESTION_ID, PAGERANK_SCORE)
        SELECT
            m.NEW_TREND_ID,
            s.URL, s.TITLE, s.SIGNAL_NAME, s.DOMAIN, s.DETECTED_AT, s.INGESTION_ID,
            m.NEW_PAGERANK
        FROM TEMP_SPLIT_MAP m
        JOIN MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s
            ON m.URL = s.URL AND s.TREND_ID = {escape_sql_str(tid)}
    """).collect()

    # ── Step 9: Insert FCT_TREND_METRICS for children ──────────────
    session.sql("""
        CREATE OR REPLACE TEMP VIEW TEMP_SPLIT_EMBEDDINGS AS
        SELECT URL, TITLE_VECTOR
        FROM MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS
        UNION ALL
        SELECT URL, TITLE_VECTOR
        FROM MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS
    """).collect()

    session.sql("""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
            (TREND_ID, TREND_VECTOR, TREND_TOPIC, DETECTED_AT, LAST_UPDATE_AT,
             TREND_DURATION_HR, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT,
             AVG_SIMILARITY, VELOCITY_DIRECTION, SIGNALS_PER_SOURCE,
             SIGNAL_CHANGE, TREND_HEAT_INDEX, PARENT_TREND_ID)
        SELECT
            cm.TREND_ID,
            e.TITLE_VECTOR,
            cm.TREND_TOPIC,
            MIN(s.DETECTED_AT),
            MAX(s.DETECTED_AT),
            GREATEST(TIMESTAMPDIFF(MINUTE, MIN(s.DETECTED_AT), MAX(s.DETECTED_AT)) / 60.0, 0.1),
            COUNT(DISTINCT s.URL),
            COUNT(DISTINCT s.SIGNAL_NAME),
            NULL,
            'NEW',
            ROUND(COUNT(DISTINCT s.URL) * 1.0 / GREATEST(COUNT(DISTINCT s.SIGNAL_NAME), 1), 2),
            0,
            0,
            cm.PARENT_TREND_ID
        FROM TEMP_SPLIT_META cm
        JOIN MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s ON cm.TREND_ID = s.TREND_ID
        LEFT JOIN (
            SELECT URL, TITLE_VECTOR
            FROM TEMP_SPLIT_EMBEDDINGS
            QUALIFY ROW_NUMBER() OVER (PARTITION BY URL ORDER BY 1) = 1
        ) e ON cm.LEADER_URL = e.URL
        GROUP BY cm.TREND_ID, cm.TREND_TOPIC, cm.PARENT_TREND_ID, e.TITLE_VECTOR
    """).collect()

    # ── Step 10: Insert daily snapshots ────────────────────────────
    session.sql("""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS
            (TREND_ID, SNAPSHOT_DATE, SIGNAL_COUNT, SOURCE_COUNT,
             NEW_SIGNALS_TODAY, NEW_SOURCES_TODAY)
        SELECT
            cm.TREND_ID,
            CURRENT_DATE(),
            COUNT(DISTINCT s.URL),
            COUNT(DISTINCT s.SIGNAL_NAME),
            COUNT(DISTINCT s.URL),
            COUNT(DISTINCT s.SIGNAL_NAME)
        FROM TEMP_SPLIT_META cm
        JOIN MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s ON cm.TREND_ID = s.TREND_ID
        GROUP BY cm.TREND_ID
    """).collect()

    # ── Step 11: Compute heat index ────────────────────────────────
    # Uses same formula as main pipeline but with a base growth score of 50
    # (since all signals are "new" to this trend ID today).
    session.sql("""
        UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS f
        SET f.TREND_HEAT_INDEX = ROUND(
            -- Growth component: moderate initial (all signals are "new" to this child)
            50 * 0.4
            -- Source diversity component
            + LEAST((f.DISTINCT_SOURCE_COUNT * 100.0) / GREATEST(mx.MAX_SC, 1), 100) * 0.3
            -- Recency component
            + GREATEST(100 - (TIMESTAMPDIFF(HOUR, f.LAST_UPDATE_AT, CURRENT_TIMESTAMP()) * 4.16), 0) * 0.3
        , 1)
        FROM (
            SELECT MAX(DISTINCT_SOURCE_COUNT) AS MAX_SC
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
            WHERE VELOCITY_DIRECTION != 'SUPERSEDED'
        ) mx
        WHERE f.TREND_ID IN (SELECT TREND_ID FROM TEMP_SPLIT_META)
    """).collect()

    # ── Step 12: Mark parent as superseded ─────────────────────────
    # Mark parent as superseded
    session.sql(f"""
        UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
        SET VELOCITY_DIRECTION = 'SUPERSEDED'
        WHERE TREND_ID = {escape_sql_str(tid)}
    """).collect()

    # ── Step 13: Queue children for full enrichment ────────────────
    queue_values = []
    for child in children:
        queue_values.append(
            f"({escape_sql_str(child['trend_id'])}, {escape_sql_str(child['topic'])}, "
            f"'FULL', 85, CURRENT_TIMESTAMP(), 'PENDING')"
        )
    session.sql(f"""
        INSERT INTO MCC_RAW.MARKETING_DEV.STG_ENRICHMENT_QUEUE
            (TREND_ID, TREND_TOPIC, ENRICHMENT_TYPE, PRIORITY, QUEUED_AT, STATUS)
        SELECT * FROM VALUES {', '.join(queue_values)}
    """).collect()

    # ── Step 14: Build summary ─────────────────────────────────────
    for child in children:
        row = session.sql(f"""
            SELECT TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT, TREND_HEAT_INDEX
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS
            WHERE TREND_ID = {escape_sql_str(child['trend_id'])}
        """).collect()
        stats['children'].append({
            'trend_id': child['trend_id'],
            'topic': child['topic'],
            'reasoning': child.get('reasoning', ''),
            'signal_count': int(row[0]['TOTAL_CLUSTER_SIZE']) if row else len(child['nodes']),
            'source_count': int(row[0]['DISTINCT_SOURCE_COUNT']) if row else 0,
            'heat_index': float(row[0]['TREND_HEAT_INDEX']) if row else 0,
        })

    orphan_count = len(signals_df) - sum(len(c['nodes']) for c in children)
    stats['parent_topic'] = parent_topic
    stats['parent_superseded'] = True
    stats['children_count'] = len(children)
    stats['children_with_external'] = sum(1 for c in children if has_external_signal(set(c['nodes'])))
    stats['rejected_single_source'] = len(rejected_single_source)
    stats['orphaned_signals'] = orphan_count

    return json.dumps(stats)
$$;
