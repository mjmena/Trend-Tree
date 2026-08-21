"""The local loop for the compare step: run the real matching phase against
fixtures, no deploy (CRMA-764).

    cd services/prediction
    uv run --python 3.12 python local_match.py

Offline by default -- the open predictions come from
``fixtures/open_predictions.sample.json``, the trends from
``fixtures/trends.sample.json``, and the matched verdict's narrative is
replayed from ``fixtures/match_reply.sample.json``, so the run costs nothing,
needs no key and needs no warehouse. It exercises the same
``match_open_predictions`` the deployed route calls, through the same reader
interfaces.

The fixture trends carry a ``SIMILARITY`` their author wrote; the cosine
itself is Snowflake's and is not simulated here. What this loop exercises is
the decision made *with* a similarity -- the descriptor-vocabulary leg, the
embedding floor, and what lands in EVIDENCE either way.

    --live-llm       call Gemini for real (PREDICTION_GEMINI_API_KEY required)
    --model NAME     which model --live-llm calls
    --print-prompt   dump the prompt each matched prediction would send
    --predictions PATH / --trends PATH / --reply PATH
    --min-similarity F  the embedding leg's cosine floor
    --prediction-limit N / --candidate-limit N

This never writes to Snowflake in any mode. It prints the verdict rows the
deployed run would append; landing them is POST /match's job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from prediction_service.generation.llm import (
    DEFAULT_MODEL,
    GeminiPredictionLLM,
    PredictionLLM,
    ReplayLLM,
)
from prediction_service.matching.decide import DEFAULT_MIN_SIMILARITY
from prediction_service.matching.predictions import StaticOpenPredictionReader
from prediction_service.matching.run import MatchScope, match_open_predictions
from prediction_service.matching.trends import DEFAULT_CANDIDATE_LIMIT, FixtureTrendReader

FIXTURES = Path(__file__).parent / "fixtures"
DEFAULT_PREDICTIONS = FIXTURES / "open_predictions.sample.json"
DEFAULT_TRENDS = FIXTURES / "trends.sample.json"
DEFAULT_REPLY = FIXTURES / "match_reply.sample.json"

#: Measured context for the fixture trend, so the offline loop shows a
#: populated EVIDENCE.trend_context rather than a null one. Values are
#: plausible readings, not live ones.
FIXTURE_CONTEXTS: dict[str, dict[str, object]] = {
    "3956205c-8896-4184-9e2c-f4b70f8e9b9c": {
        "TREND_ID": "3956205c-8896-4184-9e2c-f4b70f8e9b9c",
        "TREND_TOPIC": "Rucking as everyday exercise — weighted vests worn on ordinary walks",
        "LIFECYCLE_STATUS": "GROWING",
        "HEAT_INDEX": 46.0,
        "HEAT_7D_AGO": 41.0,
        "HEAT_14D_AGO": 39.0,
        "ACCELERATION": 3.0,
        "LINKED_SIGNALS_TOTAL": 11,
        "LINKED_SIGNALS_ADDED_7D": 4,
        "DISTINCT_SOURCES_TOTAL": 5,
        "DISTINCT_SOURCES_ADDED_7D": 2,
        "AGE_DAYS": 31,
    }
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fixture-driven prediction matching.")
    parser.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS)
    parser.add_argument("--trends", type=Path, default=DEFAULT_TRENDS)
    parser.add_argument("--reply", type=Path, default=DEFAULT_REPLY)
    parser.add_argument("--live-llm", action="store_true")
    parser.add_argument("--model", default=None, help=f"default: {DEFAULT_MODEL}")
    parser.add_argument("--print-prompt", action="store_true")
    parser.add_argument("--min-similarity", type=float, default=DEFAULT_MIN_SIMILARITY)
    parser.add_argument("--prediction-limit", type=int, default=50)
    parser.add_argument("--candidate-limit", type=int, default=DEFAULT_CANDIDATE_LIMIT)
    return parser


def build_llm(args: argparse.Namespace) -> PredictionLLM:
    if args.live_llm:
        key = os.environ.get("PREDICTION_GEMINI_API_KEY", "")
        if not key.strip():
            raise SystemExit("--live-llm needs PREDICTION_GEMINI_API_KEY in the environment")
        model = args.model or os.environ.get("PREDICTION_GEMINI_MODEL") or DEFAULT_MODEL
        return GeminiPredictionLLM(key, model=model)
    return ReplayLLM(args.reply.read_text(), model=f"replay:{args.reply.name}")


def run(argv: list[str] | None = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)

    predictions = StaticOpenPredictionReader(json.loads(args.predictions.read_text()))
    trends = FixtureTrendReader(json.loads(args.trends.read_text()), contexts=FIXTURE_CONTEXTS)
    scope = MatchScope(
        prediction_limit=args.prediction_limit,
        candidate_limit=args.candidate_limit,
        min_similarity=args.min_similarity,
    )

    result = match_open_predictions(
        predictions=predictions, trends=trends, llm=build_llm(args), scope=scope
    )

    print(f"chain_id              {result.chain_id}", file=out)
    print(f"model                 {result.model or '(no narrative call)'}", file=out)
    print(f"predictions           {result.predictions_considered}", file=out)
    print(f"trends indexed        {result.trends_indexed}", file=out)
    print(f"matched               {len(result.matched)}", file=out)
    print(f"white space           {len(result.white_space)}", file=out)
    print(f"min similarity        {scope.min_similarity}", file=out)
    print(f"cost (usd)            {result.cost_usd}", file=out)

    for outcome in result.outcomes:
        verdict = outcome.verdict
        print("", file=out)
        print(f"  PREDICTION_ID      {verdict.prediction_id}", file=out)
        print(f"  SUBJECT_DESCRIPTOR {outcome.subject_descriptor}", file=out)
        print(f"  MATCHED_TREND_ID   {verdict.matched_trend_id or 'NULL (white space)'}", file=out)
        print(f"  MATCH_METHOD       {outcome.decision.method or 'none'}", file=out)
        similarity = outcome.decision.trend.similarity if outcome.decision.trend else None
        print(f"  SIMILARITY         {similarity}", file=out)
        print(f"  HORIZON_AT         {verdict.horizon_at.isoformat()}", file=out)
        print(f"  CONFIDENCE         {verdict.confidence}", file=out)
        print(f"  TREND_CONTEXT      {verdict.evidence['trend_context']}", file=out)
        print(f"  REASONING          {verdict.reasoning[:300]}", file=out)
        if outcome.note:
            print(f"  NOTE               {outcome.note}", file=out)

    if args.print_prompt:
        from prediction_service.matching.narrative import build_system_prompt, build_user_prompt

        print("\n===== SYSTEM =====", file=out)
        print(build_system_prompt(), file=out)
        for outcome in result.matched:
            trend = outcome.decision.trend
            print(f"\n===== USER ({outcome.subject_descriptor}) =====", file=out)
            print(
                build_user_prompt(
                    subject_descriptor=outcome.verdict.claim.subject_descriptor,
                    directional_claim=outcome.verdict.claim.directional_claim,
                    horizon_band=outcome.verdict.claim.horizon_band,
                    observable_check=outcome.verdict.claim.observable_check,
                    confidence=outcome.verdict.confidence,
                    prior_reasoning="",
                    trend_topic=trend.trend_topic if trend else None,
                    descriptor_query=trend.descriptor_query if trend else None,
                    descriptor_statement=trend.descriptor_statement if trend else None,
                    match_method=outcome.decision.method,
                    similarity=trend.similarity if trend else None,
                    context=outcome.context.as_evidence() if outcome.context else None,
                ),
                file=out,
            )

    print("\n(nothing was written -- POST /match appends these to the ledger)", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
