"""The saturation weighing pass -- pure prompt builders and parser (CRMA-765).

Saturation has to change the verdict *through the model*, never through code.
The strategy is precise about it:

    "Exploding Topics' ``peaked`` classification (looked up via
    ``descriptor.query``) and GDELT article breadth are required context on
    the verdict. ``peaked`` argues against high confidence; nothing is
    mechanically excluded; an ET miss carries no penalty."

That sentence rules out the obvious implementation. A ``peaked`` multiplier,
a breadth-scaled discount, or a "drop it if the world already piled on" rule
would each be a new mechanical gate, which the strategy says "requires a
decision, not a commit". So the saturation readings are rendered into a
second, cheap turn: the agent is shown what it already claimed plus what the
two oracles said, and restates its own confidence and reasoning. Code carries
the model's number across verbatim -- there is no arithmetic on confidence
anywhere in this package.

Why a second turn rather than folding saturation into the generation prompt:
the lookups are keyed by the *subject descriptor*, which does not exist until
the model has proposed it. One batched call weighs every surviving candidate
in a run, so the pass costs one extra request, not one per prediction.

Everything here is pure -- no clock, no network, no warehouse -- so the
prompt is diffable in review and assertable in a test, matching
generation/prompt.py.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..domain.claim import MAX_LENGTHS
from ..generation.parse import extract_json_object
from .lookup import (
    CLASSIFICATION_PEAKED,
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    MISS_NOT_IN_CATALOG,
    ArticleBreadth,
    SaturationLookup,
)

#: A stable phrase in the weighing system prompt. Not decoration: the fleet's
#: fakes and the local loop both need to tell which of the two turns they are
#: being asked, and matching on a named constant is better than matching on a
#: sentence someone will later reword.
WEIGHING_MARKER = "saturation weighing pass"


class UnparseableWeighing(ValueError):
    """The weighing reply was not the JSON object the prompt asked for. The
    caller degrades to the unweighed verdict -- it never fails the run."""


@dataclass(frozen=True)
class WeighingItem:
    """One candidate as the weighing turn sees it: what was claimed, at what
    confidence, and what the two oracles said about the subject."""

    subject_descriptor: str
    directional_claim: str
    horizon_band: str
    observable_check: str
    confidence: float
    reasoning: str
    lookup: SaturationLookup
    reading: ArticleBreadth


@dataclass(frozen=True)
class Weighing:
    """The model's restatement for one item. ``confidence`` is whatever it
    said -- higher, lower or identical."""

    confidence: float
    reasoning: str


_MISS_WORDING = {
    MISS_NOT_IN_CATALOG: (
        "Exploding Topics has no entry for this subject. This is a MISS and it is "
        "NOT evidence against the claim -- ET's catalog skews away from local and "
        "news-driven topics. Do not lower your confidence because of it."
    ),
    MISS_NOT_CONFIGURED: (
        "Exploding Topics was not consulted for this run (no API access configured). "
        "This is a MISS and carries no weight in either direction."
    ),
    MISS_LOOKUP_FAILED: (
        "The Exploding Topics lookup could not be completed (the provider was "
        "unreachable or refused the request). This is a MISS -- we do not know what "
        "ET would have said -- and it carries no weight in either direction."
    ),
}


def render_et(lookup: SaturationLookup) -> str:
    if not lookup.matched:
        wording = _MISS_WORDING.get(
            lookup.miss_reason or MISS_NOT_IN_CATALOG, _MISS_WORDING[MISS_NOT_IN_CATALOG]
        )
        detail = f" [{lookup.error}]" if lookup.error else ""
        return f"    exploding topics: MISS{detail}. {wording}"

    lines = [
        f"    exploding topics: matched {lookup.keyword!r}"
        f" ({lookup.total} fuzzy result(s) for {lookup.query!r})"
    ]
    lines.append(f"      12-month classification: {lookup.classification or 'unreported'}")
    if lookup.classifications:
        per_timeframe = ", ".join(
            f"{k}mo={v}" for k, v in lookup.classifications.items() if isinstance(v, str)
        )
        if per_timeframe:
            lines.append(f"      by timeframe: {per_timeframe}")
    if lookup.growth:
        growth = ", ".join(f"{k}={v}" for k, v in lookup.growth.items())
        lines.append(f"      growth: {growth}")
    if lookup.absolute_volume is not None:
        lines.append(f"      searches last month: {lookup.absolute_volume}")
    lines.append(
        "      ET's search is FUZZY. Judge whether the matched keyword is genuinely "
        "the same concept as the subject before you let it move anything."
    )
    return "\n".join(lines)


def render_breadth(reading: ArticleBreadth) -> str:
    if not reading.available:
        return (
            f"    gdelt article breadth: UNAVAILABLE [{reading.error or 'unknown'}]. "
            "We could not look. This is NOT a reading of zero coverage and carries no "
            "weight in either direction."
        )
    domains = ", ".join(reading.top_domains) if reading.top_domains else "none"
    return (
        f"    gdelt article breadth: {reading.article_count} article(s) across "
        f"{reading.distinct_domains} distinct publisher(s) in the last "
        f"{reading.window_days} day(s)\n"
        f"      publishers: {domains}"
    )


def build_weighing_system_prompt() -> str:
    """The weighing turn's standing instructions. Pure -- same string every
    time."""
    return f"""You are the Trend Tree prediction agent, {WEIGHING_MARKER}.

