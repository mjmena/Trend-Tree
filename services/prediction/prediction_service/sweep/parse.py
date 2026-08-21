"""The re-evaluation reply, parsed (CRMA-766).

Same contract as saturation/weigh.py's ``parse_weighings``, and for the same
reason: **an entry is bound to its subject, not to its position**. Asked to
re-evaluate a list, a model may reasonably return the entries re-sorted by
its new confidence and renumbered 1..n. Read back by id, that would write
each row with another call's confidence, another call's reasoning, and --
worse here than in the weighing pass -- another call's *resolution*, closing
the wrong prediction permanently. Every row still written, nothing
detectably wrong downstream.

Anything malformed or mismatched is simply absent from the returned map, and
an absent id means the caller keeps that prediction's prior confidence and
reasoning and reads its observable check as ``not_yet``. That degradation is
the only safe one: a parser that guessed would be inventing a resolution.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..domain.claim import MAX_LENGTHS
from ..generation.parse import extract_json_object
from ..saturation.weigh import subject_key
from .lifecycle import OBSERVATIONS, OBSERVED_NOT_YET, Observation


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


def parse_reevaluations(text: str, *, subjects: Sequence[str]) -> dict[int, Reevaluation]:
    """Parse the re-evaluation reply into ``{1-based id: Reevaluation}``.

    ``subjects`` is the batch in the order it was rendered, so ``subjects[0]``
    is the subject of id 1. An entry must echo the subject its id was shown
    against, or it is dropped -- see the module docstring.
    """
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
        subject = entry.get("subject")
        if not isinstance(subject, str) or subject_key(subject) != expected[index]:
            # The answer does not say which call it is about, or says a
            # different one. Keeping the prior row's numbers is the only
            # option that cannot mislabel a resolution.
            continue
        out[index] = Reevaluation(
            confidence=_confidence(entry.get("confidence")),
            reasoning=_text(entry.get("reasoning"), limit=MAX_LENGTHS["reasoning"]),
            what_changed=_text(entry.get("what_changed"), limit=MAX_LENGTHS["what_changed"]),
            observation=_observation(entry),
        )
    return out
