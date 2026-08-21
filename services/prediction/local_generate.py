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
    --model NAME     which model --live-llm calls; defaults to
                     PREDICTION_GEMINI_MODEL, then llm.DEFAULT_MODEL. This is
                     how an A/B between models is run without a code edit --
                     `--live-llm --model gemini-3.1-pro-preview` against a
                     plain `--live-llm` is the whole comparison. Ignored in
                     replay mode, where the reply is already recorded.
    --print-prompt   dump the exact system + user prompt this run would send
    --signals PATH   a different corpus fixture
    --reply PATH     a different recorded reply (ignored with --live-llm)
    --live-subject S a subject already carrying an ACTIVE prediction; repeatable.
                     The deployed run reads these from the verdict ledger, so this
                     is how the offline loop exercises the same de-duplication.
    --saturation PATH  recorded Exploding Topics / GDELT readings per subject.
                     The deployed run calls both providers; this is the offline
                     stand-in, so the data-quality floor and the saturation
                     weighing pass (CRMA-765) run here exactly as they do live.
                     A subject the file omits is an explicit ET miss, which is
                     the normal path and costs nothing.
    --weighing-reply PATH  the recorded reply to the weighing turn (ignored with
                     --live-llm, where the real model answers both turns).
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

from prediction_service.generation.llm import (
    DEFAULT_MODEL,
    GeminiPredictionLLM,
    PredictionLLM,
    ReplayLLM,
)
from prediction_service.generation.run import (
    GenerationScope,
    generate_predictions,
)
from prediction_service.generation.signals import FixtureSignalReader, StaticLiveSubjectReader
from prediction_service.saturation import (
    DataQualityFloor,
    SaturationPhase,
    load_saturation_fixture,
)

FIXTURES = Path(__file__).parent / "fixtures"
DEFAULT_SIGNALS = FIXTURES / "signals.sample.json"
DEFAULT_REPLY = FIXTURES / "generation_reply.sample.json"
DEFAULT_SATURATION = FIXTURES / "saturation.sample.json"
DEFAULT_WEIGHING_REPLY = FIXTURES / "weighing_reply.sample.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fixture-driven prediction generation.")
    parser.add_argument("--signals", type=Path, default=DEFAULT_SIGNALS)
    parser.add_argument("--reply", type=Path, default=DEFAULT_REPLY)
    parser.add_argument("--live-llm", action="store_true")
    # Default resolved in build_llm, not here, so `--model` overrides the env
    # var and the env var overrides the built-in -- and so `-h` does not print
    # whatever happens to be exported in this shell as if it were the default.
    parser.add_argument("--model", default=None, help=f"default: {DEFAULT_MODEL}")
    parser.add_argument("--print-prompt", action="store_true")
    parser.add_argument("--signal-limit", type=int, default=200)
    parser.add_argument("--lookback-hours", type=int, default=168)
    parser.add_argument("--max-predictions", type=int, default=5)
    parser.add_argument("--live-subject", action="append", default=[])
    parser.add_argument("--saturation", type=Path, default=DEFAULT_SATURATION)
    parser.add_argument("--weighing-reply", type=Path, default=DEFAULT_WEIGHING_REPLY)
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

    reader = FixtureSignalReader(json.loads(args.signals.read_text()))
    scope = GenerationScope(
        lookback_hours=args.lookback_hours,
        signal_limit=args.signal_limit,
        max_predictions=args.max_predictions,
    )

    live = StaticLiveSubjectReader(args.live_subject)

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
        print(
            build_user_prompt(
                signals,
                max_predictions=scope.max_predictions,
                live_subjects=live.live_subjects(),
            ),
            file=out,
        )
        print("", file=out)

    llm = build_llm(args)
    result = generate_predictions(reader=reader, llm=llm, live_subjects=live, scope=scope)

    # Saturation as evidence, plus the data-quality floor (CRMA-765). The same
    # phase the deployed route runs, against recorded readings instead of the
    # two providers -- so a subject skipped by the floor, a `peaked`
    # classification and an Exploding Topics miss are all visible here without
    # a deploy or a network call.
    oracle, breadth = load_saturation_fixture(json.loads(args.saturation.read_text()))
    phase = SaturationPhase(oracle=oracle, breadth=breadth, floor=DataQualityFloor())
    # In replay mode the weighing turn gets its own recorded reply: it is a
    # different question, and a fake that answered the generation reply to
    # both would only ever exercise the degraded path.
    weighing_llm = llm if args.live_llm else ReplayLLM(
        args.weighing_reply.read_text(), model=f"replay:{args.weighing_reply.name}"
    )
    result = phase.weigh(result, llm=weighing_llm)

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
        saturation = verdict.evidence.get("saturation") or {}
        et = saturation.get("exploding_topics") or {}
        gdelt = saturation.get("gdelt") or {}
        weighing = saturation.get("weighing") or {}
        print(
            "  ET                 "
            + (
                f"{et.get('classification')} ({et.get('matched_keyword')!r}, "
                f"vol {et.get('absolute_volume')})"
                if et.get("matched")
                else f"MISS [{et.get('miss_reason')}] -- no penalty"
            ),
            file=out,
        )
        print(
            "  GDELT BREADTH      "
            + (
                f"{gdelt.get('article_count')} article(s) / "
                f"{gdelt.get('distinct_domains')} publisher(s) in "
                f"{gdelt.get('window_days')}d"
                if gdelt.get("available")
                else f"unavailable [{gdelt.get('error')}]"
            ),
            file=out,
        )
        print(
            f"  SATURATION WEIGHED {weighing.get('weighed')} "
            f"({weighing.get('confidence_before')} -> {weighing.get('confidence_after')})",
            file=out,
        )

    for rejection in result.rejected:
        print(f"\n  DROPPED {rejection.subject!r}: {rejection.reason}", file=out)

    print("\n(nothing was written -- POST /generate appends these to the ledger)", file=out)
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
