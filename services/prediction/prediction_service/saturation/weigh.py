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

**The binding key is the PREDICTION_ID, not the subject** (CRMA-765, found
during CRMA-766's review). A restatement has to be bound to the call it is
about, and SUBJECT_DESCRIPTOR is not an identity: generation dedupes on the
whole four-part claim (``generation/run.py``), so one reply can legitimately
mint two candidates that share a subject and differ in their directional
claim, and ``generation/parse.py`` enforces no subject uniqueness. Bound by
subject alone, a reply that returned those two entries swapped or renumbered
would write each call with the other's confidence and the other's reasoning
-- exactly the silent mislabelling this binding exists to prevent. So the
weighing turn is shown each call's PREDICTION_ID, which is an identity by
construction, and echoes it back. Same rule sweep/parse.py applies to the
re-evaluation reply, for the same reason.

One difference from the sweep, and it is deliberate. There the id is
mandatory; here an entry that echoes only the subject still binds **when that
subject is unique in the batch**, because then the subject identifies the
call exactly as well as the id does. It has to: a PREDICTION_ID is minted
fresh (uuid4) on the pass this turn is weighing, so a *recorded* reply -- the
offline loop's fixture, a route test's canned answer -- cannot possibly echo
one, and requiring it would make the whole pass permanently unexercisable
offline. When two calls in a batch do share a subject, the subject
distinguishes nothing and only the PREDICTION_ID binds.

Nothing here can drop, cap, discount or reorder a candidate: an unbound entry
means "keep generation's own confidence and reasoning", which is the same
place the pass leaves a call it never restated. The data-quality floor
(floor.py) remains the only mechanical gate in this package.

Everything here is pure -- no clock, no network, no warehouse -- so the
prompt is diffable in review and assertable in a test, matching
generation/prompt.py.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..domain.claim import MAX_LENGTHS
from ..generation.parse import extract_json_object
from .lookup import (
    CLASSIFICATION_PEAKED,
    ERROR_DEADLINE_EXCEEDED,
    ET_HEADLINE_TIMEFRAME,
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


def subject_key(subject: str) -> str:
    """The comparison form of a subject descriptor -- whitespace collapsed,
    case folded. Same rule generation/run.py's ``normalize_subject`` uses;
    spelled out here rather than imported so this module keeps its one
    property: pure, with no dependency on the generation phase."""
    return " ".join((subject or "").split()).casefold()


class UnparseableWeighing(ValueError):
    """The weighing reply was not the JSON object the prompt asked for. The
    caller degrades to the unweighed verdict -- it never fails the run."""


@dataclass(frozen=True)
class WeighingItem:
    """One candidate as the weighing turn sees it: what was claimed, at what
    confidence, and what the two oracles said about the subject."""

    #: The minted verdict's own identity, shown to the model and echoed back.
    #: This is what binds a restatement to a call; the subject cannot, because
    #: two calls in one run may share one. See the module docstring.
    prediction_id: str
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


#: A lookup the run never got to (the phase spent its wall-clock budget on
#: earlier subjects, see run.py). Worded separately from the transport failure
#: above because saying "the provider refused the request" of our own budget
#: would be the same kind of mislabelling the timeframe fix removes.
_DEADLINE_WORDING = (
    "Exploding Topics was not consulted for this subject: this run spent its lookup "
    "budget on earlier subjects. This is a MISS -- we did not look -- and it carries "
    "no weight in either direction."
)


def render_et(lookup: SaturationLookup) -> str:
    if not lookup.matched:
        wording = (
            _DEADLINE_WORDING
            if lookup.error == ERROR_DEADLINE_EXCEEDED
            else _MISS_WORDING.get(
                lookup.miss_reason or MISS_NOT_IN_CATALOG, _MISS_WORDING[MISS_NOT_IN_CATALOG]
            )
        )
        detail = f" [{lookup.error}]" if lookup.error else ""
        return f"    exploding topics: MISS{detail}. {wording}"

    lines = [
        f"    exploding topics: matched {lookup.keyword!r}"
        f" ({lookup.total} fuzzy result(s) for {lookup.query!r})"
    ]
    lines.append(_classification_line(lookup))
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
    others = [
        str(c.get("keyword"))
        for c in lookup.candidates
        if c.get("keyword") and str(c.get("keyword")) != (lookup.keyword or "")
    ]
    if others:
        listed = ", ".join(repr(other) for other in others)
        lines.append(f"      other fuzzy matches ET returned: {listed}")
    lines.append(
        "      ET's search is FUZZY. Judge whether the matched keyword is genuinely "
        "the same concept as the subject before you let it move anything."
    )
    return "\n".join(lines)


def _classification_line(lookup: SaturationLookup) -> str:
    """The headline classification, labelled with the timeframe it came from.

    ET does not always report a 12-month verdict, and ``lookup`` falls back to
    the shortest window it did report. Rendering that as "12-month" would put
    a claim about how far along the world is in front of the model that the
    oracle never made -- and ``peaked`` is the exact word this prompt says
    argues against high confidence.
    """
    if not lookup.classification:
        return "      classification: unreported"
    timeframe = lookup.classification_timeframe or ET_HEADLINE_TIMEFRAME
    line = f"      {timeframe}-month classification: {lookup.classification}"
    if timeframe != ET_HEADLINE_TIMEFRAME:
        line += (
            f" (ET reported no {ET_HEADLINE_TIMEFRAME}-month verdict; this is the "
            "shortest window it did report)"
        )
    return line


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
  One entry per call you were shown, using the same id AND echoing that call's
  subject back verbatim:

  {{
    "weighings": [
      {{"id": 1, "prediction_id": "<the prediction_id shown for id 1, copied exactly>",
        "subject": "<the subject shown for id 1, copied exactly>",
        "confidence": 0-100, "reasoning": "..."}}
    ]
  }}

  The "prediction_id" field is how your restatement is bound to the call it is
  about. Copy it character for character. Two of the calls below can share a
  subject descriptor -- they can never share a prediction_id, which is why the
  id is what binds. Copy the subject verbatim too; it is checked against the
  prediction_id as a second opinion.

  Keep the "id" numbers as they were given to you -- do NOT renumber, re-sort or reorder
  the entries. An entry whose prediction_id does not match the one shown for
  its id is DISCARDED, and so is one whose subject does not match the subject
  shown for its id. A discarded entry is not a rejected call: that call simply
  keeps the confidence and reasoning it already had.

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
                    f"  [{index}] prediction_id: {item.prediction_id}",
                    f"      subject: {item.subject_descriptor}",
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

Restate confidence and reasoning for each id, echoing that id's prediction_id
and that id's subject verbatim in its entry. Every call is written down either
way; a "{CLASSIFICATION_PEAKED}" reading argues against high confidence, it
does not remove anything. An Exploding Topics miss costs nothing.

JSON only."""


def _confidence(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 100 else None


def parse_weighings(
    text: str, *, prediction_ids: Sequence[str], subjects: Sequence[str]
) -> dict[int, Weighing]:
    """Parse the weighing reply into ``{1-based id: Weighing}``.

    Both sequences are the batch in the order it was rendered, so element 0 of
    each belongs to id 1. **An entry must name the call its id was shown
    against**, or it is dropped: the PREDICTION_ID it echoes must be that
    call's, the subject it echoes must be that call's, and between them they
    must actually pick that call out of the batch -- a subject two calls share
    does not, so those entries bind on the PREDICTION_ID or not at all.

    That is not a filter -- it is the only thing binding a restatement to the
    call it is about. Position alone is not: asked to "restate" a list, a
    model may perfectly reasonably return its entries re-sorted by its new
    confidence and renumbered 1..n. Read back by id, that writes each row with
    another call's confidence and a REASONING paragraph making another call's
    case -- every row still written, nothing dropped, nothing detectably wrong
    downstream. Mislabelled, silently. And the subject alone is not an
    identity either: two candidates in one run can share a subject and differ
    only in their directional claim (see the module docstring).

    An entry whose id and whose echoed identity disagree is dropped rather
    than reconciled -- choosing which of the two to believe would be the
    parser inventing a binding.

    Anything malformed or mismatched is simply absent from the returned map,
    and an absent id means the caller keeps that verdict exactly as generation
    left it -- which is the only safe degradation, and costs nothing: a parser
    that invented a number, or that trusted a position, would be the
    mechanical discount (or the silent mislabelling) this design avoids.
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
    # How many calls in THIS batch answer to each subject. More than one and
    # the subject identifies nothing, so only the PREDICTION_ID can bind.
    shared = Counter(expected.values())
    count = len(subjects)
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
        identity = entry.get("prediction_id")
        named_by_id = identity is not None
        if named_by_id and (
            not isinstance(identity, str) or identity.strip() != expected_id[index]
        ):
            # The entry names a different call than its id does. Two calls can
            # share a subject but never a PREDICTION_ID, so this is an
            # incoherent entry, not a recoverable one -- and keeping
            # generation's own number is the only option that cannot
            # mislabel one.
            continue
        subject = entry.get("subject")
        named_by_subject = subject is not None
        if named_by_subject and (
            not isinstance(subject, str) or subject_key(subject) != expected[index]
        ):
            continue
        if not named_by_id and (not named_by_subject or shared[expected[index]] > 1):
            # Nothing in the entry picks this call out of the batch: either
            # it never said which call it is about, or it named a subject
            # that more than one call in this batch answers to. Position is
            # not evidence that it belongs to any of them.
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
