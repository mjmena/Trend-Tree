"""The re-evaluation reply, parsed (CRMA-766).

Same shape as saturation/weigh.py's ``parse_weighings``, and for the same
reason: **an entry is bound to the call it names, not to its position**.
Asked to re-evaluate a list, a model may reasonably return the entries
re-sorted by its new confidence and renumbered 1..n. Read back by position,
that would write each row with another call's confidence, another call's
reasoning, and -- worse here than in the weighing pass -- another call's
*resolution*, closing the wrong prediction permanently. Every row still
written, nothing detectably wrong downstream.

**The binding key is PREDICTION_ID, not the subject.** The subject descriptor
is not unique across live calls: generation dedupes on the whole four-part
claim (``generation/run.py``), so two candidates that share a subject and
differ in their directional claim both mint, and the live-subject index is
read before the model turn, so it cannot suppress a same-subject sibling
minted in the same reply. Two live predictions on "rucking vests" bound by
subject alone would let a swapped reply hand call A the ``met`` that belongs
to call B -- and ``met`` is terminal. So each entry echoes the PREDICTION_ID
it was shown against, which is an identity by construction, and the subject
is checked as a second opinion when it is offered.

An entry binds only when BOTH the position it claims and the PREDICTION_ID it
echoes agree. An internally inconsistent entry -- a renumbered id under the
right prediction, or the right number under the wrong prediction -- is
dropped rather than reconciled: choosing which of the two fields to believe
would be the parser inventing a resolution.

Anything malformed or mismatched is simply absent from the returned map, and
an absent id means the caller keeps that prediction's prior confidence and
reasoning and reads its observable check as ``not_yet``. That degradation is
the only safe one.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..domain.claim import MAX_LENGTHS, InvalidClaim, check_length, check_printable
from ..generation.parse import extract_json_object
from ..saturation.weigh import subject_key
from .lifecycle import OBSERVATIONS, OBSERVED_NOT_YET, Observation

log = logging.getLogger(__name__)


class UnparseableReevaluation(ValueError):
    """The re-evaluation reply was not the JSON object the prompt asked for.
    The caller degrades to "every live call keeps what it had" -- it never
    fails the sweep."""


@dataclass(frozen=True)
class Reevaluation:
    """The model's answer for one live call. ``confidence`` is whatever it
    said -- higher, lower or identical -- and ``observation`` is what it read
    the observable check as."""

    confidence: float | None
    reasoning: str
    what_changed: str
    observation: Observation
    #: A rewritten angle / question (CRMA-782), or None when the model left
    #: it alone. None means "keep what is stored", never "erase it" -- see
    #: ``sweep.run`` for the refresh rule.
    angle: str | None = None
    audience_question: str | None = None


def _confidence(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 100 else None


def _text(raw: Any, *, limit: int) -> str:
    if not isinstance(raw, str):
        return ""
    value = raw.strip()
    return value[:limit].rstrip() if len(value) > limit else value


def _narrative(name: str, raw: Any) -> str | None:
    """One rewritten narrative field (CRMA-782), or None to leave the stored
    one alone.

    Truncation is deliberately NOT used here, unlike ``_text`` above. A
    half-sentence angle reads as a bug on the card, and the stored one is
    always a usable fallback -- so an over-long rewrite is discarded in
    favour of what we already have, rather than trimmed into nonsense.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value:
        return None
    try:
        check_length(name, value)
        check_printable(name, value)
    except InvalidClaim as err:
        # See the sibling in generation/parse.py: a discarded rewrite and a
        # model that stayed quiet both leave the stored value in place, so
        # only a log tells the two apart.
        log.info(
            "narrative rewrite discarded",
            extra={"field": name, "chars": len(value), "reason": str(err)},
        )
        return None
    return value


def _observation(entry: Mapping[str, Any]) -> Observation:
    """The reading, defaulting to ``not_yet``.

    An unrecognized value is ``not_yet`` too, not an error: the two outcomes
    this could otherwise fall into are both permanent, and a typo must never
    be able to close a call.
    """
    raw = entry.get("observable_check")
    outcome = raw.strip().lower() if isinstance(raw, str) else ""
    rationale = _text(entry.get("observation"), limit=MAX_LENGTHS["what_changed"])
    if outcome not in OBSERVATIONS:
        return Observation(
            outcome=OBSERVED_NOT_YET,
            rationale=(
                rationale
                or (
                    f"the reply did not say how the observable check reads "
                    f"({raw!r}); read as not yet settled"
                )
            ),
        )
    return Observation(
        outcome=outcome,
        rationale=rationale or "no rationale was given for this reading",
    )


def parse_reevaluations(
    text: str, *, prediction_ids: Sequence[str], subjects: Sequence[str]
) -> dict[int, Reevaluation]:
    """Parse the re-evaluation reply into ``{1-based id: Reevaluation}``.

    Both sequences are the batch in the order it was rendered, so element 0
    of each belongs to id 1. An entry must echo the PREDICTION_ID its id was
    shown against -- and, when it offers one, a matching subject -- or it is
    dropped. See the module docstring for why the id is the key and the
    subject is not.
    """
    if len(prediction_ids) != len(subjects):
        raise ValueError(
            "prediction_ids and subjects describe the same batch and must be the same "
            f"length, got {len(prediction_ids)} and {len(subjects)}"
        )
    expected_id = {
        index: str(prediction_id).strip()
        for index, prediction_id in enumerate(prediction_ids, 1)
    }
    expected = {index: subject_key(subject) for index, subject in enumerate(subjects, 1)}
    count = len(subjects)
    payload = extract_json_object(text)
    raw = payload.get("reevaluations")
    if raw is None:
        raise UnparseableReevaluation("re-evaluation reply has no 'reevaluations' key")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise UnparseableReevaluation(
            f"'reevaluations' must be a list, got {type(raw).__name__}"
        )

    out: dict[int, Reevaluation] = {}
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        identifier = entry.get("id")
        if isinstance(identifier, bool) or not isinstance(identifier, (int, float, str)):
            continue
        try:
            index = int(identifier)
        except (TypeError, ValueError):
            continue
        if not 1 <= index <= count or index in out:
            continue
        identity = entry.get("prediction_id")
        if not isinstance(identity, str) or identity.strip() != expected_id[index]:
            # The answer does not say which call it is about, or names a
            # different one. Keeping the prior row's numbers is the only
            # option that cannot mislabel a resolution -- and PREDICTION_ID
            # is the only field in the reply that is an identity.
            continue
        subject = entry.get("subject")
        if subject is not None and (
            not isinstance(subject, str) or subject_key(subject) != expected[index]
        ):
            # The id and the subject disagree about which call this is. Two
            # live calls can share a subject but never an id, so this is an
            # incoherent entry, not a recoverable one.
            continue
        out[index] = Reevaluation(
            confidence=_confidence(entry.get("confidence")),
            reasoning=_text(entry.get("reasoning"), limit=MAX_LENGTHS["reasoning"]),
            what_changed=_text(entry.get("what_changed"), limit=MAX_LENGTHS["what_changed"]),
            observation=_observation(entry),
            angle=_narrative("angle", entry.get("angle")),
            audience_question=_narrative("audience_question", entry.get("audience_question")),
        )
    return out
