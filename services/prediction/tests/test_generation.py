"""The generation pass itself: corpus in, minted ACTIVE verdicts out
(CRMA-763, AC1/AC3/AC4).

Driven through ``generate_predictions`` with a fixture reader and a fake LLM
-- no warehouse, no network, no key. The verdict rows asserted here are the
same objects routes/generate.py hands to the ledger MERGE, so what lands in
FCT_PREDICTION_VERDICT_LEDGER is exactly what these tests pin.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS, derive_horizon_at
from prediction_service.generation.run import (
    GenerationScope,
    eval_id_for,
    generate_predictions,
    new_chain_id,
)
from prediction_service.generation.signals import FixtureSignalReader

from .fakes import FakePredictionLLM

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SIGNAL_ROWS = json.loads((FIXTURES / "signals.sample.json").read_text())
MODEL_REPLY = (FIXTURES / "generation_reply.sample.json").read_text()

MINTED_AT = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)


def _run(reply: str = MODEL_REPLY, *, rows=None, **scope_kwargs):
    reader = FixtureSignalReader(SIGNAL_ROWS if rows is None else rows)
    llm = FakePredictionLLM(reply=reply)
    result = generate_predictions(
        reader=reader,
        llm=llm,
        scope=GenerationScope(**scope_kwargs) if scope_kwargs else None,
        chain_id="pred-verdict-chain-test1234",
        minted_at=MINTED_AT,
    )
    return result, llm


# --- AC1: a capped run produces coherent, complete claims -----------------


def test_a_capped_run_produces_active_verdicts_with_all_four_claim_parts():
    result, _ = _run(max_predictions=5, lookback_hours=168, signal_limit=200)

    assert len(result.verdicts) >= 1
    for verdict in result.verdicts:
        assert verdict.status == "ACTIVE"
        assert verdict.claim.subject_descriptor.strip()
        assert verdict.claim.directional_claim.strip()
        assert verdict.claim.observable_check.strip()
        assert verdict.claim.horizon_band
        assert verdict.reasoning.strip()


def test_the_claim_reads_as_one_falsifiable_sentence():
    # The dashboard composes exactly these four parts into the rendered claim
    # sentence; if any of them is a fragment the surface is unreadable.
    result, _ = _run()
    claim = result.verdicts[0].claim

    sentence = (
        f"{claim.subject_descriptor}: {claim.directional_claim} "
        f"(by {claim.horizon_band}) -- checked by {claim.observable_check}"
    )
    assert "rucking vests" in sentence
    assert "mainstream retail adoption expands" in sentence
    assert "major-retailer catalogs" in sentence


def test_the_run_cap_bounds_how_many_verdicts_are_minted():
    result, _ = _run(max_predictions=1)

    assert len(result.verdicts) == 1


def test_the_corpus_cap_bounds_what_the_prompt_shows_the_model():
    result, llm = _run(signal_limit=3)

    assert result.signals_considered == 3
    assert "3 signal(s)" in llm.last_user_prompt


# --- AC2: no claim, no prediction ------------------------------------------


def test_the_fixture_reply_s_claimless_topic_never_becomes_a_verdict():
    # The sample reply deliberately contains "targeted supplement stacking"
    # at confidence 71 with no directional claim -- the strategy doc's own
    # example of a topic that must not be emitted.
    result, _ = _run()

    subjects = [v.claim.subject_descriptor for v in result.verdicts]
    assert "targeted supplement stacking" not in subjects
    assert any("no directional_claim" in r.reason for r in result.rejected)


def test_a_run_whose_proposals_all_fail_mints_nothing_and_says_why():
    reply = json.dumps(
        {
            "predictions": [
                {
                    "subject_descriptor": "wellness",
                    "directional_claim": "",
                    "horizon_band": "emerging_3_6mo",
                    "observable_check": "",
                    "confidence": 95,
                    "reasoning": "feels big",
                    "source_signals": ["gdelt:20260807:supplement-stack-coverage"],
                }
            ]
        }
    )

    result, _ = _run(reply)

    assert result.verdicts == []
    assert len(result.rejected) == 1


# --- AC3: HORIZON_AT derives from a controlled band ------------------------


def test_horizon_at_derives_from_the_band_at_mint():
    result, _ = _run()

    for verdict in result.verdicts:
        assert verdict.minted_at == MINTED_AT
        assert verdict.horizon_at == derive_horizon_at(verdict.claim.horizon_band, MINTED_AT)


@pytest.mark.parametrize(
    ("band", "days"),
    [
        ("near_term_1_3mo", 90),
        ("emerging_3_6mo", 180),
        ("cultural_shift_6_12mo", 365),
        ("longer_range_12_24mo", 730),
    ],
)
def test_each_band_resolves_to_its_window_upper_bound(band, days):
    reply = json.dumps(
        {
            "predictions": [
                {
                    "subject_descriptor": "rucking vests",
                    "directional_claim": "mainstream retail adoption expands",
                    "horizon_band": band,
                    "observable_check": "major-retailer listings",
                    "confidence": 60,
                    "reasoning": "convergent evidence across sources",
                    "source_signals": ["bluesky:3lqz7a2xk4d2m"],
                }
            ]
        }
    )

    result, _ = _run(reply)

    assert (result.verdicts[0].horizon_at - MINTED_AT).days == days


# --- AC4: evidence and reasoning -------------------------------------------


def test_evidence_carries_the_signal_ids_behind_the_call():
    result, _ = _run()
    evidence = result.verdicts[0].evidence

    assert evidence["source_signals"] == [
        "bluesky:3lqz7a2xk4d2m",
        "amazon_trends:sports-outdoors:weighted-vest:2026-08-12",
        "google_trends_explore:rucking-vest:2026-08-11",
        "pinterest:trend:weighted-walk:2026-08-09",
    ]


def test_every_cited_id_exists_in_the_corpus_the_run_read():
    corpus = {row["SIGNAL_ID"] for row in SIGNAL_ROWS}
    result, _ = _run()

    for verdict in result.verdicts:
        assert set(verdict.evidence["source_signals"]) <= corpus


def test_evidence_carries_all_four_contracted_keys():
    result, _ = _run()

    for verdict in result.verdicts:
        for key in REQUIRED_EVIDENCE_KEYS:
            assert key in verdict.evidence


def test_the_keys_later_phases_own_are_present_and_null():
    # Their presence is the contract; saturation is CRMA-765 and coverage is
    # the coverage detector. trend_context is null for a third reason too --
    # generation could not have read heat or lifecycle to fill it in.
    result, _ = _run()
    evidence = result.verdicts[0].evidence

    assert evidence["saturation"] is None
    assert evidence["coverage"] is None
    assert evidence["trend_context"] is None


def test_evidence_records_which_emergence_path_the_agent_used():
    result, _ = _run()

    paths = {v.evidence["generation"]["emergence_path"] for v in result.verdicts}
    assert paths == {"signal convergence", "structural-enabling change"}


def test_reasoning_is_populated_on_every_verdict():
    result, _ = _run()

    for verdict in result.verdicts:
        assert len(verdict.reasoning) > 40


# --- generation-phase invariants -------------------------------------------


def test_every_generated_prediction_is_white_space_until_matching_exists():
    # Matching is CRMA-764. Until it lands, MATCHED_TREND_ID is NULL by
    # construction -- generation never saw a trend to match against.
    result, _ = _run()

    assert all(v.matched_trend_id is None for v in result.verdicts)


def test_a_first_mint_has_no_what_changed():
    result, _ = _run()

    assert all(v.what_changed is None for v in result.verdicts)


def test_every_row_of_a_run_shares_the_chain_id():
    result, _ = _run()

    assert {v.chain_id for v in result.verdicts} == {"pred-verdict-chain-test1234"}


def test_each_prediction_gets_its_own_prediction_id():
    result, _ = _run()

    ids = [v.prediction_id for v in result.verdicts]
    assert len(set(ids)) == len(ids)


def test_eval_ids_are_derived_from_the_chain_id_so_a_re_fire_is_idempotent():
    # Re-firing the same chain_id MERGEs into the rows the first attempt
    # wrote rather than appending a second copy of the run.
    result, _ = _run()

    assert [v.prediction_eval_id for v in result.verdicts] == [
        eval_id_for("pred-verdict-chain-test1234", 0),
        eval_id_for("pred-verdict-chain-test1234", 1),
    ]


def test_a_chain_id_is_minted_in_the_documented_shape_when_none_is_given():
    assert new_chain_id().startswith("pred-verdict-chain-")


def test_the_run_reports_the_model_and_its_token_usage():
    result, _ = _run()

    assert result.model == "fake-model"
    assert result.input_tokens == 1200
    assert result.output_tokens == 300
    assert result.cost_usd > 0


def test_an_empty_corpus_still_runs_and_mints_nothing():
    result, llm = _run('{"predictions": []}', rows=[])

    assert result.signals_considered == 0
    assert result.verdicts == []
    assert "corpus slice for this run is empty" in llm.last_user_prompt


@pytest.mark.parametrize(
    "kwargs",
    [
        {"lookback_hours": 0},
        {"signal_limit": 0},
        {"max_predictions": 0},
    ],
)
def test_a_nonsense_scope_is_refused_rather_than_producing_an_empty_run(kwargs):
    with pytest.raises(ValueError, match="at least 1"):
        GenerationScope(**kwargs)
