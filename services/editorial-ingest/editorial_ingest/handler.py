"""The task handler's work: one accepted nomination -> one editorial trend
(CRMA-1668, spec "The task handler").

    1. topic      a tool-free Gemini call writes the trend topic
    2. sameness   CRMA-1671: judge the topic against promotion's neighbor pool
    3. signals    MERGE_EXTERNAL_SIGNALS, source name `editorial`
    4. candidate  one STG_TREND_CANDIDATES row, VERDICT NULL
    5. promotion  PROC_PROMOTION_APPLY, decision_category EDITORIAL;
                  PROMOTE_NEW is followed by a dispatcher POST

Nothing is written until steps 1 and 2 succeed. Any failure raises, the route
answers non-2xx and Cloud Tasks retries; there is no retry loop here.

Resume: the candidate row (CANDIDATE_ID = nomination_id) is the checkpoint.
PROMOTED_AT set -> done. Present but unpromoted -> skip 3 and 4, go to 5.
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


def judge_sameness(topic: str, task: dict[str, Any]) -> Judgment:
    # shortcut: no duplicate check until CRMA-1671; every nomination is a new trend.
    return Judgment(rationale="editorial nomination; no sameness judgment yet (CRMA-1671)")


def handle_nomination(
    task: dict[str, Any], *, snowflake: SnowflakeClient, llm: PredictionLLM, dispatch: Dispatch
) -> dict[str, Any]:
    nid = task["nomination_id"]
    candidate = read_candidate(snowflake, nid)
    if candidate and candidate.get("PROMOTED_AT"):
        return {"status": "done", "trend_id": candidate.get("PROMOTED_TO")}

    usage: dict[str, Any] = {}
    if candidate:
        topic = candidate["TOPIC"]
    else:
        topic, usage = write_topic(snowflake, llm, task)
    judgment = judge_sameness(topic, task)
    if not candidate:
        signal_ids = merge_signals(snowflake, task)
        insert_candidate(snowflake, task, topic, signal_ids)

    result = apply_promotion(snowflake, task, topic, judgment, usage)
    if result["decision"] == "PROMOTE_NEW":
        dispatch(result["target_trend_id"])
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
    rows = snowflake.query(
        "SELECT TEMPLATE, VERSION FROM MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT"
        " WHERE PROMPT_KEY = %(key)s AND IS_ACTIVE = TRUE ORDER BY VERSION DESC LIMIT 1",
        {"key": TOPIC_PROMPT_KEY},
    )
    if not rows:
        raise TaskError(f"no active DIM_LLM_PROMPT row for {TOPIC_PROMPT_KEY}")
    user = json.dumps(
        {"brief": task["brief"], "url_titles": [u["title"] for u in task["urls"] if u.get("title")]}
    )
    resp = llm.complete(system=rows[0]["TEMPLATE"], user=user)
    try:
        topic = " ".join(str(json.loads(resp.text)["topic"]).split())
    except (ValueError, KeyError, TypeError) as err:
        raise TaskError(f"topic reply is not {{\"topic\": ...}}: {resp.text[:200]!r}") from err
    if not topic:
        raise TaskError("topic reply is empty")
    usage = {
        "model_used": resp.model,
        "tokens": {"input": resp.input_tokens, "output": resp.output_tokens},
        "cost_usd": resp.cost_usd,
    }
    return topic[:MAX_TOPIC_CHARS], usage


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
