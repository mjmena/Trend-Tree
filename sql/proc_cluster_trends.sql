-- Procedure: Trend clustering via Louvain + PageRank + LLM-reasoned historical matching
-- Database: MCC_RAW.MARKETING_DEV
--
-- Snowpark Python stored procedure that replaces run_pipeline.py.
-- Uses NetworkX for graph algorithms, Cortex LLM for historical trend matching,
-- and executes SQL pipeline steps internally.
-- Called by TASK_CLUSTER_TRENDS on a schedule.
--
-- LLM reasoning: After clustering, each new community is compared against existing
-- trends via vector similarity (>= 0.70 threshold). Candidate matches are sent to
-- Cortex with both the new cluster's signals and the existing trend's signals.
-- The LLM decides MERGE (same trend) or NEW (distinct trend), preventing both
-- false merges (trend drift) and false non-merges (same trend, different framing).
-- Clusters with no vector candidates also get LLM-refined topic names.

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_CLUSTER_TRENDS()
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

LOUVAIN_RESOLUTION = 1.0
BATCH_SIZE = 500
LLM_MODEL = 'llama3.1-70b'
CANDIDATE_SIMILARITY_THRESHOLD = 0.55  # low threshold — LLM does the real filtering
MAX_CANDIDATES_PER_CLUSTER = 3


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


def build_match_prompt(new_topic, new_signals, candidate_topic, candidate_signals,
                       candidate_size, similarity):
    """Prompt for LLM to decide MERGE vs NEW for a candidate historical match."""
    new_list = '\n'.join(f'  {i+1}. {t}' for i, t in enumerate(new_signals))
    cand_list = '\n'.join(f'  {i+1}. {t}' for i, t in enumerate(candidate_signals))

    size_guidance = f'The existing trend has {candidate_size} signals.'

    return f"""You are deciding whether a newly detected signal cluster represents the SAME trend as an existing tracked trend, or is a DISTINCT new trend.

NEW CLUSTER: "{new_topic}"
Top signals ({len(new_signals)} shown):
{new_list}

EXISTING TREND: "{candidate_topic}" ({candidate_size} total signals)
Top signals:
{cand_list}

Vector similarity between cluster centroids: {similarity:.3f}

{size_guidance}

SPECIFICITY RULE: Each trend must remain narrow enough to target a SINGLE consumer behavior, product category, or lifestyle practice. Trends should be sponsor-matchable — if you can't imagine a specific brand sponsoring the combined trend, choose NEW.

Consider:
- Same underlying consumer behavior/interest = MERGE (even if framed differently)
- "cold plunge therapy" and "ice bath recovery" = MERGE (same wellness practice)
- "gut health supplements" and "home gut renovation" = NEW (unrelated despite shared word)
- "morning matcha ritual" and "morning self-care routines" = NEW (matcha is specific, morning self-care is too broad)
- If the new cluster covers genuinely different products/behaviors/audiences, NEW

Respond in valid JSON only:
{{
  "decision": "MERGE" or "NEW",
  "reasoning": "1-2 sentences explaining why these are or aren't the same trend",
  "refined_topic": "concise 2-5 word trend name — if MERGE, the best name for the combined trend; if NEW, a name for the new trend"
}}"""


def build_naming_prompt(topic, signals):
    """Prompt for LLM to name a new cluster with no historical candidates."""
    signal_list = '\n'.join(f'  {i+1}. {t}' for i, t in enumerate(signals))
    return f"""You are a consumer trends analyst naming a newly detected trend cluster for a news publisher.

CLUSTER SIGNALS ({len(signals)} shown):
{signal_list}

The algorithm grouped these by embedding similarity. Provide a concise, descriptive trend name.

Respond in valid JSON only:
{{
  "refined_topic": "concise 2-5 word consumer trend name",
  "reasoning": "one sentence on what ties these signals together"
}}"""


