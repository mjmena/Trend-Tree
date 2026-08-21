"""Prompt builders for the generation phase -- pure functions (CRMA-763).

Nothing here does I/O, reads a clock, or touches a warehouse. That is the
point: the PRD's local loop calls for "extracted prompt builders and the
grading/projection SQL get fast unit tests", so prompt quality iterates under
``pytest`` rather than through a deploy.

Everything the prompt asserts traces to a decision, not to taste:

* the falsifiable 4-part claim and "a topic without a claim is never emitted"
  -- strategy doc §2;
* the subject's register -- ADR-0003 (atomic, consumer-vernacular noun);
* the five emergence paths and "convergence multiplies confidence and never
  gates eligibility" -- strategy doc §3/§4;
* the four controlled horizon bands -- strategy doc §7.5, mirrored by
  ``domain.claim._HORIZON_BAND_DAYS``;
* what REASONING has to address -- the methodology's six scoring dimensions,
  strategy doc §5.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.claim import HORIZON_BANDS
from .signals import SignalRecord

#: How much of a signal's body reaches the prompt. Long-enough to carry the
#: specific behavior, short enough that a capped corpus stays in the
#: sub-200k-token pricing tier.
SIGNAL_TEXT_CHARS = 400

#: The methodology's five emergence paths (strategy §3). Four of the five do
#: not start from an existing trend -- which is why generation can be blind
#: to the trend tables without losing reach.
EMERGENCE_PATHS: tuple[tuple[str, str], ...] = (
    (
        "signal convergence",
        "several independent signals, ideally from different sources, point at the same "
        "underlying shift. Convergence MULTIPLIES your confidence. It NEVER gates "
        "eligibility: a claim supported by one strong signal is emittable, and a claim "
        "supported by ten weak ones is not automatically strong. Evidence quality beats "
        "signal counts.",
    ),
    (
        "high-potential single signal",
        "one signal is strong enough on its own -- a specific, verifiable behavior or "
        "product with a plausible path to spreading. Do not discard it for lacking company.",
    ),
    (
        "cross-category transfer",
        "a behavior established in one category shows early evidence of moving into "
        "another (a skincare ingredient appearing in haircare, a fitness practice "
        "appearing in travel).",
    ),
    (
        "structural-enabling change",
        "something changed in the conditions -- price, regulation, distribution, "
        "platform, supply -- that makes a consumer behavior newly possible or newly "
        "cheap. The behavior may not be visible yet; the enabling change is.",
    ),
    (
        "pattern break",
        "an established pattern stops holding: a reliable seasonal rhythm misfires, a "
        "dominant format loses ground, a taken-for-granted preference inverts.",
    ),
)

#: What the verdict's REASONING must address (strategy §5) -- the
#: methodology's six scoring dimensions, as prose, not a parallel numeric
#: rubric.
REASONING_DIMENSIONS: tuple[str, ...] = (
    "cultural relevance",
    "white space",
    "plausibility",
    "evidence breadth",
    "cross-category potential",
    "consumer interest",
)


def _horizon_band_lines() -> str:
    labels = {
        "near_term_1_3mo": "near term, 1-3 months",
        "emerging_3_6mo": "emerging, 3-6 months",
        "cultural_shift_6_12mo": "cultural shift, 6-12 months",
        "longer_range_12_24mo": "longer range, 12-24 months",
    }
    return "\n".join(f"  - {band}  ({labels[band]})" for band in HORIZON_BANDS)


def _emergence_path_lines() -> str:
    return "\n".join(f"  {i}. {name} - {body}" for i, (name, body) in enumerate(EMERGENCE_PATHS, 1))


def build_system_prompt() -> str:
    """The generation agent's standing instructions. Pure: same string every
    time, so it is diffable in review and assertable in a test."""
    return f"""You are the Trend Tree prediction agent, generation phase.

A trend says "something is happening NOW". A prediction says "we think this
happens NEXT". You make explicit, falsifiable calls about what happens next,
from a corpus of raw cultural signals.

You are reading the signal corpus alone. You cannot see which trends the
pipeline has already promoted, how hot they are, or where they sit in their
lifecycle, and you must not speculate about any of that. Your job is to read
the world, not our opinion of it.

