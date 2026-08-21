"""Turning the model's reply into candidate claims -- pure (CRMA-763).

Every rejection here is a *structural* one: a candidate is dropped because it
is not a falsifiable claim, or because its evidence does not exist, never
because a threshold judged it unpromising. Confidence thresholds are a
verdict-side concern and mechanical gates are ruled out by the strategy doc
(§10.4); the one rule this module enforces is the strategy's own §2 line --
"a topic without a claim is never emitted, however confident the agent feels."

Rejections are returned, not swallowed. The route reports the count and the
reasons so a run that emitted nothing is legible instead of merely empty.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..domain.claim import HORIZON_BANDS, Claim, InvalidClaim, check_length

#: A model that ignores "no code fence" is still answering the question --
#: strip the fence rather than throwing the run away.
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


class UnparseableResponse(ValueError):
    """The reply was not the JSON object the prompt asked for."""


@dataclass(frozen=True)
class Candidate:
    """A parsed, structurally-valid candidate prediction, ready to be minted
    into a verdict."""

    claim: Claim
    confidence: float
    reasoning: str
    source_signals: tuple[str, ...]
    emergence_path: str | None


@dataclass(frozen=True)
class Rejection:
    """Why one proposed candidate did not become a prediction."""

    index: int
    reason: str
    subject: str | None


def extract_json_object(text: str) -> dict[str, Any]:
    """Parse the model's reply into a dict, tolerating a code fence or
    incidental prose around the object."""
    body = text.strip()
    fenced = _FENCE.match(body)
    if fenced:
        body = fenced.group(1).strip()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        start, end = body.find("{"), body.rfind("}")
        if start == -1 or end <= start:
            raise UnparseableResponse(
                f"no JSON object in the model reply: {body[:200]!r}"
            ) from None
        try:
            parsed = json.loads(body[start : end + 1])
        except json.JSONDecodeError as err:
            raise UnparseableResponse(f"malformed JSON in the model reply: {err}") from err
    if not isinstance(parsed, dict):
        raise UnparseableResponse(f"expected a JSON object, got {type(parsed).__name__}")
    return parsed


def _text(raw: Any) -> str:
    return raw.strip() if isinstance(raw, str) else ""


def _confidence(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 100 else None


def parse_candidates(
    text: str,
    *,
    known_signal_ids: Iterable[str],
    max_predictions: int,
) -> tuple[list[Candidate], list[Rejection]]:
    """Parse and structurally validate the model's proposals.

    ``known_signal_ids`` is the corpus this run actually showed the model.
    An id outside it is dropped: ``EVIDENCE.source_signals`` is meant to be
    the audit trail behind a call, and an id that resolves to no
    ``FCT_SIGNALS`` row makes that trail a lie. A candidate left with no
    surviving id is rejected outright -- an uncitable claim is not evidence,
    it is a guess.
    """
    known = set(known_signal_ids)
    payload = extract_json_object(text)
    proposals = payload.get("predictions")
    if proposals is None:
        raise UnparseableResponse("model reply has no 'predictions' key")
    if not isinstance(proposals, Sequence) or isinstance(proposals, (str, bytes)):
        raise UnparseableResponse(
            f"'predictions' must be a list, got {type(proposals).__name__}"
        )

    accepted: list[Candidate] = []
    rejected: list[Rejection] = []

    for index, raw in enumerate(proposals):
        if not isinstance(raw, Mapping):
            rejected.append(Rejection(index, "proposal is not an object", None))
            continue

        subject = _text(raw.get("subject_descriptor"))
        directional = _text(raw.get("directional_claim"))
        observable = _text(raw.get("observable_check"))
        band = _text(raw.get("horizon_band"))

        # The strategy's §2 rule, and this module's whole reason to exist: a
        # topic without a directional claim is not a prediction at any
        # confidence. Same for the observable check -- a claim nobody can
        # grade is not falsifiable, which is the property the ledger's NOT
        # NULL columns exist to guarantee.
        if not subject:
            rejected.append(Rejection(index, "no subject_descriptor", None))
            continue
        if not directional:
            rejected.append(
                Rejection(index, "no directional_claim -- a topic, not a claim", subject)
            )
            continue
        if not observable:
            rejected.append(
                Rejection(index, "no observable_check -- not gradable", subject)
            )
            continue
        if band not in HORIZON_BANDS:
            rejected.append(
                Rejection(
                    index,
                    f"horizon_band {band!r} is not one of {list(HORIZON_BANDS)}",
                    subject,
                )
            )
            continue

        confidence = _confidence(raw.get("confidence"))
        if confidence is None:
            rejected.append(Rejection(index, "confidence missing or outside 0-100", subject))
            continue

        reasoning = _text(raw.get("reasoning"))
        if not reasoning:
            rejected.append(Rejection(index, "no reasoning", subject))
            continue

        raw_ids = raw.get("source_signals")
        cited = [] if not isinstance(raw_ids, Iterable) or isinstance(raw_ids, (str, bytes)) else [
            _text(i) for i in raw_ids
        ]
        source_signals = tuple(dict.fromkeys(i for i in cited if i in known))
        if not source_signals:
            rejected.append(
                Rejection(index, "no source_signals that exist in this run's corpus", subject)
            )
            continue

        try:
            claim = Claim(
                subject_descriptor=subject,
                directional_claim=directional,
                horizon_band=band,  # type: ignore[arg-type]
                observable_check=observable,
            )
            check_length("reasoning", reasoning)
        except InvalidClaim as err:
            rejected.append(Rejection(index, str(err), subject))
            continue

        accepted.append(
            Candidate(
                claim=claim,
                confidence=confidence,
                reasoning=reasoning,
                source_signals=source_signals,
                emergence_path=_text(raw.get("emergence_path")) or None,
            )
        )

    # The cap is the run's, not the model's. Anything past it is surplus, not
    # a defect -- recorded as such so the count still reconciles.
    if len(accepted) > max_predictions:
        for extra in accepted[max_predictions:]:
            rejected.append(
                Rejection(
                    -1,
                    f"beyond this run's cap of {max_predictions}",
                    extra.claim.subject_descriptor,
                )
            )
        accepted = accepted[:max_predictions]

    return accepted, rejected
