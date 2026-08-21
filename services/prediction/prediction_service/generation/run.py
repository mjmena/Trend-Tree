"""The generation phase: signal corpus in, ACTIVE verdict rows out (CRMA-763).

Read the signature below before anything else -- it *is* the isolation
guarantee. ``generate_predictions`` takes a ``SignalReader`` and a
``PredictionLLM``. It takes no ``SnowflakeClient``, no ``Settings``, and no
trend-side collaborator of any kind, so nothing in this call graph can reach
``FCT_TRENDS``, heat, or lifecycle -- the PRD's "the generation module has no
trend-table access", spelled as a type rather than as a promise.

The phase ends at built ``Verdict`` objects. Writing them is the caller's
job (routes/generate.py), which keeps the write capability outside the blind
region entirely.

What this phase does NOT do, deliberately:

* **match against trends** -- CRMA-764. Every verdict minted here carries
  ``MATCHED_TREND_ID = NULL``, which the strategy's §2 vocabulary calls a
  white-space prediction: a call the trend pipeline has not made yet.
  Ledger-only in v1.
* **saturation evidence** -- CRMA-765. ``EVIDENCE.saturation`` is present
  (the key's presence is the contract, per domain.claim) and null.
* **re-evaluation / what-changed** -- CRMA-766. Every row here is a first
  mint, so ``WHAT_CHANGED`` is NULL by definition.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..domain.claim import InvalidClaim, Verdict, build_verdict
from .llm import LLMResponse, PredictionLLM
from .parse import Candidate, Rejection, parse_candidates
from .prompt import build_system_prompt, build_user_prompt
from .signals import SignalReader, SignalRecord

log = logging.getLogger(__name__)

#: Namespace for deriving a run's PREDICTION_EVAL_IDs from its chain id, so a
#: caller who supplies a stable chain id (a Cloud Scheduler execution id, say)
#: gets an idempotent retry: the ledger MERGE matches the already-committed
#: rows and writes nothing, instead of appending a second copy of the run.
EVAL_ID_NAMESPACE = uuid.UUID("6b1f4f7c-2f2a-5c26-9f4a-9e3f1c0b7a51")


@dataclass(frozen=True)
class GenerationScope:
    """A run's cap. Caps, not gates: they bound cost and blast radius, they
    do not decide what qualifies (strategy §10.4 -- mechanical gates need a
    decision, not a commit)."""

    lookback_hours: int = 168
    signal_limit: int = 200
    max_predictions: int = 5

    def __post_init__(self) -> None:
        for name in ("lookback_hours", "signal_limit", "max_predictions"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be at least 1, got {getattr(self, name)}")


@dataclass(frozen=True)
class GenerationResult:
    chain_id: str
    verdicts: list[Verdict]
    rejected: list[Rejection] = field(default_factory=list)
    signals_considered: int = 0
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0


def new_chain_id() -> str:
    """Matches the ledger DDL's documented CHAIN_ID shape."""
    return f"pred-verdict-chain-{uuid.uuid4().hex[:8]}"


def eval_id_for(chain_id: str, index: int) -> str:
    return str(uuid.uuid5(EVAL_ID_NAMESPACE, f"{chain_id}:{index}"))


def build_evidence(candidate: Candidate, *, model: str, chain_id: str) -> dict[str, object]:
    """The contracted EVIDENCE VARIANT for a freshly-generated prediction.

    All four required keys are present -- the presence is the contract, the
    value need not be (domain.claim.REQUIRED_EVIDENCE_KEYS). ``trend_context``
    is null because this verdict is unmatched *and* because generation could
    not have read heat or lifecycle to fill it in; ``saturation`` and
    ``coverage`` are null pending CRMA-765 and the coverage detector.
    """
    return {
        "source_signals": list(candidate.source_signals),
        "saturation": None,
        "trend_context": None,
        "coverage": None,
        # Provenance, not a contracted key -- readable context, per the
        # strategy's "filterable facts are columns, readable context is JSON".
        "generation": {
            "phase": "generate",
            "emergence_path": candidate.emergence_path,
            "model": model,
            "chain_id": chain_id,
        },
    }


def generate_predictions(
    *,
    reader: SignalReader,
    llm: PredictionLLM,
    scope: GenerationScope | None = None,
    chain_id: str | None = None,
    minted_at: datetime | None = None,
) -> GenerationResult:
    """One generation pass. Blind by construction -- see the module docstring."""
    scope = scope or GenerationScope()
    chain = chain_id or new_chain_id()
    minted = minted_at or datetime.now(UTC)

    signals: list[SignalRecord] = reader.recent_signals(
        lookback_hours=scope.lookback_hours, limit=scope.signal_limit
    )
    system = build_system_prompt()
    user = build_user_prompt(signals, max_predictions=scope.max_predictions)

    response: LLMResponse = llm.complete(system=system, user=user)

    candidates, rejected = parse_candidates(
        response.text,
        known_signal_ids=[s.signal_id for s in signals],
        max_predictions=scope.max_predictions,
    )

    verdicts: list[Verdict] = []
    for index, candidate in enumerate(candidates):
        try:
            verdicts.append(
                build_verdict(
                    candidate.claim,
                    confidence=candidate.confidence,
                    reasoning=candidate.reasoning,
                    evidence=build_evidence(candidate, model=response.model, chain_id=chain),
                    # Generation emits ACTIVE calls only; every other status
                    # in the enum is something a later evaluation decides.
                    status="ACTIVE",
                    # White-space by construction: generation never saw a
                    # trend to match against. CRMA-764 sets this.
                    matched_trend_id=None,
                    # First mint -- nothing has changed yet.
                    what_changed=None,
                    prediction_eval_id=eval_id_for(chain, index),
                    chain_id=chain,
                    minted_at=minted,
                )
            )
        except InvalidClaim as err:
            # parse.py already checked the shape; anything left is a limit
            # only the domain layer knows about. Drop the one candidate, keep
            # the run.
            rejected.append(
                Rejection(
                    index,
                    f"rejected by the domain layer: {err}",
                    candidate.claim.subject_descriptor,
                )
            )

    log.info(
        "generation pass complete",
        extra={
            "chain_id": chain,
            "signals_considered": len(signals),
            "predictions": len(verdicts),
            "rejected": len(rejected),
            "model": response.model,
            "cost_usd": response.cost_usd,
        },
    )
    return GenerationResult(
        chain_id=chain,
        verdicts=verdicts,
        rejected=rejected,
        signals_considered=len(signals),
        model=response.model,
        input_tokens=response.input_tokens,
        output_tokens=response.output_tokens,
        cost_usd=response.cost_usd,
    )
