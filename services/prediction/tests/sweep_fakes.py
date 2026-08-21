"""Fakes for the re-evaluation sweep (CRMA-766).

Built on ``matching_fakes.LedgerSimulator``, which already behaves like the
verdict ledger -- append what is MERGEd, answer the live-prediction read as
"latest row per PREDICTION_ID, filtered to the statuses the caller asked
for". Two things the sweep needs on top of that:

* the generation pass's two reads (the signal corpus, and the live-subject
  list, which also comes off the ledger but is a different statement);
* a model fake that answers three different turns -- generation, the
  saturation weighing pass, and the re-evaluation turn -- by reading which
  one it was asked, exactly as the real model does.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from prediction_service.generation.llm import DEFAULT_MODEL, LLMResponse, estimate_cost_usd
from prediction_service.sweep.prompt import REEVALUATION_MARKER

from .fakes import NO_RESTATEMENT, RecordedCall, is_weighing_turn
from .matching_fakes import LedgerSimulator

#: A re-evaluation reply that says nothing about anything: every live call
#: keeps its prior confidence and reasoning, and no observable check is read.
#: What most sweep tests want while they assert something else.
NO_REEVALUATION = '{"reevaluations": []}'


def is_reevaluation_turn(system: str) -> bool:
    return REEVALUATION_MARKER in system


def reevaluation_reply(*entries: Mapping[str, Any]) -> str:
    return json.dumps({"reevaluations": list(entries)})


@dataclass
class SweepLedgerSimulator(LedgerSimulator):
    """The ledger, plus the two reads the generation pass makes."""

    signals: list[dict[str, Any]] = field(default_factory=list)

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        upper = sql.upper()
        # The live-subject read is against the ledger too, but it is a
        # different statement with a different shape -- route it before the
        # simulator's open-prediction branch, which would assert on its
        # missing ORDER BY.
        if "DISTINCT SUBJECT_DESCRIPTOR" in upper:
            self.calls.append(RecordedCall(sql, params, kind="query"))
            return [
                {"SUBJECT_DESCRIPTOR": row["SUBJECT_DESCRIPTOR"]}
                for row in self.rows
                if str(row.get("PREDICTION_STATUS") or "").upper() == "ACTIVE"
            ]
        if "FCT_SIGNALS" in upper and "FCT_PREDICTION_VERDICT_LEDGER" not in upper:
            self.calls.append(RecordedCall(sql, params, kind="query"))
            return list(self.signals)
        return super().query(sql, params)


@dataclass
class SweepLLM:
    """A model that answers all three turns, told apart by their prompts."""

    reevaluation_reply: str = NO_REEVALUATION
    generation_reply: str = '{"predictions": []}'
    weighing_reply: str = NO_RESTATEMENT
    fail_reevaluation_with: Exception | None = None
    model: str = "fake-model"
    input_tokens: int = 1200
    output_tokens: int = 300
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        if is_reevaluation_turn(system):
            if self.fail_reevaluation_with:
                raise self.fail_reevaluation_with
            text = self.reevaluation_reply
        elif is_weighing_turn(system):
            text = self.weighing_reply
        else:
            text = self.generation_reply
        return LLMResponse(
            text=text,
            model=self.model,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            cost_usd=estimate_cost_usd(
                self.input_tokens, self.output_tokens, model=DEFAULT_MODEL
            ),
        )

    @property
    def reevaluation_prompts(self) -> list[tuple[str, str]]:
        return [call for call in self.calls if is_reevaluation_turn(call[0])]
