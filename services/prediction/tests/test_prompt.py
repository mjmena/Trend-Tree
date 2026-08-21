"""The generation prompt builders (CRMA-763 AC6).

Pure functions, so this file needs no warehouse, no network and no key --
which is the whole point of extracting them: prompt quality iterates here,
in milliseconds, instead of through a deploy.

These tests pin the things a downstream failure would trace back to -- the
controlled vocabulary the parser will insist on, the corpus ids the model has
to echo, the two rules the PRD names explicitly (a topic without a claim is
never emitted; convergence multiplies confidence and never gates). They do
not grade the prose.
"""

from __future__ import annotations

import pytest

from prediction_service.domain.claim import HORIZON_BANDS
from prediction_service.generation.prompt import (
    EMERGENCE_PATHS,
    REASONING_DIMENSIONS,
    build_system_prompt,
    build_user_prompt,
    render_signal,
)
from prediction_service.generation.signals import SignalRecord

SIGNALS = [
    SignalRecord(
        signal_id="bluesky:abc123",
        source_name="bluesky",
        signal_timestamp="2026-08-14 13:02:11.000",
        signal_title="everyone at my gym is wearing a weighted vest",
        signal_text="three months ago it was two guys. " * 40,
    ),
    SignalRecord(
        signal_id="amazon_trends:vest:2026-08-12",
        source_name="amazon_trends",
        signal_timestamp="2026-08-12 06:00:00.000",
        signal_title="Weighted vests hold the movers list a fourth week",
        signal_text=None,
    ),
]


def test_the_system_prompt_is_deterministic():
    # A prompt that varies run to run cannot be reviewed in a diff or pinned
    # in a test, and makes a quality regression unattributable.
    assert build_system_prompt() == build_system_prompt()


def test_the_system_prompt_names_all_four_horizon_bands_exactly():
    # The parser rejects any other band string, so a prompt that offers one
    # the domain layer does not accept silently costs the run a prediction.
    prompt = build_system_prompt()
    for band in HORIZON_BANDS:
        assert band in prompt
    assert len(HORIZON_BANDS) == 4


def test_the_system_prompt_frames_all_five_emergence_paths():
    prompt = build_system_prompt()
    assert len(EMERGENCE_PATHS) == 5
    for name, _ in EMERGENCE_PATHS:
        assert name in prompt


def test_convergence_multiplies_confidence_and_never_gates():
    # Strategy §4's rule, and a direct indictment of the retired scorer's
    # hard AND gates -- if this drifts out of the prompt, generation quietly
    # re-acquires the failure mode the pillar exists to remove.
    convergence = dict(EMERGENCE_PATHS)["signal convergence"]
    assert "MULTIPLIES" in convergence
    assert "NEVER gates" in convergence
    assert "Evidence quality beats signal counts" in convergence


def test_the_system_prompt_forbids_emitting_a_topic_without_a_claim():
    # Strategy §2 / AC2. The parser enforces it; the prompt has to ask for it
    # first, or every run pays for proposals that get dropped.
    prompt = build_system_prompt()
    assert "NEVER emitted" in prompt
    assert "however confident" in prompt


def test_the_system_prompt_states_the_descriptor_vocabulary_rule():
    # ADR-0003: an atomic, consumer-vernacular noun -- not a compound
    # behavior, not a coined label, not industry jargon.
    prompt = build_system_prompt()
    assert "ATOMIC" in prompt
    assert "consumer-vernacular noun" in prompt
    assert "industry jargon" in prompt


def test_the_system_prompt_tells_the_agent_it_cannot_see_trends_or_heat():
    prompt = build_system_prompt().lower()
    assert "signal corpus alone" in prompt
    assert "lifecycle" in prompt


def test_the_system_prompt_lists_the_six_reasoning_dimensions():
    prompt = build_system_prompt()
    assert len(REASONING_DIMENSIONS) == 6
    for dimension in REASONING_DIMENSIONS:
        assert dimension in prompt


def test_the_user_prompt_carries_every_signal_id_verbatim():
    # source_signals is the audit trail behind a call; the parser drops any
    # id it cannot find in the corpus, so the ids have to be quotable.
    prompt = build_user_prompt(SIGNALS, max_predictions=3)
    for signal in SIGNALS:
        assert f'id="{signal.signal_id}"' in prompt


def test_the_user_prompt_states_the_run_cap():
    assert "AT MOST 3 prediction(s)" in build_user_prompt(SIGNALS, max_predictions=3)
    assert "AT MOST 1 prediction(s)" in build_user_prompt(SIGNALS, max_predictions=1)


def test_the_user_prompt_reports_the_corpus_size():
    assert "2 signal(s)" in build_user_prompt(SIGNALS, max_predictions=3)


def test_an_empty_corpus_is_stated_rather_than_left_blank():
    # A blank section reads to a model as a formatting bug; saying the slice
    # is empty makes "no predictions" the obvious answer.
    prompt = build_user_prompt([], max_predictions=3)
    assert "corpus slice for this run is empty" in prompt


def test_a_zero_cap_is_a_programming_error_not_a_silent_empty_run():
    with pytest.raises(ValueError, match="at least 1"):
        build_user_prompt(SIGNALS, max_predictions=0)


def test_signal_text_is_truncated_so_a_long_body_cannot_dominate_the_corpus():
    rendered = render_signal(SIGNALS[0], text_chars=100)
    assert rendered.endswith("...")
    assert len(rendered) < 400


def test_a_signal_with_no_body_renders_without_an_empty_text_line():
    rendered = render_signal(SIGNALS[1])
    assert "text:" not in rendered
    assert "title:" in rendered


def test_a_missing_timestamp_is_named_rather_than_rendered_as_none():
    undated = SignalRecord("x:1", "bluesky", None, "a title", None)
    assert "at=unknown time" in render_signal(undated)
