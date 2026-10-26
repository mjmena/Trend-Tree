"""The task handler's work: one accepted nomination -> one editorial trend
(CRMA-1668, spec "The task handler").

    1. topic      a tool-free Gemini call writes the trend topic
    2. sameness   a tool-free Gemini call judges the topic against promotion's
                  neighbor pool (CRMA-1671); an empty pool skips the call
    3. signals    MERGE_EXTERNAL_SIGNALS, source name `editorial`
    4. candidate  one STG_TREND_CANDIDATES row, VERDICT NULL
    5. promotion  PROC_PROMOTION_APPLY, decision_category EDITORIAL;
                  no match -> PROMOTE_NEW, then a dispatcher POST;
                  match -> MERGE_INTO_EXISTING, no dispatch, and a RETIRED
                  target also gets a RESURGENT lifecycle row

Nothing is written until steps 1 and 2 succeed. Any failure raises, the route
answers non-2xx and Cloud Tasks retries; there is no retry loop here.

Resume: the candidate row (CANDIDATE_ID = nomination_id) is the checkpoint.
PROMOTED_AT set -> done (after re-asserting a merge's RESURGENT row).
Present but unpromoted -> skip 3 and 4, go to 5.
A ledger row is not the test: the proc logs errored decisions too, and logs
after its COMMIT.
"""

from __future__ import annotations

import json
import logging
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from tt_services_lib.gemini import PredictionLLM
from tt_services_lib.snowflake_client import SnowflakeClient

log = logging.getLogger(__name__)

SOURCE_NAME = "editorial"
TOPIC_PROMPT_KEY = "editorial.topic"
# Code pins the model (repo convention); DIM_LLM_PROMPT.MODEL is the record.
TOPIC_MODEL = "gemini-3.7-flash"
SAMENESS_PROMPT_KEY = "editorial.sameness"
# Confirmed in the Gemini models list 2026-10-26 (spec: "Gemini 3.8").
JUDGE_MODEL = "gemini-3.8-flash"
# Promotion's neighbor recipe (promotion-p_xMC99jg q_compute_vectors_and_neighbors).
EMBED_MODEL = "snowflake-arctic-embed-l-v2.0"
MIN_NEIGHBOR_SIM = 0.50
MAX_NEIGHBORS = 8
MAX_TOPIC_CHARS = 200  # STG_TREND_CANDIDATES.TOPIC is VARCHAR(200)
DISPATCH_TIMEOUT_S = 30

# trend_id -> None. Fire-and-forget: promotion's daily CRMA-1032 sweep
# re-dispatches any trend left unenriched, so a failure here only logs.
Dispatch = Callable[[str], None]


class TaskError(RuntimeError):
    """A step failed; the task answers non-2xx and Cloud Tasks retries."""


@dataclass(frozen=True)
class Judgment:
    """The sameness judgment's outcome. ``target_trend_id`` None means no
    match (PROMOTE_NEW); a trend id means MERGE_INTO_EXISTING (CRMA-1671)."""

    target_trend_id: str | None = None
    rationale: str = ""
    max_neighbor_sim: float | None = None
    considered_neighbors: list[dict[str, Any]] = field(default_factory=list)


# Every live trend's latest vector; no lifecycle filter, so RETIRED trends can
# match. The nomination has no candidate row yet, so its text is embedded here.
NEIGHBOR_SQL = f"""
WITH q AS (
  SELECT SNOWFLAKE.CORTEX.EMBED_TEXT_1024('{EMBED_MODEL}', %(text)s) AS V
),
e AS (
  SELECT TREND_ID, TREND_VECTOR, PAYLOAD:summary_short::STRING AS SUMMARY_SHORT
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER
  WHERE TREND_VECTOR IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY WRITTEN_AT DESC) = 1
),
lc AS (
  SELECT TREND_ID, NEW_STATUS
  FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER
  QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) = 1
)
SELECT t.TREND_ID, t.TREND_TOPIC, e.SUMMARY_SHORT, lc.NEW_STATUS AS LIFECYCLE_STATUS,
       ROUND(VECTOR_COSINE_SIMILARITY(q.V, e.TREND_VECTOR), 4) AS SIMILARITY
FROM e
JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t ON t.TREND_ID = e.TREND_ID
LEFT JOIN lc ON lc.TREND_ID = t.TREND_ID
CROSS JOIN q
WHERE VECTOR_COSINE_SIMILARITY(q.V, e.TREND_VECTOR) >= {MIN_NEIGHBOR_SIM}
ORDER BY SIMILARITY DESC
LIMIT {MAX_NEIGHBORS}
"""


