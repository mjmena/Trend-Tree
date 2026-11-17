"""Evaluate a claimed nomination, apply it once, and persist its public outcome.

The receipt owns retries; committed candidate fields establish successful
promotion. Every domain write checks the same ownership fence in Snowflake.
"""

from __future__ import annotations

import json
import logging
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from tt_services_lib.gemini import PredictionLLM
from tt_services_lib.snowflake_client import SnowflakeClient

from .outcomes import SnowflakeNominationStore

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


class TaskBusy(TaskError):
    """Another delivery owns this nomination; preserve the queue retry."""


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


def url_titles(task: dict[str, Any]) -> list[str]:
    return [u["title"] for u in task["urls"] if u.get("title")]


def judge_sameness(
    snowflake: SnowflakeClient, llm: PredictionLLM, topic: str, task: dict[str, Any]
) -> tuple[Judgment, dict[str, Any]]:
    """Does the nomination duplicate a live trend? Raises TaskError on any
    failure: a failed judgment never falls back to PROMOTE_NEW."""
    titles = url_titles(task)[:3]
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
    store: SnowflakeNominationStore | None = None,
) -> dict[str, Any]:
    store = store or SnowflakeNominationStore(snowflake)
    nid = task["nomination_id"]
    # A queued task can outlive the service revision that accepted it.
    receipt = store.get(nid) or store.accept(task, [])
    if receipt.terminal:
        return receipt.snapshot()
    owner = uuid4().hex
    receipt = store.claim(nid, owner)
    if receipt is None:
        raise TaskBusy("nomination is already processing")
    if receipt.terminal:
        return receipt.snapshot()
    task = receipt.request
    try:
        candidate = read_candidate(snowflake, nid)
        if candidate and candidate.get("PROMOTED_AT"):
            return store.complete(nid, owner).snapshot()

        if receipt.plan is None:
            topic_usage: dict[str, Any] = {}
            if candidate:
                topic = candidate["TOPIC"]
            else:
                topic, topic_usage = write_topic(snowflake, llm, task)
            judgment, judge_usage = judge_sameness(snowflake, judge_llm, topic, task)
            receipt = store.save_plan(
                nid,
                owner,
                {
                    "topic": topic,
                    "judgment": asdict(judgment),
                    "usage": _merge_usage(topic_usage, judge_usage),
                },
            )
        plan = receipt.plan
        store.prepare(nid, owner, build_signals(task))
        apply_promotion(
            snowflake,
            task,
            plan["topic"],
            Judgment(**plan["judgment"]),
            plan["usage"],
            owner=owner,
        )
        receipt = store.complete(nid, owner)
    except Exception:
        try:
            store.attempt_failed(nid, owner)
        except Exception:
            log.exception("could not record nomination attempt failure for %s", nid)
        raise

    if receipt.status == "created":
        try:
            dispatch(receipt.trend_id)
        except Exception:
            log.exception("enrichment dispatch failed for %s", receipt.trend_id)
    return receipt.snapshot()


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
    user = json.dumps({"brief": task["brief"], "url_titles": url_titles(task)})
    resp = llm.complete(system=_prompt(snowflake, TOPIC_PROMPT_KEY), user=user)
    try:
        topic = " ".join(str(json.loads(resp.text)["topic"]).split())
    except (ValueError, KeyError, TypeError) as err:
        raise TaskError(f'topic reply is not {{"topic": ...}}: {resp.text[:200]!r}') from err
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


def build_signals(task: dict[str, Any]) -> list[dict[str, Any]]:
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
    return signals


def apply_promotion(
    snowflake: SnowflakeClient,
    task: dict[str, Any],
    topic: str,
    judgment: Judgment,
    usage: dict[str, Any],
    *,
    owner: str,
) -> dict[str, Any]:
    nid = task["nomination_id"]
    decision = {
        "candidate_id": nid,
        "editorial_owner": owner,
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
