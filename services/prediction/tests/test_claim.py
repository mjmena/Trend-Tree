"""Unit tests for the claim/verdict domain logic (CRMA-762 AC1/AC2's
fail-fast layer -- the ledger's NOT NULL columns are the real enforcement,
verified live against Snowflake; this is what gives a caller an actionable
400 before a warehouse round-trip)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from prediction_service.domain.claim import (
    REQUIRED_EVIDENCE_KEYS,
    Claim,
    InvalidClaim,
    build_verdict,
    derive_horizon_at,
)

_VALID_EVIDENCE = {
    "source_signals": [],
    "saturation": None,
    "trend_context": None,
    "coverage": None,
    "strategist": None,
}


def _claim(**overrides: object) -> Claim:
    fields: dict[str, object] = {
        "subject_descriptor": "rucking vests",
        "directional_claim": "mainstream retail adoption expands",
        "horizon_band": "emerging_3_6mo",
        "observable_check": "major-retailer listings",
    }
    fields.update(overrides)
    return Claim(**fields)  # type: ignore[arg-type]


@pytest.mark.parametrize("field", ["subject_descriptor", "directional_claim", "observable_check"])
def test_claim_rejects_blank_required_field(field):
    with pytest.raises(InvalidClaim, match="must be non-empty"):
        _claim(**{field: "   "})


def test_claim_rejects_unknown_horizon_band():
    with pytest.raises(InvalidClaim, match="unknown horizon_band"):
        _claim(horizon_band="next_tuesday")


@pytest.mark.parametrize(
    "band,days",
    [
        ("near_term_1_3mo", 90),
        ("emerging_3_6mo", 180),
        ("cultural_shift_6_12mo", 365),
        ("longer_range_12_24mo", 730),
    ],
)
def test_derive_horizon_at_uses_band_upper_bound(band, days):
    minted = datetime(2026, 1, 1, tzinfo=UTC)
    assert derive_horizon_at(band, minted) == minted + timedelta(days=days)


def test_build_verdict_requires_all_evidence_keys():
    with pytest.raises(InvalidClaim, match="evidence missing required keys"):
        build_verdict(
            _claim(),
            confidence=50,
            reasoning="test",
            evidence={"source_signals": []},
        )


def test_build_verdict_accepts_evidence_with_null_values_for_present_keys():
    # White-space predictions carry NULL trend_context -- key *presence* is
    # the contract, not the value (strategy doc §6).
    verdict = build_verdict(
        _claim(), confidence=50, reasoning="test", evidence=dict(_VALID_EVIDENCE)
    )
    assert set(verdict.evidence) == set(REQUIRED_EVIDENCE_KEYS)


@pytest.mark.parametrize("confidence", [-1, 100.1, 500])
def test_build_verdict_rejects_out_of_range_confidence(confidence):
    with pytest.raises(InvalidClaim, match="confidence must be in"):
        build_verdict(
            _claim(), confidence=confidence, reasoning="test", evidence=dict(_VALID_EVIDENCE)
        )


def test_build_verdict_rejects_unknown_status():
    with pytest.raises(InvalidClaim, match="unknown status"):
        build_verdict(
            _claim(),
            confidence=50,
            reasoning="test",
            evidence=dict(_VALID_EVIDENCE),
            status="MAYBE",
        )


def test_build_verdict_rejects_blank_reasoning():
    with pytest.raises(InvalidClaim, match="reasoning must be non-empty"):
        build_verdict(_claim(), confidence=50, reasoning="  ", evidence=dict(_VALID_EVIDENCE))


def test_build_verdict_mints_a_prediction_id_and_defaults_to_active():
    verdict = build_verdict(
        _claim(), confidence=40, reasoning="test", evidence=dict(_VALID_EVIDENCE)
    )
    assert verdict.prediction_id
    assert verdict.status == "ACTIVE"
    assert verdict.matched_trend_id is None
    assert verdict.horizon_at > verdict.minted_at


def test_build_verdict_is_deterministic_given_explicit_ids_and_time():
    minted = datetime(2026, 1, 1, tzinfo=UTC)
    verdict = build_verdict(
        _claim(),
        confidence=40,
        reasoning="test",
        evidence=dict(_VALID_EVIDENCE),
        prediction_id="fixed-id",
        minted_at=minted,
    )
    assert verdict.prediction_id == "fixed-id"
    assert verdict.minted_at == minted
    assert verdict.horizon_at == minted + timedelta(days=180)


@pytest.mark.parametrize(
    "field,limit",
    [
        ("subject_descriptor", 256),
        ("directional_claim", 1024),
        ("observable_check", 1024),
    ],
)
def test_claim_rejects_a_field_wider_than_its_ledger_column(field, limit):
    # sql/fct_prediction_verdict_ledger.sql's VARCHAR widths. Without this the
    # overflow surfaces as a Snowflake error after a warehouse round-trip --
    # a 500 for what is really a bad request.
    _claim(**{field: "x" * limit})  # exactly at the limit is fine
    with pytest.raises(InvalidClaim, match="exceeds its column width"):
        _claim(**{field: "x" * (limit + 1)})


def test_build_verdict_rejects_over_long_reasoning_and_what_changed():
    with pytest.raises(InvalidClaim, match="exceeds its column width"):
        build_verdict(
            _claim(), confidence=50, reasoning="x" * 4001, evidence=dict(_VALID_EVIDENCE)
        )
    with pytest.raises(InvalidClaim, match="exceeds its column width"):
        build_verdict(
            _claim(),
            confidence=50,
            reasoning="ok",
            evidence=dict(_VALID_EVIDENCE),
            what_changed="x" * 4001,
        )


def test_build_verdict_mints_a_distinct_row_id_per_call():
    # PREDICTION_EVAL_ID is the row's identity and must not collide across
    # evaluations of the same prediction; PREDICTION_ID is what stays stable.
    first = build_verdict(
        _claim(),
        confidence=40,
        reasoning="test",
        evidence=dict(_VALID_EVIDENCE),
        prediction_id="stable",
    )
    second = build_verdict(
        _claim(),
        confidence=40,
        reasoning="test",
        evidence=dict(_VALID_EVIDENCE),
        prediction_id="stable",
    )

    assert first.prediction_id == second.prediction_id == "stable"
    assert first.prediction_eval_id != second.prediction_eval_id


def test_build_verdict_accepts_an_explicit_eval_id_and_chain_id():
    verdict = build_verdict(
        _claim(),
        confidence=40,
        reasoning="test",
        evidence=dict(_VALID_EVIDENCE),
        prediction_eval_id="fixed-eval-id",
        chain_id="pred-verdict-chain-abcd1234",
    )
    assert verdict.prediction_eval_id == "fixed-eval-id"
    assert verdict.chain_id == "pred-verdict-chain-abcd1234"


# --- control and bidi characters (review finding 14) -----------------------


def _claim(**overrides):
    base = {
        "subject_descriptor": "rucking vests",
        "directional_claim": "mainstream retail adoption expands",
        "horizon_band": "emerging_3_6mo",
        "observable_check": "Target lists a house-label weighted vest under 20 lb",
    }
    base.update(overrides)
    return Claim(**base)


@pytest.mark.parametrize(
    "field",
    ["subject_descriptor", "directional_claim", "observable_check"],
)
@pytest.mark.parametrize(
    ("label", "char"),
    [
        ("NUL", "\x00"),
        ("bell", "\x07"),
        ("newline", "\n"),
        ("RLO", "‮"),
        ("LRO", "‭"),
        ("RLI", "⁧"),
        ("ALM", "؜"),
    ],
)
def test_control_and_bidi_characters_are_refused(field, label, char):
    # SUBJECT_DESCRIPTOR is composed into the dashboard's rendered claim
    # sentence, so a right-to-left override is display spoofing on the
    # surface a strategist uses to decide whether to believe us.
    with pytest.raises(InvalidClaim, match="control or bidirectional"):
        _claim(**{field: f"rucking{char}vests"})


def test_the_error_names_the_offending_code_point():
    with pytest.raises(InvalidClaim, match=r"U\+202E"):
        _claim(subject_descriptor="rucking‮vests")


def test_ordinary_and_non_ascii_text_still_passes():
    # The check names the twelve bidi controls rather than rejecting the
    # whole Cf category, so accented text, emoji and joiners are unaffected.
    claim = _claim(subject_descriptor="crème brûlée soft-serve \U0001f366")

    assert claim.subject_descriptor.startswith("crème")
    assert _claim(subject_descriptor="family \U0001f468‍\U0001f469‍\U0001f467")