def judge_sameness(
    snowflake: SnowflakeClient, llm: PredictionLLM, topic: str, task: dict[str, Any]
) -> tuple[Judgment, dict[str, Any]]:
    """Does the nomination duplicate a live trend? Raises TaskError on any
    failure: a failed judgment never falls back to PROMOTE_NEW."""
    titles = [u["title"] for u in task["urls"] if u.get("title")][:3]
    pool = snowflake.query(
        NEIGHBOR_SQL, {"text": f"{topic} | {task['brief'][:800]} | {', '.join(titles)}"}
    )
    if not pool:
        return Judgment(rationale=f"no live trend at cosine >= {MIN_NEIGHBOR_SIM}; not judged"), {}

    user = json.dumps(
        {
            "nomination": {"topic": topic, "brief": task["brief"], "url_titles": titles},
            "neighbors": [
                {
                    "trend_id": n["TREND_ID"],
                    "topic": n["TREND_TOPIC"],
                    "summary": n.get("SUMMARY_SHORT"),
                    "lifecycle_status": n.get("LIFECYCLE_STATUS"),
                    "similarity": n["SIMILARITY"],
                }
                for n in pool
            ],
        }
    )
    resp = llm.complete(system=_prompt(snowflake, SAMENESS_PROMPT_KEY), user=user)
    try:
        reply = json.loads(resp.text)
        match, rationale = reply["match"], str(reply["rationale"])
    except (ValueError, KeyError, TypeError) as err:
        raise TaskError(f"sameness reply is not {{match, rationale}}: {resp.text[:200]!r}") from err
    by_id = {n["TREND_ID"]: n for n in pool}
    if match is not None and match not in by_id:
        raise TaskError(f"sameness judge matched {match!r}, which is not in the neighbor pool")

    judgment = Judgment(
        target_trend_id=match,
        rationale=rationale,
        max_neighbor_sim=max(float(n["SIMILARITY"]) for n in pool),
        considered_neighbors=[
            {
                "trend_id": n["TREND_ID"],
                "similarity": n["SIMILARITY"],
                "lifecycle_status": n.get("LIFECYCLE_STATUS"),
                "judgment": "match" if n["TREND_ID"] == match else "different",
            }
            for n in pool
        ],
    )
    return judgment, _usage(resp)


def handle_nomination(
    task: dict[str, Any],
    *,
    snowflake: SnowflakeClient,
    llm: PredictionLLM,
    judge_llm: PredictionLLM,
    dispatch: Dispatch,
) -> dict[str, Any]:
    nid = task["nomination_id"]
    candidate = read_candidate(snowflake, nid)
    if candidate and candidate.get("PROMOTED_AT"):
        if candidate.get("DEDUP_OF_TREND_ID"):
            # The proc committed but the task died before the RESURGENT row.
            mark_resurgent(snowflake, nid, candidate["DEDUP_OF_TREND_ID"])
        return {"status": "done", "trend_id": candidate.get("PROMOTED_TO")}

    topic_usage: dict[str, Any] = {}
    if candidate:
        topic = candidate["TOPIC"]
    else:
        topic, topic_usage = write_topic(snowflake, llm, task)
    judgment, judge_usage = judge_sameness(snowflake, judge_llm, topic, task)
    if not candidate:
        signal_ids = merge_signals(snowflake, task)
        insert_candidate(snowflake, task, topic, signal_ids)

    usage = _merge_usage(topic_usage, judge_usage)
    result = apply_promotion(snowflake, task, topic, judgment, usage)
    if result["decision"] == "PROMOTE_NEW":
        dispatch(result["target_trend_id"])
    else:
        mark_resurgent(snowflake, nid, result["target_trend_id"])
    return {"status": "promoted", "decision": result["decision"],
            "trend_id": result["target_trend_id"]}


def read_candidate(snowflake: SnowflakeClient, nid: str) -> dict[str, Any] | None:
    rows = snowflake.query(
        "SELECT TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID"
        " FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES WHERE CANDIDATE_ID = %(id)s",
        {"id": nid},
    )
    return rows[0] if rows else None