You have already made a set of falsifiable calls from the signal corpus. You
are now shown, for each call, two EXTERNAL readings about the same subject:
Exploding Topics' classification and GDELT's news-article breadth. Your job is
to restate your confidence and your reasoning with those readings in view.

WHAT SATURATION MEANS HERE

  The queue's promise is EARLINESS. Saturation tells you how far along the
  world already is on this subject -- not whether the subject is real.

  - "{CLASSIFICATION_PEAKED}" ARGUES AGAINST high confidence: if ET says the
    subject has already peaked, the window your claim depends on may be
    closing or closed. Say so, and let it move your number if you find it
    persuasive.
  - "exploding" says the movement is underway right now. That can cut either
    way: it corroborates that the subject is real, and it shortens the runway
    for a claim about what happens NEXT.
  - "regular" says ET sees steady, unremarkable interest.
  - BROAD GDELT breadth -- many articles across many distinct publishers --
    means the news world has already piled on. A claim that mainstream
    attention is coming is weaker when mainstream attention is already here.
    Narrow or zero breadth is compatible with being early.

WHAT SATURATION DOES NOT DO

  - Nothing is excluded. There is no verdict you can return that drops a
    prediction, and nothing downstream will drop one for you. Every call you
    are shown gets written down with whatever confidence you give it.
  - An Exploding Topics MISS is NOT evidence against a claim. ET's catalog
    skews away from local and news-driven subjects, so a subject it has never
    heard of is entirely normal. Do not lower a number for a miss, and do not
    write reasoning that treats a miss as a warning sign.
  - An UNAVAILABLE reading is not a reading of zero. If a lookup could not be
    performed, weigh nothing from it in either direction.
  - Your confidence is YOURS. No code adjusts the number you return, in
    either direction. If saturation does not change your view, return the
    same number and say why it did not.

CONFIDENCE
  Same calibrated 0-100 scale you used to make the call: your honest
  probability, times 100, that the observable check comes back TRUE at the
  horizon date.

REASONING
  Rewrite the reasoning for each call so it ADDRESSES the saturation evidence
  explicitly -- name what ET said (including a miss) and what the article
  breadth showed, and say what it did or did not change. This text is shown to
  a strategist deciding whether to believe us, so it must stand on its own:
  keep the substance of the original reasoning and fold the saturation reading
  into it. Do not write "as above" or refer to a previous version.

OUTPUT
  Reply with JSON only -- a single object, no prose around it, no code fence.
  One entry per call you were shown, using the same id:

  {{
    "weighings": [
      {{"id": 1, "confidence": 0-100, "reasoning": "..."}}
    ]
  }}

  Omitting an id leaves that call exactly as it was."""


def build_weighing_user_prompt(items: Sequence[WeighingItem]) -> str:
    """The calls plus their saturation readings. Pure."""
    if not items:
        raise ValueError("the weighing pass needs at least one item")
    blocks = []
    for index, item in enumerate(items, 1):
        blocks.append(
            "\n".join(
                [
                    f"  [{index}] subject: {item.subject_descriptor}",
                    f"      claim: {item.directional_claim}",
                    f"      horizon: {item.horizon_band}",
                    f"      observable check: {item.observable_check}",
                    f"      your confidence: {item.confidence}",
                    f"      your reasoning: {item.reasoning}",
                    "      SATURATION EVIDENCE:",
                    render_et(item.lookup),
                    render_breadth(item.reading),
                ]
            )
        )
    body = "\n\n".join(blocks)
    return f"""YOUR CALLS AND THEIR SATURATION EVIDENCE -- {len(items)} call(s).

{body}

Restate confidence and reasoning for each id. Every call is written down
either way; a "{CLASSIFICATION_PEAKED}" reading argues against high confidence,
it does not remove anything. An Exploding Topics miss costs nothing.

JSON only."""


def _confidence(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 100 else None


def parse_weighings(text: str, *, count: int) -> dict[int, Weighing]:
    """Parse the weighing reply into ``{1-based id: Weighing}``.

    Anything malformed is simply absent from the returned map, and an absent
    id means the caller keeps that verdict exactly as generation left it --
    which is the only safe degradation: a parser that invented a number would
    be the mechanical discount this whole design is avoiding.
    """
    payload = extract_json_object(text)
    raw = payload.get("weighings")
    if raw is None:
        raise UnparseableWeighing("weighing reply has no 'weighings' key")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise UnparseableWeighing(
            f"'weighings' must be a list, got {type(raw).__name__}"
        )

    out: dict[int, Weighing] = {}
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
        confidence = _confidence(entry.get("confidence"))
        reasoning = entry.get("reasoning")
        reasoning = reasoning.strip() if isinstance(reasoning, str) else ""
        if confidence is None or not reasoning:
            continue
        if len(reasoning) > MAX_LENGTHS["reasoning"]:
            reasoning = reasoning[: MAX_LENGTHS["reasoning"]].rstrip()
        out[index] = Weighing(confidence=confidence, reasoning=reasoning)
    return out
