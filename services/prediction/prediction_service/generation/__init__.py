"""The generation phase of the prediction pillar (CRMA-763).

Blind to ``FCT_TRENDS``, heat and lifecycle -- see ``blindness.py`` for
what enforces that (a narrow signature kept honest by a test, plus a
statement guard that runs) and ``run.py`` for the signature itself.

Public surface:

* ``generate_predictions`` / ``GenerationScope`` / ``GenerationResult`` -- the pass.
* ``SignalReader`` / ``SnowflakeSignalReader`` / ``FixtureSignalReader`` -- the
  phase's evidence source, deployed and local-loop flavors.
* ``LiveSubjectReader`` / ``SnowflakeLiveSubjectReader`` /
  ``StaticLiveSubjectReader`` -- the subjects already under a live
  prediction, so a daily run does not re-mint them.
* ``PredictionLLM`` / ``GeminiPredictionLLM`` / ``ReplayLLM`` -- the LLM seam.
* ``build_system_prompt`` / ``build_user_prompt`` -- pure prompt builders.
* ``BlindnessViolation`` -- raised before a forbidden statement is issued.
"""

from __future__ import annotations

from .blindness import FORBIDDEN_TABLE_TOKENS, BlindnessViolation, assert_generation_sql
from .llm import (
    GeminiPredictionLLM,
    LLMError,
    LLMResponse,
    PredictionLLM,
    ReplayLLM,
    TransientLLMError,
    TruncatedResponse,
)
from .parse import Candidate, Rejection, UnparseableResponse, parse_candidates
from .prompt import build_system_prompt, build_user_prompt
from .run import GenerationResult, GenerationScope, generate_predictions, new_chain_id
from .signals import (
    LIVE_SUBJECTS_QUERY,
    SIGNAL_QUERY,
    SIGNALS_TABLE,
    VERDICT_LEDGER_TABLE,
    FixtureSignalReader,
    LiveSubjectReader,
    SignalReader,
    SignalRecord,
    SnowflakeLiveSubjectReader,
    SnowflakeSignalReader,
    StaticLiveSubjectReader,
)

__all__ = [
    "FORBIDDEN_TABLE_TOKENS",
    "LIVE_SUBJECTS_QUERY",
    "SIGNALS_TABLE",
    "SIGNAL_QUERY",
    "VERDICT_LEDGER_TABLE",
    "BlindnessViolation",
    "Candidate",
    "FixtureSignalReader",
    "GeminiPredictionLLM",
    "GenerationResult",
    "GenerationScope",
    "LLMError",
    "LLMResponse",
    "LiveSubjectReader",
    "PredictionLLM",
    "Rejection",
    "ReplayLLM",
    "SignalReader",
    "SignalRecord",
    "SnowflakeLiveSubjectReader",
    "SnowflakeSignalReader",
    "StaticLiveSubjectReader",
    "TransientLLMError",
    "TruncatedResponse",
    "UnparseableResponse",
    "assert_generation_sql",
    "build_system_prompt",
    "build_user_prompt",
    "generate_predictions",
    "new_chain_id",
    "parse_candidates",
]
