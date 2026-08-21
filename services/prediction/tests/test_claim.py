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
