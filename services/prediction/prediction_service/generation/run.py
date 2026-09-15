"""The generation phase: signal corpus in, ACTIVE verdict rows out (CRMA-763).

Read the signature below before anything else. ``generate_predictions`` takes
a ``SignalReader``, an optional ``LiveSubjectReader``, and a
``PredictionLLM``. It takes no ``SnowflakeClient``, no ``Settings``, and no
trend-side collaborator of any kind -- the PRD's "the generation module has
no trend-table access", written as a signature. What that does and does not
enforce at runtime is spelled out honestly in blindness.py; the guard that
actually runs is ``assert_generation_sql``.

The phase ends at built ``Verdict`` objects. Writing them is the caller's
job (routes/generate.py), which keeps the write capability outside the blind
region entirely.

What this phase does NOT do, deliberately:

* **match against trends** -- that is the compare step, ``POST /match``
  (matching/run.py), and it stays off this call path so a trend read can
  never appear inside a generation run. Every verdict minted here carries
  ``MATCHED_TREND_ID = NULL``, which the strategy's §2 vocabulary calls a
  white-space prediction: a call the trend pipeline has not made yet.
* **saturation evidence** -- built here as a present-and-null key (the key's
  presence is the contract, per domain.claim) and filled in *after* this
  phase returns, by ``saturation.SaturationPhase`` (CRMA-765), which also
  applies the data-quality floor. Keeping it out of this call is what lets
  the phase keep the signature below: no oracle enters it.
* **re-evaluation / what-changed** -- CRMA-766. Every row here is a first
  mint, so ``WHAT_CHANGED`` is NULL by definition. Note the difference from
  the live-subject skip below: this phase declines to re-propose a subject
  that is already live, but it never re-grades one.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..domain.claim import Claim, InvalidClaim, Verdict, build_verdict
from .llm import LLMResponse, PredictionLLM
from .parse import Candidate, Rejection, parse_candidates
from .prompt import build_system_prompt, build_user_prompt, fit_corpus
from .signals import LiveSubjectReader, SignalReader, SignalRecord

log = logging.getLogger(__name__)

#: Namespace for deriving a run's PREDICTION_EVAL_IDs. See ``eval_id_for``.
EVAL_ID_NAMESPACE = uuid.UUID("6b1f4f7c-2f2a-5c26-9f4a-9e3f1c0b7a51")

#: Separator inside the hashed key. A unit separator cannot appear in a claim
#: field (domain.claim.check_printable rejects control characters), so no two
#: different claims can collide by re-splitting the same concatenation.
_KEY_SEP = "\x1f"


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
    #: Answer plus thinking tokens -- what the model bills for (llm.py).
    output_tokens: int = 0
    #: None when llm.py does not price this model. Unknown, not free.
    cost_usd: float | None = None
    #: The corpus rows the model was actually shown, after fit_corpus. Carried
    #: out of the phase so the saturation pass's data-quality floor (CRMA-765)
    #: can measure a subject's observation record against the same rows the
    #: claim was made from, without a second warehouse read.
    corpus: tuple[SignalRecord, ...] = ()


def new_chain_id() -> str:
    """Matches the ledger DDL's documented CHAIN_ID shape."""
    return f"pred-verdict-chain-{uuid.uuid4().hex[:8]}"


def normalize_subject(subject: str) -> str:
    """The comparison form of a subject descriptor: whitespace collapsed,
    case folded. Used for the live-subject skip, so "Rucking Vests" and
    "rucking  vests" are the same subject."""
    return " ".join(subject.split()).casefold()


def claim_key(chain_id: str, claim: Claim) -> str:
    """The identity string a PREDICTION_EVAL_ID is derived from."""
    return _KEY_SEP.join(
        (
            chain_id,
            normalize_subject(claim.subject_descriptor),
            normalize_subject(claim.directional_claim),
            claim.horizon_band,
            normalize_subject(claim.observable_check),
        )
    )


def eval_id_for(chain_id: str, claim: Claim) -> str:
    """This row's ledger identity: a stable hash of the frozen 4-part claim
    within its chain.

    **Not the claim's ordinal in the run**, which is what this used to be and
    which is unsound against this model. Generation calls Gemini at
    ``temperature: 1.0`` (required while thinking is on), so a re-fire
    proposes different claims in a different order. Keyed on position, a
    re-fire with the same ``chain_id`` MERGE-matched index 0 and silently
    discarded whatever new claim happened to land there, wrote genuinely new
    claims at whichever indexes the first attempt had not used, and reported
    ids for rows that existed nowhere. "Idempotent" described the id, not the
    run.

    Keyed on content: an identical claim re-writes the row it already owns
    (the MERGE matches, nothing changes, which is what idempotent means), and
    a claim the model worded differently lands as its own row rather than
    overwriting an unrelated one. The chain id stays in the key so two
    separate runs that happen to agree still record two runs.
    """
    return str(uuid.uuid5(EVAL_ID_NAMESPACE, claim_key(chain_id, claim)))


