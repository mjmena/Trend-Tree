"""The local loop for the re-evaluation sweep: run the real sweep against
fixtures, no deploy (CRMA-766).

    cd services/prediction
    uv run --python 3.12 python local_sweep.py

Offline by default -- the live predictions come from
``fixtures/sweep_predictions.sample.json``, the trends from
``fixtures/trends.sample.json``, and the re-evaluation turn is replayed from
``fixtures/sweep_reply.sample.json``, so the run costs nothing, needs no key
and needs no warehouse. It exercises the same ``sweep_predictions`` the
deployed route calls, through the same reader interfaces.

``--now`` is the whole point of the offline loop here. The status machine is
a function of the moment being evaluated, and the fixture is built so that
the default moment puts one prediction before its horizon, one past its
horizon but inside the grace window, one at the close of its grace window
(the single final row), and one already frozen -- so a single run shows every
state a live call can be in, including the freeze. Move ``--now`` and watch
them cross.

    --live-llm       call Gemini for real (PREDICTION_GEMINI_API_KEY required)
    --model NAME     which model --live-llm calls
    --print-prompt   dump the re-evaluation prompt this run would send
    --now ISO8601    the moment to evaluate at (default: the fixture's own)
    --predictions PATH / --trends PATH / --reply PATH
    --prediction-id ID   capped-scope mode; repeatable
    --min-similarity F / --prediction-limit N / --candidate-limit N

This never writes to Snowflake in any mode. It prints the verdict rows the
deployed run would append; landing them is POST /sweep's job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

# A sibling script rather than a package import: the fixture trend's
# measured context, shared with the compare step's loop so the two offline
# runs describe the same trend the same way.
from local_match import FIXTURE_CONTEXTS
from prediction_service.generation.llm import (
    DEFAULT_MODEL,
    GeminiPredictionLLM,
    PredictionLLM,
    ReplayLLM,
)
from prediction_service.matching.decide import DEFAULT_MIN_SIMILARITY
from prediction_service.matching.predictions import (
    LIVE_STATUSES,
    StaticOpenPredictionReader,
)
from prediction_service.matching.trends import DEFAULT_CANDIDATE_LIMIT, FixtureTrendReader
from prediction_service.sweep import SweepScope, sweep_predictions

FIXTURES = Path(__file__).parent / "fixtures"
DEFAULT_PREDICTIONS = FIXTURES / "sweep_predictions.sample.json"
DEFAULT_TRENDS = FIXTURES / "trends.sample.json"
DEFAULT_REPLY = FIXTURES / "sweep_reply.sample.json"

#: The moment the shipped fixture is written around: one prediction before
#: its horizon, one inside its grace window, one at the close of its window
#: and one already frozen past it. A fixed default so
#: the loop's output is the same next month as it is today -- a fixture whose
#: meaning depends on the wall clock stops demonstrating anything.
DEFAULT_NOW = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fixture-driven prediction re-evaluation sweep.")
    parser.add_argument("--predictions", type=Path, default=DEFAULT_PREDICTIONS)
    parser.add_argument("--trends", type=Path, default=DEFAULT_TRENDS)
    parser.add_argument("--reply", type=Path, default=DEFAULT_REPLY)
    parser.add_argument("--live-llm", action="store_true")
    parser.add_argument("--model", default=None, help=f"default: {DEFAULT_MODEL}")
    parser.add_argument("--print-prompt", action="store_true")
    parser.add_argument(
        "--now",
        default=None,
        help=f"ISO-8601 moment to evaluate at (default: {DEFAULT_NOW.isoformat()})",
    )
    parser.add_argument(
        "--prediction-id",
        action="append",
        default=[],
        dest="prediction_ids",
        help="capped-scope mode: re-evaluate only this PREDICTION_ID; repeatable",
    )
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


def parse_now(raw: str | None) -> datetime:
    if not raw:
        return DEFAULT_NOW
    moment = datetime.fromisoformat(raw)
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def run(argv: list[str] | None = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    now = parse_now(args.now)

    predictions = StaticOpenPredictionReader(
        json.loads(args.predictions.read_text()), statuses=LIVE_STATUSES
    )
    trends = FixtureTrendReader(json.loads(args.trends.read_text()), contexts=FIXTURE_CONTEXTS)
    scope = SweepScope(
        prediction_limit=args.prediction_limit,
        candidate_limit=args.candidate_limit,
        min_similarity=args.min_similarity,
        prediction_ids=tuple(args.prediction_ids),
    )

    result = sweep_predictions(
        predictions=predictions,
        trends=trends,
        llm=build_llm(args),
        # No saturation phase offline: the sweep leaves EVIDENCE.saturation
        # exactly as the prior row left it rather than overwriting a real
        # reading with a "we did not look" miss.
        saturation=None,
        scope=scope,
        now=now,
    )

    print(f"chain_id              {result.chain_id}", file=out)
    print(f"evaluated at          {now.isoformat()}", file=out)
    print(f"model                 {result.model or '(no re-evaluation call)'}", file=out)
    print(f"predictions read      {result.predictions_read}", file=out)
    print(f"re-evaluated          {len(result.outcomes)}", file=out)
    print(f"resolved              {len(result.resolved)}", file=out)
    print(f"expired               {len(result.expired)}", file=out)
    print(f"skipped               {len(result.skipped)}", file=out)
    print(f"trends indexed        {result.trends_indexed}", file=out)
    print(f"cost (usd)            {result.cost_usd}", file=out)

    for outcome in result.outcomes:
        verdict = outcome.verdict
        print("", file=out)
        print(f"  PREDICTION_ID      {verdict.prediction_id}", file=out)
        print(f"  SUBJECT_DESCRIPTOR {outcome.subject_descriptor}", file=out)
        print(f"  STATUS             {outcome.prior_status} -> {verdict.status}", file=out)
        print(f"  FINAL EVALUATION   {outcome.final}", file=out)
        print(f"  HORIZON_AT         {verdict.horizon_at.isoformat()} (frozen)", file=out)
        print(f"  GRACE ENDS AT      {outcome.status.grace_ends_at.isoformat()}", file=out)
        print(f"  OBSERVABLE CHECK   {outcome.observation.outcome}", file=out)
        print(
            f"  CONFIDENCE         {outcome.prior_confidence} -> {verdict.confidence} "
            f"({outcome.confidence_direction}, delta {outcome.confidence_delta})",
            file=out,
        )
        print(f"  MATCHED_TREND_ID   {verdict.matched_trend_id or 'NULL (white space)'}", file=out)
        print(f"  WHAT_CHANGED       {verdict.what_changed}", file=out)
        if outcome.note:
            print(f"  NOTE               {outcome.note}", file=out)

    for skipped in result.skipped:
        print("", file=out)
        print(
            f"  SKIPPED            {skipped.prediction_id} "
            f"({skipped.subject_descriptor})",
            file=out,
        )
        print(f"    reason           {skipped.reason}", file=out)

    if args.print_prompt:
        from prediction_service.sweep.prompt import build_system_prompt

        print("\n===== SYSTEM =====", file=out)
        print(build_system_prompt(), file=out)

    print(
        "\n(nothing was written -- POST /sweep appends these to the ledger)",
        file=out,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
