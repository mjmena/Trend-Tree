"""The local loop: run the real generation phase against fixtures, no deploy.

    cd services/prediction
    uv run --python 3.12 python local_generate.py

Offline by default -- the corpus comes from ``fixtures/signals.sample.json``
and the model reply is replayed from ``fixtures/generation_reply.sample.json``,
so the run costs nothing, needs no key and needs no warehouse. It exercises
the same ``generate_predictions`` the deployed route calls, through the same
``SignalReader`` interface, so prompt and parser changes are visible here
before any commit-to-deploy round trip (PRD: "generation quality iterates
through the local loop").

    --live-llm       call Gemini for real (PREDICTION_GEMINI_API_KEY required)
    --print-prompt   dump the exact system + user prompt this run would send
    --signals PATH   a different corpus fixture
    --reply PATH     a different recorded reply (ignored with --live-llm)
    --max-predictions N / --signal-limit N

This never writes to Snowflake in any mode. It prints the verdict rows the
deployed run would append; landing them is POST /generate's job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from prediction_service.generation.llm import GeminiPredictionLLM, PredictionLLM, ReplayLLM
from prediction_service.generation.run import (
    GenerationScope,
    generate_predictions,
)
from prediction_service.generation.signals import FixtureSignalReader

FIXTURES = Path(__file__).parent / "fixtures"
DEFAULT_SIGNALS = FIXTURES / "signals.sample.json"
DEFAULT_REPLY = FIXTURES / "generation_reply.sample.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fixture-driven prediction generation.")
    parser.add_argument("--signals", type=Path, default=DEFAULT_SIGNALS)
    parser.add_argument("--reply", type=Path, default=DEFAULT_REPLY)
    parser.add_argument("--live-llm", action="store_true")
    parser.add_argument("--print-prompt", action="store_true")
    parser.add_argument("--signal-limit", type=int, default=200)
    parser.add_argument("--lookback-hours", type=int, default=168)
    parser.add_argument("--max-predictions", type=int, default=5)
    return parser


def build_llm(args: argparse.Namespace) -> PredictionLLM:
    if args.live_llm:
        key = os.environ.get("PREDICTION_GEMINI_API_KEY", "")
        if not key.strip():
            raise SystemExit("--live-llm needs PREDICTION_GEMINI_API_KEY in the environment")
        return GeminiPredictionLLM(
            key, model=os.environ.get("PREDICTION_GEMINI_MODEL", "gemini-3.1-pro-preview")
        )
    return ReplayLLM(args.reply.read_text(), model=f"replay:{args.reply.name}")


def run(argv: list[str] | None = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)

    reader = FixtureSignalReader(json.loads(args.signals.read_text()))
    scope = GenerationScope(
        lookback_hours=args.lookback_hours,
        signal_limit=args.signal_limit,
        max_predictions=args.max_predictions,
    )

    if args.print_prompt:
        # Rebuilt from the same pure builders the run uses -- no side effects,
        # so dumping the prompt cannot change what the run sends.
        from prediction_service.generation.prompt import build_system_prompt, build_user_prompt

        signals = reader.recent_signals(
            lookback_hours=scope.lookback_hours, limit=scope.signal_limit
        )
        print("===== SYSTEM =====", file=out)
        print(build_system_prompt(), file=out)
        print("\n===== USER =====", file=out)
        print(build_user_prompt(signals, max_predictions=scope.max_predictions), file=out)
        print("", file=out)

    result = generate_predictions(reader=reader, llm=build_llm(args), scope=scope)

    print(f"chain_id            {result.chain_id}", file=out)
    print(f"model               {result.model}", file=out)
    print(f"signals considered  {result.signals_considered}", file=out)
    print(f"predictions         {len(result.verdicts)}", file=out)
    print(f"rejected            {len(result.rejected)}", file=out)
    print(f"cost (usd)          {result.cost_usd}", file=out)

    for verdict in result.verdicts:
        print("", file=out)
        print(f"  PREDICTION_ID      {verdict.prediction_id}", file=out)
        print(f"  SUBJECT_DESCRIPTOR {verdict.claim.subject_descriptor}", file=out)
        print(f"  DIRECTIONAL_CLAIM  {verdict.claim.directional_claim}", file=out)
        print(
            f"  HORIZON            {verdict.claim.horizon_band} "
            f"-> {verdict.horizon_at.isoformat()}",
            file=out,
        )
        print(f"  OBSERVABLE_CHECK   {verdict.claim.observable_check}", file=out)
        print(f"  CONFIDENCE         {verdict.confidence}", file=out)
        print(f"  STATUS             {verdict.status}", file=out)
        print(f"  SOURCE_SIGNALS     {verdict.evidence['source_signals']}", file=out)

    for rejection in result.rejected:
        print(f"\n  DROPPED {rejection.subject!r}: {rejection.reason}", file=out)

    print("\n(nothing was written -- POST /generate appends these to the ledger)", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