def build_evidence(candidate: Candidate, *, model: str, chain_id: str) -> dict[str, object]:
    """The contracted EVIDENCE VARIANT for a freshly-generated prediction.

    Every required key is present -- the presence is the contract, the value
    need not be (domain.claim.REQUIRED_EVIDENCE_KEYS). ``trend_context`` is
    null because this verdict is unmatched *and* because generation could not
    have read heat or lifecycle to fill it in; ``saturation`` is filled in
    after this phase returns (saturation/run.py, CRMA-765); ``coverage`` is
    null pending the coverage detector; ``strategist`` is null because a
    prediction minted in this pass has not existed long enough for a human to
    have acted on it (CRMA-768 -- the sweep is where the human tier is read).
    """
    return {
        "source_signals": list(candidate.source_signals),
        "saturation": None,
        "trend_context": None,
        "coverage": None,
        "strategist": None,
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
    live_subjects: LiveSubjectReader | None = None,
    scope: GenerationScope | None = None,
    chain_id: str | None = None,
    minted_at: datetime | None = None,
) -> GenerationResult:
    """One generation pass. Blind by construction -- see the module docstring."""
    scope = scope or GenerationScope()
    chain = chain_id or new_chain_id()
    minted = minted_at or datetime.now(UTC)

    read: list[SignalRecord] = reader.recent_signals(
        lookback_hours=scope.lookback_hours, limit=scope.signal_limit
    )
    # The corpus the model is actually shown, bounded per-field and in total
    # (prompt.MAX_CORPUS_CHARS). Everything downstream keys off `signals`,
    # not `read`, so the citable id set never includes a signal that was
    # dropped for size.
    signals, _ = fit_corpus(read)
    if len(signals) < len(read):
        log.info(
            "corpus trimmed to the prompt budget",
            extra={"chain_id": chain, "read": len(read), "shown": len(signals)},
        )

    live = live_subjects.live_subjects() if live_subjects is not None else []
    live_index = {normalize_subject(s) for s in live}

    system = build_system_prompt()
    user = build_user_prompt(signals, max_predictions=scope.max_predictions, live_subjects=live)

    response: LLMResponse = llm.complete(system=system, user=user)

    candidates, rejected = parse_candidates(
        response.text,
        known_signal_ids=[s.signal_id for s in signals],
        max_predictions=scope.max_predictions,
    )

    verdicts: list[Verdict] = []
    seen: set[str] = set()
    for index, candidate in enumerate(candidates):
        subject = candidate.claim.subject_descriptor
        # Fired daily on a rolling window, the same subject would otherwise
        # be re-minted under a fresh PREDICTION_ID every day. The prompt asks
        # the model not to re-propose a live subject; this is the half that
        # does not depend on the model complying.
        if normalize_subject(subject) in live_index:
            rejected.append(
                Rejection(index, "subject already carries a live ACTIVE prediction", subject)
            )
            continue

        eval_id = eval_id_for(chain, candidate.claim)
        if eval_id in seen:
            # Two proposals in one reply that reduce to the same claim. They
            # would MERGE onto one another; saying so is better than a
            # mystery "written: false" in the response.
            rejected.append(Rejection(index, "duplicate of an earlier claim in this run", subject))
            continue
        seen.add(eval_id)

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
                    prediction_eval_id=eval_id,
                    chain_id=chain,
                    minted_at=minted,
                    # Strategist-facing narrative (CRMA-782). Generation is
                    # where these are written: the corpus is in hand, so the
                    # angle rests on the same evidence as the claim, and no
                    # later phase needs an LLM call to invent one. Either may
                    # be None -- parse.py drops an unusable value rather than
                    # letting it reject the claim.
                    angle=candidate.angle,
                    audience_question=candidate.audience_question,
                )
            )
        except InvalidClaim as err:
            # parse.py already checked the shape; anything left is a limit
            # only the domain layer knows about. Drop the one candidate, keep
            # the run.
            rejected.append(Rejection(index, f"rejected by the domain layer: {err}", subject))

    log.info(
        "generation pass complete",
        extra={
            "chain_id": chain,
            "signals_considered": len(signals),
            "live_subjects": len(live_index),
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
        corpus=tuple(signals),
    )
