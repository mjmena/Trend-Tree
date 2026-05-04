-- Procedure: Cluster a subset of signals using Louvain community detection.
-- Database: MCC_RAW.MARKETING_DEV
--
-- Builds a cosine similarity graph from FCT_SIGNALS.SIGNAL_VECTOR embeddings,
-- then runs the Louvain algorithm to discover natural communities. This finds
-- the number of clusters organically from the data rather than forcing a
-- target k — useful for consumer trend signals where topic sizes vary widely.
--
-- Edge threshold (0.3): signals with cosine similarity > 0.3 get a graph edge.
-- Low threshold = more edges = Louvain has more structure to detect communities.
-- Singletons (communities of size < 2) are excluded from the output.
--
-- Signals without a row in FCT_SIGNALS (not yet promoted by
-- TASK_PROMOTE_SIGNALS_TO_FCT) are dropped — caller should filter to recent signals.
--
-- Usage:
--   CALL MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(
--     PARSE_JSON('["sig-1","sig-2",...]')::ARRAY,
--     0.8
--   );
--
-- Returns: VARIANT array of objects:
--   { signal_id, cluster_id, signal_title, source_name, similarity_to_seed }
--   (similarity_to_seed = avg intra-cluster edge weight; comparable to k-means)

CREATE OR REPLACE PROCEDURE MCC_RAW.MARKETING_DEV.PROC_CLUSTER_SIGNAL_SUBSET(
    SIGNAL_IDS  ARRAY,
    RESOLUTION  FLOAT DEFAULT 0.8
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'networkx')
HANDLER = 'run'
EXECUTE AS CALLER
AS
$$
import json
import networkx as nx
from networkx.algorithms.community import louvain_communities


EDGE_THRESHOLD = 0.3


def run(session, SIGNAL_IDS, RESOLUTION):
    if not SIGNAL_IDS:
        return []
    if isinstance(SIGNAL_IDS, str):
        SIGNAL_IDS = json.loads(SIGNAL_IDS)

    resolution = float(RESOLUTION) if RESOLUTION is not None else 0.8
    ids_json = json.dumps(list(SIGNAL_IDS))

    # Step 1: fetch node metadata (title, source) for signals that have vectors.
    nodes_rs = session.sql(f"""
        SELECT f.SIGNAL_ID, f.SIGNAL_TITLE, f.SOURCE_NAME
        FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
        WHERE f.SIGNAL_ID IN (
          SELECT VALUE::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{ids_json}')))
        ) AND f.SIGNAL_VECTOR IS NOT NULL
    """).collect()

    if not nodes_rs:
        return []

    signal_ids = [r['SIGNAL_ID'] for r in nodes_rs]
    titles = {r['SIGNAL_ID']: r['SIGNAL_TITLE'] for r in nodes_rs}
    sources = {r['SIGNAL_ID']: r['SOURCE_NAME'] for r in nodes_rs}

    if len(signal_ids) < 2:
        return []

    # Step 2: compute threshold-filtered pairwise similarities using
    # Snowflake's native VECTOR_COSINE_SIMILARITY. Avoids pulling 1024-dim
    # float arrays into Python memory; returns only edges we'll use.
    edges_rs = session.sql(f"""
        WITH signals AS (
          SELECT f.SIGNAL_ID, f.SIGNAL_VECTOR
          FROM MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS f
          WHERE f.SIGNAL_ID IN (
            SELECT VALUE::STRING FROM TABLE(FLATTEN(INPUT => PARSE_JSON('{ids_json}')))
          ) AND f.SIGNAL_VECTOR IS NOT NULL
        )
        SELECT a.SIGNAL_ID AS SID_A,
               b.SIGNAL_ID AS SID_B,
               VECTOR_COSINE_SIMILARITY(a.SIGNAL_VECTOR, b.SIGNAL_VECTOR) AS SIM
        FROM signals a
        JOIN signals b ON a.SIGNAL_ID < b.SIGNAL_ID
        WHERE VECTOR_COSINE_SIMILARITY(a.SIGNAL_VECTOR, b.SIGNAL_VECTOR) > {EDGE_THRESHOLD}
    """).collect()

    # Step 3: build networkx graph and run Louvain.
    G = nx.Graph()
    G.add_nodes_from(signal_ids)
    for r in edges_rs:
        G.add_edge(r['SID_A'], r['SID_B'], weight=float(r['SIM']))

    communities = louvain_communities(G, resolution=resolution, seed=42)

    # Step 4: format output; skip singletons.
    result = []
    for cluster_id, community in enumerate(communities):
        members = list(community)
        if len(members) < 2:
            continue

        community_set = set(members)
        intra_weights = [
            d.get('weight', EDGE_THRESHOLD)
            for u, v, d in G.edges(members, data=True)
            if u in community_set and v in community_set
        ]
        avg_sim = round(
            sum(intra_weights) / len(intra_weights), 4
        ) if intra_weights else EDGE_THRESHOLD

        for sid in members:
            result.append({
                'signal_id': sid,
                'cluster_id': cluster_id,
                'signal_title': titles.get(sid, ''),
                'source_name': sources.get(sid, ''),
                'similarity_to_seed': avg_sim,
            })

    return result
$$;