def write_topic(
    snowflake: SnowflakeClient, llm: PredictionLLM, task: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    user = json.dumps(
        {"brief": task["brief"], "url_titles": [u["title"] for u in task["urls"] if u.get("title")]}
    )
    resp = llm.complete(system=_prompt(snowflake, TOPIC_PROMPT_KEY), user=user)
    try:
        topic = " ".join(str(json.loads(resp.text)["topic"]).split())
    except (ValueError, KeyError, TypeError) as err:
        raise TaskError(f"topic reply is not {{\"topic\": ...}}: {resp.text[:200]!r}") from err
    if not topic:
        raise TaskError("topic reply is empty")
    return topic[:MAX_TOPIC_CHARS], _usage(resp)


def _prompt(snowflake: SnowflakeClient, key: str) -> str:
    rows = snowflake.query(
        "SELECT TEMPLATE, VERSION FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT"
        " WHERE PROMPT_KEY = %(key)s AND IS_ACTIVE = TRUE ORDER BY VERSION DESC LIMIT 1",
        {"key": key},
    )
    if not rows:
        raise TaskError(f"no active DIM_LLM_PROMPT row for {key}")
    return rows[0]["TEMPLATE"]


def _usage(resp: Any) -> dict[str, Any]:
    return {
        "model_used": resp.model,
        "tokens": {"input": resp.input_tokens, "output": resp.output_tokens},
        "cost_usd": resp.cost_usd,
    }


def _merge_usage(topic: dict[str, Any], judge: dict[str, Any]) -> dict[str, Any]:
    """One ledger row per decision: MODEL_USED names the judge when it ran
    (it made the decision), tokens sum, and cost is None if either call is
    unpriced (unknown, not zero -- tt_services_lib.gemini)."""
    calls = [u for u in (topic, judge) if u]
    if not calls:
        return {}
    costs = [u["cost_usd"] for u in calls]
    return {
        "model_used": calls[-1]["model_used"],
        "tokens": {
            "input": sum(u["tokens"]["input"] for u in calls),
            "output": sum(u["tokens"]["output"] for u in calls),
        },
        "cost_usd": None if None in costs else sum(costs),
    }


def merge_signals(snowflake: SnowflakeClient, task: dict[str, Any]) -> list[str]:
    """The person's URLs as `editorial` signals under the nomination's own
    session, so distillation cannot acquire them. A URL another session
    claimed first keeps that claim (the MERGE never overwrites one)."""
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
    signals = [
        {
            "SIGNAL_ID": u["canonical"],
            "SOURCE_NAME": SOURCE_NAME,
            "SIGNAL_TIMESTAMP": now,
            "SIGNAL_TITLE": u.get("title"),
            "SIGNAL_TEXT": None,
            "URL": u["canonical"],
            # The MERGE parses METADATA from a JSON string.
            "METADATA": json.dumps(
                {
                    "original_url": u["url"],
                    "canonical_url": u["canonical"],
                    "http_status": u["http_status"],
                    "status_class": u["status_class"],
                    "unverified": u["unverified"],
                    "article_title": u.get("title"),
                    "nomination_id": task["nomination_id"],
                }
            ),
        }
        for u in task["urls"]
    ]
    rows = snowflake.query(
        "CALL MCC_RAW.MARKETING_DEV.MERGE_EXTERNAL_SIGNALS("
        "%(signals)s, %(session)s, 500, 'STG_EXTERNAL_SIGNALS')",
        {"signals": json.dumps(signals), "session": task["nomination_id"]},
    )
    result = _variant(rows, "MERGE_EXTERNAL_SIGNALS")
    if not isinstance(result, dict) or result.get("error"):
        # The proc returns its errors instead of raising.
        raise TaskError(f"MERGE_EXTERNAL_SIGNALS failed: {result}")
    return [s["SIGNAL_ID"] for s in signals]


def insert_candidate(
    snowflake: SnowflakeClient, task: dict[str, Any], topic: str, signal_ids: list[str]
) -> None:
    # VERDICT NULL keeps the promotion agent away (ADR-0011). SOURCE_BREAKDOWN
    # gives the proc's heat seed a source family to count. The PK is
    # informational only, hence the NOT EXISTS guard.
    snowflake.execute(
        "INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES"
        " (CANDIDATE_ID, AGENT_SESSION_ID, CHAIN_ID, ITERATION, TOPIC,"
        "  SUPPORTING_SIGNAL_IDS, SOURCE_BREAKDOWN, REASONING)"
        " SELECT %(id)s, %(id)s, %(id)s, 1, %(topic)s,"
        "  PARSE_JSON(%(ids)s), PARSE_JSON(%(breakdown)s), %(brief)s"
        " WHERE NOT EXISTS (SELECT 1 FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES"
        "  WHERE CANDIDATE_ID = %(id)s)",
        {
            "id": task["nomination_id"],
            "topic": topic,
            "ids": json.dumps(signal_ids),
            "breakdown": json.dumps({SOURCE_NAME: len(signal_ids)}),
            "brief": task["brief"],
        },
    )


def apply_promotion(
    snowflake: SnowflakeClient,
    task: dict[str, Any],
    topic: str,
    judgment: Judgment,
    usage: dict[str, Any],
) -> dict[str, Any]:
    nid = task["nomination_id"]
    decision = {
        "candidate_id": nid,
        "decision": "PROMOTE_NEW" if judgment.target_trend_id is None else "MERGE_INTO_EXISTING",
        "decision_category": "EDITORIAL",
        "target_trend_id": judgment.target_trend_id,
        "trend_topic": topic,
        "rationale": judgment.rationale,
        "max_neighbor_sim": judgment.max_neighbor_sim,
        "considered_neighbors": judgment.considered_neighbors,
        "nomination": {"nominated_by": task["nominated_by"], "brief": task["brief"]},
        "model_used": usage.get("model_used", TOPIC_MODEL),
        "tokens": usage.get("tokens", {}),
        "cost_usd": usage.get("cost_usd"),
    }
    rows = snowflake.query(
        "CALL MCC_RAW.MARKETING_DEV.PROC_PROMOTION_APPLY(PARSE_JSON(%(decisions)s), %(chain)s, 1)",
        {"decisions": json.dumps([decision]), "chain": nid},
    )
    summary = _variant(rows, "PROC_PROMOTION_APPLY")
    results = (summary or {}).get("results") or [{}]
    if results[0].get("status") != "ok" or not results[0].get("target_trend_id"):
        raise TaskError(f"PROC_PROMOTION_APPLY did not apply: {results[0]}")
    return results[0]


def mark_resurgent(snowflake: SnowflakeClient, nid: str, trend_id: str) -> None:
    """A merge into a RETIRED trend brings it back: the lifecycle sweep skips
    RETIRED, so this endpoint writes the RESURGENT row (the ledger's second
    writer, after the lifecycle agent). Column set follows the proc's
    seed_lifecycle_v0; heat carries forward so the dashboard does not show 0;
    NEXT_EVAL_AT +1h puts the trend back in the sweep.

    Written after PROC_PROMOTION_APPLY, not inside its transaction: the proc
    owns its own per-decision BEGIN/COMMIT and is shared with promotion. The
    "latest row is RETIRED" guard makes it idempotent, so the done-path of a
    retried task can re-run it safely; a no-op when the target is not RETIRED."""
    snowflake.execute(
        "INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER"
        " (TREND_ID, AGENT_SESSION_ID, CHAIN_ID, PRIOR_STATUS, NEW_STATUS,"
        "  PRIOR_HEAT, NEW_HEAT, NEW_HEAT_SMOOTHED, HEAT_BASE, HEAT_MODIFIER_PCT,"
        "  REASONING, DECISION_PAYLOAD, MODEL_USED, NEXT_EVAL_AT)"
        " SELECT TREND_ID, 'editorial', %(chain)s, NEW_STATUS, 'RESURGENT',"
        "  NEW_HEAT, NEW_HEAT, NEW_HEAT_SMOOTHED, HEAT_BASE, 0,"
        "  'editorial nomination matched a retired trend',"
        "  OBJECT_CONSTRUCT('nomination_id', %(chain)s), NULL,"
        "  DATEADD(hour, 1, CURRENT_TIMESTAMP())"
        " FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_LIFECYCLE_LEDGER"
        " WHERE TREND_ID = %(tid)s"
        " QUALIFY ROW_NUMBER() OVER (PARTITION BY TREND_ID ORDER BY EVALUATED_AT DESC) = 1"
        "  AND NEW_STATUS = 'RETIRED'",
        {"chain": nid, "tid": trend_id},
    )


def http_dispatch(url: str) -> Dispatch:
    """promotion's fire_enrichment_chain: POST {trend_id}. The dispatcher runs
    the chain before answering, so the 30 s timeout is the normal outcome."""

    def dispatch(trend_id: str) -> None:
        req = urllib.request.Request(
            url,
            data=json.dumps({"trend_id": trend_id}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT_S):  # noqa: S310
                pass
        except Exception as err:  # noqa: BLE001 - logged, never thrown (see Dispatch)
            log.info("dispatcher POST for %s ended without a response: %s", trend_id, err)

    return dispatch


def _variant(rows: list[dict[str, Any]], column: str) -> Any:
    value = rows[0].get(column) if rows else None
    return json.loads(value) if isinstance(value, str) else value