def run(session):
    stats = {
        'edges': 0, 'louvain_communities': 0,
        'llm_merge': 0, 'llm_new': 0, 'llm_no_candidates': 0, 'llm_failures': 0,
        'final_communities': 0, 'final_mappings': 0,
    }

    # ── Step 1: Extract edges ────────────────────────────────────────
    edges_df = session.sql("""
        WITH RECENT_EMBEDDINGS AS (
            SELECT URL, TITLE, SIGNAL_NAME, SIGNAL_TYPE, DETECTED_AT,
                   TITLE_VECTOR, DESCRIPTION_VECTOR, NULL AS SOURCE_TREND_ID
            FROM MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS
            UNION ALL
            SELECT URL, TITLE, SIGNAL_NAME, SIGNAL_TYPE, DETECTED_AT,
                   TITLE_VECTOR, DESCRIPTION_VECTOR, SOURCE_TREND_ID
            FROM MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS
        )
        SELECT
            Anchor.URL AS SOURCE,
            Match.URL AS TARGET,
            (VECTOR_INNER_PRODUCT(Anchor.TITLE_VECTOR, Match.TITLE_VECTOR) * 0.8 +
             VECTOR_INNER_PRODUCT(Anchor.DESCRIPTION_VECTOR, Match.DESCRIPTION_VECTOR) * 0.6) / 1.4 AS WEIGHT,
            Anchor.TITLE AS SOURCE_TITLE,
            Anchor.DETECTED_AT AS SOURCE_DETECTED_AT
        FROM RECENT_EMBEDDINGS Anchor
        INNER JOIN RECENT_EMBEDDINGS Match
            ON Anchor.SIGNAL_NAME != Match.SIGNAL_NAME
            AND NOT (Anchor.SOURCE_TREND_ID IS NOT NULL
                     AND Match.SOURCE_TREND_ID IS NOT NULL
                     AND Anchor.SOURCE_TREND_ID = Match.SOURCE_TREND_ID)
            AND ((VECTOR_INNER_PRODUCT(Anchor.TITLE_VECTOR, Match.TITLE_VECTOR) * 0.8 +
                 VECTOR_INNER_PRODUCT(Anchor.DESCRIPTION_VECTOR, Match.DESCRIPTION_VECTOR) * 0.6) / 1.4) >= 0.55
    """).collect()

    stats['edges'] = len(edges_df)
    if not edges_df:
        return "No edges found. Nothing to cluster."

    # Set schema context for temp tables
    session.sql("USE DATABASE MCC_RAW").collect()
    session.sql("USE SCHEMA MARKETING_DEV").collect()

    # ── Step 2: Build graph + Louvain community detection ────────────
    G = nx.Graph()
    attr_cache = {}

    for row in edges_df:
        src, tgt = row['SOURCE'], row['TARGET']
        G.add_edge(src, tgt, weight=float(row['WEIGHT']))
        if src not in attr_cache:
            attr_cache[src] = {
                'title': row['SOURCE_TITLE'],
                'detected_at': str(row['SOURCE_DETECTED_AT'])
            }

    communities = nx.community.louvain_communities(
        G, weight='weight', resolution=LOUVAIN_RESOLUTION, seed=42
    )
    stats['louvain_communities'] = len(communities)

    # ── Step 3: PageRank + build communities ─────────────────────────
    community_list = []

    for component_nodes in communities:
        subgraph = G.subgraph(component_nodes)
        valid_nodes = [n for n in component_nodes if n in attr_cache]
        if not valid_nodes:
            continue

        pr = nx.pagerank(subgraph, weight='weight')
        leader = max(pr, key=pr.get)
        topic = attr_cache[leader]['title'] if leader in attr_cache else attr_cache[valid_nodes[0]]['title']
        ranked = sorted(valid_nodes, key=lambda n: pr.get(n, 0), reverse=True)

        community_list.append({
            'nodes': set(component_nodes),
            'pr': pr,
            'leader': leader,
            'topic': topic,
            'ranked': ranked,
        })

    if not community_list:
        return "No valid communities found."

    # ── Step 4: Write initial mappings + embeddings view ─────────────
    # Write mappings to temp table so SQL can access leader vectors
    values_parts = []
    for comm in community_list:
        for node in comm['nodes']:
            values_parts.append(
                f"({escape_sql_str(node)}, {escape_sql_str(comm['leader'])}, "
                f"{escape_sql_str(comm['topic'])}, {escape_sql_str(comm['topic'])}, "
                f"{escape_sql_str(comm['leader'])}, {comm['pr'].get(node, 0)})"
            )

    first_batch = values_parts[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_CLUSTER_MAPPINGS (
            MATCH_URL VARCHAR, ORIGINAL_LEADER_URL VARCHAR,
            ORIGINAL_TOPIC VARCHAR, CURRENT_CENTRAL_TOPIC VARCHAR,
            CURRENT_CENTRAL_LEADER_URL VARCHAR, PAGERANK_SCORE FLOAT
        ) AS
        SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()
    for i in range(BATCH_SIZE, len(values_parts), BATCH_SIZE):
        batch = values_parts[i:i+BATCH_SIZE]
        session.sql(f"""
            INSERT INTO TEMP_CLUSTER_MAPPINGS
            SELECT * FROM VALUES {', '.join(batch)}
        """).collect()

    session.sql("""
        CREATE OR REPLACE TEMP VIEW TEMP_ALL_EMBEDDINGS AS
        SELECT URL, TITLE, DESCRIPTION, SIGNAL_TYPE, SIGNAL_NAME, DETECTED_AT,
               TITLE_VECTOR, DESCRIPTION_VECTOR, CAST(INGESTION_ID AS VARCHAR) AS INGESTION_ID
        FROM MCC_RAW.MARKETING_DEV.DT_LLM_TREND_EMBEDDINGS
        UNION ALL
        SELECT URL, TITLE, DESCRIPTION, SIGNAL_TYPE, SIGNAL_NAME, DETECTED_AT,
               TITLE_VECTOR, DESCRIPTION_VECTOR, NULL AS INGESTION_ID
        FROM MCC_RAW.MARKETING_DEV.DT_EXTERNAL_TREND_EMBEDDINGS
    """).collect()

    # ── Step 5: Find candidate historical matches via SQL ────────────
    candidates_df = session.sql(f"""
        WITH NEW_LEADERS AS (
            SELECT DISTINCT ORIGINAL_LEADER_URL, ORIGINAL_TOPIC
            FROM TEMP_CLUSTER_MAPPINGS
        ),
        LEADER_VECTORS AS (
            SELECT nl.ORIGINAL_LEADER_URL, nl.ORIGINAL_TOPIC,
                   e.TITLE_VECTOR, e.DESCRIPTION_VECTOR
            FROM NEW_LEADERS nl
            JOIN TEMP_ALL_EMBEDDINGS e ON nl.ORIGINAL_LEADER_URL = e.URL
        ),
        HISTORICAL_TREND_VECTORS AS (
            SELECT tm.TREND_ID, tm.TREND_VECTOR AS TITLE_VECTOR
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS tm
            WHERE tm.VELOCITY_DIRECTION != 'SUPERSEDED'
              AND tm.TREND_VECTOR IS NOT NULL
        ),
        CANDIDATES AS (
            SELECT
                lv.ORIGINAL_LEADER_URL,
                lv.ORIGINAL_TOPIC AS NEW_TOPIC,
                htv.TREND_ID AS CANDIDATE_TREND_ID,
                VECTOR_INNER_PRODUCT(lv.TITLE_VECTOR, htv.TITLE_VECTOR) AS SIMILARITY
            FROM LEADER_VECTORS lv
            CROSS JOIN HISTORICAL_TREND_VECTORS htv
            WHERE VECTOR_INNER_PRODUCT(lv.TITLE_VECTOR, htv.TITLE_VECTOR) >= {CANDIDATE_SIMILARITY_THRESHOLD}
        ),
        RANKED_CANDIDATES AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                       PARTITION BY ORIGINAL_LEADER_URL
                       ORDER BY SIMILARITY DESC
                   ) AS RANK
            FROM CANDIDATES
        )
        SELECT
            rc.ORIGINAL_LEADER_URL,
            rc.NEW_TOPIC,
            rc.CANDIDATE_TREND_ID,
            tm.TREND_TOPIC AS CANDIDATE_TOPIC,
            tm.TOTAL_CLUSTER_SIZE AS CANDIDATE_SIZE,
            ROUND(MAX(rc.SIMILARITY), 4) AS SIMILARITY,
            ANY_VALUE(sig_agg.SIGNAL_TITLES) AS CANDIDATE_SIGNALS
        FROM RANKED_CANDIDATES rc
        JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS tm
            ON rc.CANDIDATE_TREND_ID = tm.TREND_ID
        LEFT JOIN (
            SELECT TREND_ID,
                   LISTAGG(TITLE, '||') WITHIN GROUP (ORDER BY RN) AS SIGNAL_TITLES
            FROM (
                SELECT TREND_ID, TITLE,
                       ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY PAGERANK_SCORE DESC, DETECTED_AT ASC) AS RN
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            )
            WHERE RN <= 5
            GROUP BY TREND_ID
        ) sig_agg ON rc.CANDIDATE_TREND_ID = sig_agg.TREND_ID
        WHERE rc.RANK <= {MAX_CANDIDATES_PER_CLUSTER}
        GROUP BY rc.ORIGINAL_LEADER_URL, rc.NEW_TOPIC,
                 rc.CANDIDATE_TREND_ID, tm.TREND_TOPIC, tm.TOTAL_CLUSTER_SIZE
        ORDER BY rc.ORIGINAL_LEADER_URL, SIMILARITY DESC
    """).collect()

    # ── Step 6: Build LLM prompts for historical matching ────────────
    # Group candidates by leader URL
    leader_candidates = {}  # leader_url -> [(trend_id, topic, size, similarity, signals)]
    for row in candidates_df:
        leader = row['ORIGINAL_LEADER_URL']
        if leader not in leader_candidates:
            leader_candidates[leader] = {
                'new_topic': row['NEW_TOPIC'],
                'candidates': []
            }
        leader_candidates[leader]['candidates'].append({
            'trend_id': row['CANDIDATE_TREND_ID'],
            'topic': row['CANDIDATE_TOPIC'],
            'size': int(row['CANDIDATE_SIZE']),
            'similarity': float(row['SIMILARITY']),
            'signals': [s.strip() for s in (row['CANDIDATE_SIGNALS'] or '').split('||') if s.strip()],
        })

    # Build per-leader prompts
    # Leaders WITH candidates: ask LLM to pick MERGE or NEW
    # Leaders WITHOUT candidates: ask LLM to name the new trend
    prompt_data = []  # (leader_url, prompt, prompt_type)

    for comm in community_list:
        leader = comm['leader']
        new_signals = [attr_cache[u]['title'] for u in comm['ranked'][:10] if u in attr_cache]

        if leader in leader_candidates:
            # Has candidate matches — evaluate each candidate; stop at first MERGE
            for best in leader_candidates[leader]['candidates']:
                prompt = build_match_prompt(
                    new_topic=leader_candidates[leader]['new_topic'],
                    new_signals=new_signals,
                    candidate_topic=best['topic'],
                    candidate_signals=best['signals'][:5],
                    candidate_size=best['size'],
                    similarity=best['similarity'],
                )
                prompt_data.append((leader, prompt, 'match', best['trend_id']))
        else:
            # No candidates — just name it
            prompt = build_naming_prompt(comm['topic'], new_signals)
            prompt_data.append((leader, prompt, 'name', None))

    # ── Step 7: Batch LLM calls ─────────────────────────────────────
    # Write prompts to temp table
    prompt_values = []
    for idx, (leader, prompt, ptype, cand_id) in enumerate(prompt_data):
        prompt_values.append(
            f"({idx}, {escape_sql_str(leader)}, {escape_sql_str(prompt)}, "
            f"{escape_sql_str(ptype)}, {escape_sql_str(cand_id)})"
        )

    first_batch = prompt_values[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_MATCH_PROMPTS (
            IDX NUMBER, LEADER_URL VARCHAR, PROMPT VARCHAR,
            PROMPT_TYPE VARCHAR, CANDIDATE_TREND_ID VARCHAR
        ) AS
        SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()
    for i in range(BATCH_SIZE, len(prompt_values), BATCH_SIZE):
        batch = prompt_values[i:i+BATCH_SIZE]
        session.sql(f"""
            INSERT INTO TEMP_MATCH_PROMPTS
            SELECT * FROM VALUES {', '.join(batch)}
        """).collect()

    # Single batched Cortex call
    llm_results = session.sql(f"""
        SELECT IDX, LEADER_URL, PROMPT_TYPE, CANDIDATE_TREND_ID,
               SNOWFLAKE.CORTEX.COMPLETE('{LLM_MODEL}', PROMPT) AS LLM_RESPONSE
        FROM TEMP_MATCH_PROMPTS
    """).collect()

    # ── Step 8: Process LLM decisions → resolve TREND_IDs ────────────
    # Build resolution map: leader_url -> (trend_id, refined_topic)
    import uuid
    resolution = {}

    for row in llm_results:
        leader = row['LEADER_URL']
        ptype = row['PROMPT_TYPE']
        cand_id = row['CANDIDATE_TREND_ID']
        result = parse_json_response(row['LLM_RESPONSE'])

        if not result:
            stats['llm_failures'] += 1
            # Fallback: if candidate exists with high similarity, merge; otherwise new
            if ptype == 'match':
                resolution[leader] = (cand_id, None)
                stats['llm_merge'] += 1
            else:
                resolution[leader] = (str(uuid.uuid4()), None)
                stats['llm_no_candidates'] += 1
            continue

        decision = result.get('decision', 'NEW').upper()
        refined_topic = result.get('refined_topic')

        if ptype == 'match' and decision == 'MERGE' and cand_id:
            if leader not in resolution:
                resolution[leader] = (cand_id, refined_topic)
                stats['llm_merge'] += 1
        elif leader not in resolution:
            resolution[leader] = (str(uuid.uuid4()), refined_topic)
            if ptype == 'match':
                stats['llm_new'] += 1
            else:
                stats['llm_no_candidates'] += 1

    # Handle any leaders not in prompt_data (shouldn't happen, but safety)
    for comm in community_list:
        if comm['leader'] not in resolution:
            resolution[comm['leader']] = (str(uuid.uuid4()), None)

    # ── Step 9: Write resolved historical mapping to temp table ──────
    resolution_values = []
    for leader_url, (trend_id, refined_topic) in resolution.items():
        resolution_values.append(
            f"({escape_sql_str(leader_url)}, {escape_sql_str(trend_id)}, "
            f"{escape_sql_str(refined_topic)})"
        )

    first_batch = resolution_values[:BATCH_SIZE]
    session.sql(f"""
        CREATE OR REPLACE TEMP TABLE TEMP_HISTORICAL_RESOLUTION (
            ORIGINAL_LEADER_URL VARCHAR,
            TREND_ID VARCHAR,
            REFINED_TOPIC VARCHAR
        ) AS
        SELECT * FROM VALUES {', '.join(first_batch)}
    """).collect()
    for i in range(BATCH_SIZE, len(resolution_values), BATCH_SIZE):
        batch = resolution_values[i:i+BATCH_SIZE]
        session.sql(f"""
            INSERT INTO TEMP_HISTORICAL_RESOLUTION
            SELECT * FROM VALUES {', '.join(batch)}
        """).collect()

    # Also update mapping topic names where LLM provided refined ones
    session.sql("""
        UPDATE TEMP_CLUSTER_MAPPINGS m
        SET m.ORIGINAL_TOPIC = hr.REFINED_TOPIC,
            m.CURRENT_CENTRAL_TOPIC = hr.REFINED_TOPIC
        FROM TEMP_HISTORICAL_RESOLUTION hr
        WHERE m.ORIGINAL_LEADER_URL = hr.ORIGINAL_LEADER_URL
          AND hr.REFINED_TOPIC IS NOT NULL
    """).collect()

    stats['final_communities'] = len(community_list)

    # ── Step 10: Build resolved mappings using LLM-decided TREND_IDs ─
    session.sql("""
        CREATE OR REPLACE TEMP TABLE TEMP_RUN_RESOLVED_MAPPINGS AS
        WITH RESOLVED_MAPPINGS AS (
            SELECT
                m.ORIGINAL_LEADER_URL,
                m.ORIGINAL_TOPIC,
                ANY_VALUE(m.CURRENT_CENTRAL_TOPIC) AS CURRENT_CENTRAL_TOPIC,
                ANY_VALUE(ctr.TITLE_VECTOR) AS CENTRAL_TITLE_VECTOR,
                ANY_VALUE(ctr.DESCRIPTION_VECTOR) AS CENTRAL_DESCRIPTION_VECTOR,
                ANY_VALUE(orig.TITLE_VECTOR) AS ORIGINAL_TITLE_VECTOR,
                ANY_VALUE(orig.DESCRIPTION_VECTOR) AS ORIGINAL_DESCRIPTION_VECTOR,
                m.MATCH_URL,
                ANY_VALUE(src.TITLE_VECTOR) AS MATCH_TITLE_VECTOR,
                ANY_VALUE(src.DESCRIPTION_VECTOR) AS MATCH_DESCRIPTION_VECTOR,
                src.TITLE AS MATCH_TITLE,
                src.SIGNAL_NAME AS MATCH_SIGNAL_NAME,
                src.SIGNAL_TYPE AS MATCH_SIGNAL_TYPE,
                src.DETECTED_AT AS MATCH_DETECTED_AT,
                src.INGESTION_ID AS MATCH_INGESTION_ID,
                MAX(m.PAGERANK_SCORE) AS PAGERANK_SCORE
            FROM TEMP_CLUSTER_MAPPINGS m
            JOIN TEMP_ALL_EMBEDDINGS orig ON m.ORIGINAL_LEADER_URL = orig.URL
            JOIN TEMP_ALL_EMBEDDINGS ctr ON m.CURRENT_CENTRAL_LEADER_URL = ctr.URL
            JOIN TEMP_ALL_EMBEDDINGS src ON m.MATCH_URL = src.URL
            GROUP BY m.MATCH_URL, src.TITLE, src.SIGNAL_NAME, src.SIGNAL_TYPE,
                     src.DETECTED_AT, src.INGESTION_ID, m.ORIGINAL_LEADER_URL, m.ORIGINAL_TOPIC
        )
        SELECT
            hr.TREND_ID,
            r.*,
            t.LAST_UPDATE_AT AS TARGET_LAST_UPDATE_AT,
            COALESCE(t.TREND_VECTOR, r.ORIGINAL_TITLE_VECTOR) AS TREND_VECTOR,
            CASE WHEN NOT EXISTS (
                SELECT 1 FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s
                WHERE s.TREND_ID = hr.TREND_ID AND s.URL = r.MATCH_URL
            ) THEN TRUE ELSE FALSE END AS IS_NEW
        FROM RESOLVED_MAPPINGS r
        JOIN TEMP_HISTORICAL_RESOLUTION hr
            ON r.ORIGINAL_LEADER_URL = hr.ORIGINAL_LEADER_URL
        LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS t
            ON hr.TREND_ID = t.TREND_ID
    """).collect()

    # ── Step 11: Insert new signals ──────────────────────────────────
    session.sql("""
        INSERT INTO MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
            (TREND_ID, URL, TITLE, SIGNAL_NAME, DOMAIN, DETECTED_AT, INGESTION_ID, PAGERANK_SCORE)
        SELECT DISTINCT
            TREND_ID, MATCH_URL, MATCH_TITLE, MATCH_SIGNAL_NAME,
            CASE WHEN MATCH_URL LIKE '%://%' THEN PARSE_URL(MATCH_URL):host::STRING ELSE NULL END,
            MATCH_DETECTED_AT, MATCH_INGESTION_ID, PAGERANK_SCORE
        FROM TEMP_RUN_RESOLVED_MAPPINGS
        WHERE IS_NEW = TRUE
          AND TREND_ID IN (
              SELECT TREND_ID FROM TEMP_RUN_RESOLVED_MAPPINGS
              GROUP BY TREND_ID HAVING COUNT(DISTINCT MATCH_URL) >= 3
          )
    """).collect()

    # ── Step 12: Merge into FCT_TREND_METRICS ────────────────────────
    session.sql("""
        MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS AS target
        USING (
            WITH RUN_AGGS AS (
                SELECT
                    TREND_ID,
                    ANY_VALUE(TREND_VECTOR) AS TREND_VECTOR,
                    ANY_VALUE(ORIGINAL_TOPIC) AS TREND_TOPIC,
                    AVG((VECTOR_INNER_PRODUCT(ORIGINAL_TITLE_VECTOR, MATCH_TITLE_VECTOR) * 0.8 +
                         VECTOR_INNER_PRODUCT(ORIGINAL_DESCRIPTION_VECTOR, MATCH_DESCRIPTION_VECTOR) * 0.6) / 1.4) AS AVG_SIMILARITY,
                    COUNT(DISTINCT CASE WHEN IS_NEW THEN MATCH_URL END) AS DELTA_CLUSTER_SIZE,
                    MIN(MATCH_DETECTED_AT) AS RUN_MIN_DETECTED_AT,
                    MAX(MATCH_DETECTED_AT) AS RUN_MAX_DETECTED_AT
                FROM TEMP_RUN_RESOLVED_MAPPINGS
                GROUP BY TREND_ID
                HAVING COUNT(DISTINCT CASE WHEN IS_NEW THEN MATCH_URL END) >= 1
            ),
            STG_AGGS AS (
                SELECT
                    TREND_ID,
                    MIN(DETECTED_AT) AS DETECTED_AT,
                    MAX(DETECTED_AT) AS LAST_UPDATE_AT,
                    COUNT(DISTINCT URL) AS TOTAL_CLUSTER_SIZE,
                    COUNT(DISTINCT SIGNAL_NAME) AS DISTINCT_SOURCE_COUNT
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS
                WHERE TREND_ID IN (SELECT DISTINCT TREND_ID FROM RUN_AGGS)
                GROUP BY TREND_ID
                HAVING COUNT(DISTINCT URL) >= 3
            )
            SELECT
                ra.TREND_ID, ra.TREND_VECTOR, ra.TREND_TOPIC, ra.AVG_SIMILARITY,
                stg.DETECTED_AT, stg.LAST_UPDATE_AT, stg.TOTAL_CLUSTER_SIZE, stg.DISTINCT_SOURCE_COUNT
            FROM RUN_AGGS ra
            JOIN STG_AGGS stg ON ra.TREND_ID = stg.TREND_ID
        ) AS source
        ON target.TREND_ID = source.TREND_ID
        WHEN MATCHED THEN
            UPDATE SET
                target.TREND_VECTOR = source.TREND_VECTOR,
                target.TREND_TOPIC = source.TREND_TOPIC,
                target.LAST_UPDATE_AT = source.LAST_UPDATE_AT,
                target.TREND_DURATION_HR = GREATEST(TIMESTAMPDIFF(MINUTE, source.DETECTED_AT, source.LAST_UPDATE_AT) / 60, 0.1),
                target.TOTAL_CLUSTER_SIZE = source.TOTAL_CLUSTER_SIZE,
                target.DISTINCT_SOURCE_COUNT = source.DISTINCT_SOURCE_COUNT,
                target.AVG_SIMILARITY = source.AVG_SIMILARITY,
                target.SIGNALS_PER_SOURCE = ROUND((source.TOTAL_CLUSTER_SIZE * 1.0) / GREATEST(source.DISTINCT_SOURCE_COUNT, 1), 2)
        WHEN NOT MATCHED THEN
            INSERT (TREND_ID, TREND_VECTOR, TREND_TOPIC, DETECTED_AT, LAST_UPDATE_AT,
                    TREND_DURATION_HR, TOTAL_CLUSTER_SIZE, DISTINCT_SOURCE_COUNT,
                    AVG_SIMILARITY, VELOCITY_DIRECTION, SIGNALS_PER_SOURCE, SIGNAL_CHANGE, TREND_HEAT_INDEX)
            VALUES (
                source.TREND_ID, source.TREND_VECTOR, source.TREND_TOPIC,
                source.DETECTED_AT, source.LAST_UPDATE_AT,
                GREATEST(TIMESTAMPDIFF(MINUTE, source.DETECTED_AT, source.LAST_UPDATE_AT) / 60, 0.1),
                source.TOTAL_CLUSTER_SIZE, source.DISTINCT_SOURCE_COUNT, source.AVG_SIMILARITY,
                'NEW',
                ROUND((source.TOTAL_CLUSTER_SIZE * 1.0) / GREATEST(source.DISTINCT_SOURCE_COUNT, 1), 2),
                0, 0
            )
    """).collect()

    # ── Step 13: Daily snapshot + velocity ────────────────────────────
    session.sql("""
        MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS AS target
        USING (
            WITH DAILY_SIGNALS AS (
                SELECT s.TREND_ID, DATE(s.DETECTED_AT) AS SIGNAL_DATE, s.URL, s.SIGNAL_NAME
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s
                WHERE s.TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS)
            ),
            DAILY_AGGS AS (
                SELECT TREND_ID, SIGNAL_DATE AS SNAPSHOT_DATE,
                       COUNT(DISTINCT URL) AS NEW_SIGNALS_TODAY,
                       COUNT(DISTINCT SIGNAL_NAME) AS NEW_SOURCES_TODAY
                FROM DAILY_SIGNALS GROUP BY TREND_ID, SIGNAL_DATE
            ),
            CUMULATIVE AS (
                SELECT d.TREND_ID, d.SNAPSHOT_DATE, d.NEW_SIGNALS_TODAY, d.NEW_SOURCES_TODAY,
                       SUM(d.NEW_SIGNALS_TODAY) OVER (PARTITION BY d.TREND_ID ORDER BY d.SNAPSHOT_DATE) AS SIGNAL_COUNT,
                       SUM(d.NEW_SOURCES_TODAY) OVER (PARTITION BY d.TREND_ID ORDER BY d.SNAPSHOT_DATE) AS SOURCE_COUNT
                FROM DAILY_AGGS d
            )
            SELECT * FROM CUMULATIVE
        ) AS source
        ON target.TREND_ID = source.TREND_ID AND target.SNAPSHOT_DATE = source.SNAPSHOT_DATE
        WHEN MATCHED THEN UPDATE SET
            target.SIGNAL_COUNT = source.SIGNAL_COUNT, target.SOURCE_COUNT = source.SOURCE_COUNT,
            target.NEW_SIGNALS_TODAY = source.NEW_SIGNALS_TODAY, target.NEW_SOURCES_TODAY = source.NEW_SOURCES_TODAY
        WHEN NOT MATCHED THEN INSERT (TREND_ID, SNAPSHOT_DATE, SIGNAL_COUNT, SOURCE_COUNT, NEW_SIGNALS_TODAY, NEW_SOURCES_TODAY)
            VALUES (source.TREND_ID, source.SNAPSHOT_DATE, source.SIGNAL_COUNT, source.SOURCE_COUNT,
                    source.NEW_SIGNALS_TODAY, source.NEW_SOURCES_TODAY)
    """).collect()

    session.sql("""
        MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS AS target
        USING (
            WITH CURRENT_COUNTS AS (
                SELECT s.TREND_ID, COUNT(DISTINCT s.URL) AS SIGNAL_COUNT, COUNT(DISTINCT s.SIGNAL_NAME) AS SOURCE_COUNT
                FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_SIGNALS s
                WHERE s.TREND_ID IN (SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS)
                GROUP BY s.TREND_ID
            ),
            PREV_SNAPSHOT AS (
                SELECT TREND_ID, SIGNAL_COUNT, SOURCE_COUNT
                FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS
                WHERE (TREND_ID, SNAPSHOT_DATE) IN (
                    SELECT TREND_ID, MAX(SNAPSHOT_DATE)
                    FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS
                    WHERE SNAPSHOT_DATE < CURRENT_DATE() GROUP BY TREND_ID
                )
            )
            SELECT c.TREND_ID, CURRENT_DATE() AS SNAPSHOT_DATE, c.SIGNAL_COUNT, c.SOURCE_COUNT,
                   GREATEST(c.SIGNAL_COUNT - COALESCE(p.SIGNAL_COUNT, 0), 0) AS NEW_SIGNALS_TODAY,
                   GREATEST(c.SOURCE_COUNT - COALESCE(p.SOURCE_COUNT, 0), 0) AS NEW_SOURCES_TODAY
            FROM CURRENT_COUNTS c LEFT JOIN PREV_SNAPSHOT p ON c.TREND_ID = p.TREND_ID
        ) AS source
        ON target.TREND_ID = source.TREND_ID AND target.SNAPSHOT_DATE = source.SNAPSHOT_DATE
        WHEN MATCHED THEN UPDATE SET
            target.SIGNAL_COUNT = source.SIGNAL_COUNT, target.SOURCE_COUNT = source.SOURCE_COUNT,
            target.NEW_SIGNALS_TODAY = source.NEW_SIGNALS_TODAY, target.NEW_SOURCES_TODAY = source.NEW_SOURCES_TODAY
        WHEN NOT MATCHED THEN INSERT (TREND_ID, SNAPSHOT_DATE, SIGNAL_COUNT, SOURCE_COUNT, NEW_SIGNALS_TODAY, NEW_SOURCES_TODAY)
            VALUES (source.TREND_ID, source.SNAPSHOT_DATE, source.SIGNAL_COUNT, source.SOURCE_COUNT,
                    source.NEW_SIGNALS_TODAY, source.NEW_SOURCES_TODAY)
    """).collect()

    session.sql("""
        UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TREND_METRICS f
        SET
            f.SIGNAL_CHANGE = ROUND(
                CASE WHEN COALESCE(yesterday.SIGNAL_COUNT, 0) = 0 THEN 0
                     ELSE ((today.SIGNAL_COUNT - yesterday.SIGNAL_COUNT) * 100.0) / yesterday.SIGNAL_COUNT END, 1),
            f.VELOCITY_DIRECTION =
                CASE
                    WHEN today.NEW_SIGNALS_TODAY > 0 AND yesterday.SIGNAL_COUNT IS NULL THEN 'NEW'
                    WHEN today.NEW_SIGNALS_TODAY > COALESCE(yesterday.NEW_SIGNALS_TODAY, 0) THEN 'GROWING'
                    WHEN today.NEW_SIGNALS_TODAY = COALESCE(yesterday.NEW_SIGNALS_TODAY, 0) AND today.NEW_SIGNALS_TODAY > 0 THEN 'STABLE'
                    WHEN today.NEW_SIGNALS_TODAY < COALESCE(yesterday.NEW_SIGNALS_TODAY, 0) AND today.NEW_SIGNALS_TODAY > 0 THEN 'DECLINING'
                    ELSE 'STAGNANT'
                END,
            f.TREND_HEAT_INDEX = ROUND(
                LEAST(CASE WHEN COALESCE(yesterday.NEW_SIGNALS_TODAY, 0) = 0 AND today.NEW_SIGNALS_TODAY > 0 THEN 100
                           WHEN COALESCE(yesterday.NEW_SIGNALS_TODAY, 0) = 0 THEN 0
                           ELSE (today.NEW_SIGNALS_TODAY * 100.0) / yesterday.NEW_SIGNALS_TODAY END, 100) * 0.4
                + LEAST((today.SOURCE_COUNT * 100.0) / GREATEST(max_sources.MAX_SOURCE_COUNT, 1), 100) * 0.3
                + GREATEST(100 - (TIMESTAMPDIFF(HOUR, f.LAST_UPDATE_AT, CURRENT_TIMESTAMP()) * 4.16), 0) * 0.3
            , 1)
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS today
        LEFT JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS yesterday
            ON today.TREND_ID = yesterday.TREND_ID
            AND yesterday.SNAPSHOT_DATE = (
                SELECT MAX(SNAPSHOT_DATE) FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS prev
                WHERE prev.TREND_ID = today.TREND_ID AND prev.SNAPSHOT_DATE < today.SNAPSHOT_DATE
            )
        CROSS JOIN (
            SELECT MAX(SOURCE_COUNT) AS MAX_SOURCE_COUNT
            FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_DAILY_SNAPSHOTS WHERE SNAPSHOT_DATE = CURRENT_DATE()
        ) max_sources
        WHERE today.TREND_ID = f.TREND_ID AND today.SNAPSHOT_DATE = CURRENT_DATE()
            AND f.VELOCITY_DIRECTION != 'SUPERSEDED'
    """).collect()

    # Count final mappings
    count_row = session.sql("SELECT COUNT(*) AS N FROM TEMP_RUN_RESOLVED_MAPPINGS WHERE IS_NEW = TRUE").collect()
    stats['final_mappings'] = int(count_row[0]['N']) if count_row else 0

    # ── Summary ──────────────────────────────────────────────────────
    return json.dumps(stats)
$$;
