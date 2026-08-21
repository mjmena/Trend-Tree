"""The generation phase of the prediction pillar (CRMA-763).

Structurally blind to ``FCT_TRENDS``, heat and lifecycle -- see
``blindness.py`` for how that is enforced (a capability boundary plus a
statement guard) and ``run.py`` for the signature that carries it.

Public surface:

* ``generate_predictions`` / ``GenerationScope`` / ``GenerationResult`` -- the pass.
* ``SignalReader`` / ``SnowflakeSignalReader`` / ``FixtureSignalReader`` -- the
  phase's only data capability, deployed and local-loop flavors.
* ``PredictionLLM`` / ``GeminiPredictionLLM`` / ``ReplayLLM`` -- the LLM seam.
* ``build_system_prompt`` / ``build_user_prompt`` -- pure prompt builders.
* ``BlindnessViolation`` -- raised before a forbidden statement is issued.
"""

from __future__ import annotations

from .blindness import FORBIDDEN_TABLE_TOKENS, BlindnessViolation, assert_generation_sql
from .llm import GeminiPredictionLLM, LLMError, LLMResponse, PredictionLLM, ReplayLLM
from .parse import Candidate, Rejection, UnparseableResponse, parse_candidates
from .prompt import build_system_prompt, build_user_prompt
from .run import GenerationResult, GenerationScope, generate_predictions, new_chain_id
from .signals import (
    SIGNAL_QUERY,
    SIGNALS_TABLE,
    FixtureSignalReader,
    SignalReader,
    SignalRecord,
    SnowflakeSignalReader,
)

__all__ = [
    "FORBIDDEN_TABLE_TOKENS",
    "SIGNALS_TABLE",
    "SIGNAL_QUERY",
    "BlindnessViolation",
    "Candidate",
    "FixtureSignalReader",
    "GeminiPredictionLLM",
    "GenerationResult",
    "GenerationScope",
    "LLMError",
    "LLMResponse",
    "PredictionLLM",
    "Rejection",
    "ReplayLLM",
    "SignalReader",
    "SignalRecord",
    "SnowflakeSignalReader",
    "UnparseableResponse",
    "assert_generation_sql",
    "build_system_prompt",
    "build_user_prompt",
    "generate_predictions",
    "new_chain_id",
    "parse_candidates",
]