WHAT QUALIFIES AS A PREDICTION

  emerging evidence + cultural implication + meaningful white space + plausible outcome

  - If the thing is already obvious, it is a trend, not a prediction. Skip it.
  - If there is no credible evidence in the corpus, it is speculation. Skip it.
  - Predictions lean cultural -- identity, community, fandom, taste. Utility
    signals count when they create the conditions for behavioral change.

THE FIVE EMERGENCE PATHS -- what you are looking for

{_emergence_path_lines()}

EVERY PREDICTION IS A FALSIFIABLE 4-PART CLAIM

  1. subject_descriptor -- an ATOMIC, consumer-vernacular noun: the
     ingredient, product, or practice a shopper would actually search for
     ("snail mucin", "rucking vests", "head spa"). NOT a compound behavior,
     NOT a coined marketing label, NOT industry jargon ("retailtainment",
     "agentic commerce"), NOT a category heading ("Food and Beverage Trends"),
     and NOT freshly-minted internet slang. Machine-facing register: no
     flavor, no call to action.
  2. directional_claim -- what CHANGES in the world, stated directionally
     ("mainstream retail adoption expands beyond specialty fitness"). This is
     the part that makes the call gradable.
  3. horizon_band -- exactly one of the four controlled bands below.
  4. observable_check -- what someone would LOOK AT later to grade the claim
     ("major-retailer listings + sustained search-interest growth"). Name
     observable quantities, not feelings.

  A topic with no directional claim -- "targeted supplement stacking",
  "wellness is growing" -- is NEVER emitted, however confident you feel. If
  you cannot state what changes and how you would check it, drop the topic
  and move on. Emitting fewer, sharper claims is the correct outcome; padding
  the list is a failure.

HORIZON BANDS (controlled vocabulary -- use the exact left-hand string)
{_horizon_band_lines()}

CONFIDENCE
  A calibrated number from 0 to 100. Convergence multiplies it; a single
  strong signal does not cap it; nothing about our own pipeline's attention
  enters it. Reserve the top of the range for claims you would defend.

EVIDENCE
  Cite the signal ids that actually drove the call, from the corpus you were
  given, verbatim. Never invent an id. A claim whose ids you cannot name is a
  claim you should not emit.

REASONING
  A few sentences addressing: {", ".join(REASONING_DIMENSIONS)}.
  Say what the evidence is and why it supports THIS claim -- this text is
  shown to a strategist deciding whether to believe you.

OUTPUT
  Reply with JSON only -- a single object, no prose around it, no code fence:

  {{
    "predictions": [
      {{
        "subject_descriptor": "...",
        "directional_claim": "...",
        "horizon_band": "one of the four bands above",
        "observable_check": "...",
        "confidence": 0-100,
        "reasoning": "...",
        "emergence_path": "one of the five path names above",
        "source_signals": ["signal id", "signal id"]
      }}
    ]
  }}

  An empty "predictions" list is a valid, honest answer when the corpus does
  not support a falsifiable call."""


def render_signal(signal: SignalRecord, *, text_chars: int = SIGNAL_TEXT_CHARS) -> str:
    """One corpus line. Ids are quoted so the model can echo them back
    verbatim into ``source_signals``."""
    body = (signal.signal_text or "").strip().replace("\n", " ")
    if len(body) > text_chars:
        body = body[:text_chars].rstrip() + "..."
    when = signal.signal_timestamp or "unknown time"
    parts = [f'- id="{signal.signal_id}" source={signal.source_name} at={when}']
    parts.append(f"  title: {signal.signal_title.strip()}")
    if body:
        parts.append(f"  text: {body}")
    return "\n".join(parts)


def build_user_prompt(
    signals: Sequence[SignalRecord],
    *,
    max_predictions: int,
    text_chars: int = SIGNAL_TEXT_CHARS,
) -> str:
    """The corpus plus this run's cap. Pure -- no clock, no warehouse."""
    if max_predictions < 1:
        raise ValueError(f"max_predictions must be at least 1, got {max_predictions}")
    corpus = "\n".join(render_signal(s, text_chars=text_chars) for s in signals)
    if not corpus:
        corpus = "(the corpus slice for this run is empty)"
    return f"""SIGNAL CORPUS -- {len(signals)} signal(s), the whole of what you can see:

{corpus}

Emit AT MOST {max_predictions} prediction(s), ordered by how strongly the
corpus supports them. Fewer is correct when the evidence is thin; an empty
list is correct when nothing in the corpus supports a falsifiable claim.
Every source_signals id must appear verbatim in the corpus above.

JSON only."""
