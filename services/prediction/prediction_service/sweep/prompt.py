"""The re-evaluation turn -- pure prompt builders (CRMA-766).

One batched call re-evaluates every live prediction in a sweep. It asks two
things at once, because they are one judgement:

* **has the observable check settled?** -- ``met`` / ``failed`` /
  ``not_yet``. This is what drives RESOLVED_TRUE and RESOLVED_FALSE; the
  status machine (sweep/lifecycle.py) does the rest.
* **what is your confidence now, and what moved?** -- restated with the
  refreshed evidence in view.

The claim is shown but is NOT up for revision, and the prompt says so
explicitly. The four claim parts are frozen at mint and the sweep carries
them forward byte-identically; a model asked to "update the prediction"
would happily reword the directional claim, and a reworded claim is an
unfalsifiable one, because the thing being judged would have moved under the
judging.

Same discipline as saturation/weigh.py: code carries the model's number
across verbatim and never adjusts one, entries are bound to the call they
name rather than to their list position, and an absent or malformed entry
leaves that prediction exactly as the prior row left it. The binding key is
the PREDICTION_ID -- shown here and echoed back -- because two live calls can
share a subject descriptor but never an id (sweep/parse.py).

Everything here is pure -- no clock, no network, no warehouse.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .lifecycle import OBSERVED_FAILED, OBSERVED_MET, OBSERVED_NOT_YET

#: A stable phrase in the system prompt. The fakes and the local loop tell
#: this turn apart from generation's and from the saturation weighing turn by
#: matching on it -- same reason WEIGHING_MARKER exists.
REEVALUATION_MARKER = "prediction re-evaluation sweep"


@dataclass(frozen=True)
class ReevaluationItem:
    """One live prediction as the re-evaluation turn sees it: the frozen
    claim, where it stands, and what the refreshed evidence says."""

    prediction_id: str
    subject_descriptor: str
    directional_claim: str
    horizon_band: str
    observable_check: str
    horizon_at: str
    status: str
    confidence: float
    reasoning: str
    #: Days from this evaluation to HORIZON_AT. Negative once past it.
    days_to_horizon: float
    #: Days of grace left before the re-checks stop. Only meaningful past the
    #: horizon, and rendered only then.
    days_of_grace_left: float
    matched_trend_topic: str | None = None
    trend_context: dict[str, Any] | None = None
    saturation: str | None = None


def build_system_prompt() -> str:
    """The re-evaluation turn's standing instructions. Pure -- same string
    every time."""
    return f"""You are the Trend Tree prediction agent, {REEVALUATION_MARKER}.

Every call you made is written down in an append-only ledger, one row per
evaluation. You are now re-evaluating the calls that are still live. For each
one you are shown the claim exactly as it was minted, the confidence and
reasoning you last recorded, how close the horizon is, and the current
evidence.

THE CLAIM IS FROZEN. DO NOT REWRITE IT.

  The subject, the directional claim, the horizon date and the observable
  check were fixed when the call was minted, and they are what makes the call
  falsifiable. You are judging that claim, not editing it. Nothing you return
  can change any of the four -- there is no field for it, and any wording you
  offer is discarded. If you now think the claim was badly framed, say so in
  your reasoning and let your confidence carry it.

WHAT YOU DECIDE

1. HAS THE OBSERVABLE CHECK SETTLED?

   Read the observable check literally. It names what we look at to grade the
   claim.

   - "{OBSERVED_MET}"      the check now reads TRUE. The thing it names has
                    happened. Use this only when the evidence in front of you
                    actually shows it -- this closes the call permanently.
   - "{OBSERVED_FAILED}"   the check is settled AGAINST the claim: what it names
                    can no longer happen, or the world has clearly moved the
                    other way. Also permanent, so hold it to the same bar.
   - "{OBSERVED_NOT_YET}"  everything else, including "we cannot tell from what we
                    can see". This is the honest default. A call past its
                    horizon is NOT automatically failed -- it expires, and it
                    keeps being re-checked for one further horizon length,
                    precisely so a late truth reads as late rather than wrong.

   A missing or unreadable oracle is never evidence that a check failed. If
   you could not look, the answer is "{OBSERVED_NOT_YET}".

2. CONFIDENCE, NOW.

   The same calibrated 0-100 scale: your honest probability, times 100, that
   the observable check comes back TRUE at (or by) the horizon date. Move it
   if the evidence moved; hold it if it did not, and say why it did not. No
   code adjusts the number you return, in either direction. Time passing is
   itself information: a claim with three weeks of horizon left and no
   movement is weaker than the same claim was six months out.

3. WHAT CHANGED, AND WHY.

   One or two sentences on what moved since the last evaluation and what
   moved it. The row already records the arithmetic -- the confidence delta,
   the status transition, whether the subject matched a trend -- so do not
   restate those. Explain them. If nothing moved, say what you re-checked and
   why it left the call where it was.

REASONING

  Rewrite the reasoning so it stands on its own for a strategist reading only
  this row: the case for the call as it looks today, with the current
  evidence folded in. Do not write "as above" or refer to a previous version.

OUTPUT
  Reply with JSON only -- a single object, no prose around it, no code fence.
  One entry per call you were shown, using the same id AND echoing that
  call's subject back verbatim:

  {{
    "reevaluations": [
      {{"id": 1, "prediction_id": "<the prediction_id shown for id 1, copied exactly>",
        "subject": "<the subject shown for id 1, copied exactly>",
        "observable_check": "{OBSERVED_NOT_YET}",
        "observation": "how you read the check, in one sentence",
        "confidence": 0-100,
        "reasoning": "...",
        "what_changed": "..."}}
    ]
  }}

  The "prediction_id" field is how your answer is bound to the call it is
  about. Copy it character for character. Two of the calls below can share a
  subject descriptor -- they can never share a prediction_id, which is why
  the id is what binds. Copy the subject verbatim too; it is checked against
  the prediction_id as a second opinion.

  Keep the "id" numbers as they were given to you -- do NOT renumber, re-sort
  or reorder the entries. An entry whose prediction_id does not match the one
  shown for its id is DISCARDED, and that call keeps the confidence and
  reasoning it already had.

  Omitting an id leaves that call's confidence and reasoning exactly as they
  were, and reads its observable check as "{OBSERVED_NOT_YET}"."""


def _horizon_line(item: ReevaluationItem) -> str:
    if item.days_to_horizon >= 0:
        return (
            f"      horizon: {item.horizon_at} ({item.horizon_band}) -- "
            f"{item.days_to_horizon:.1f} day(s) away"
        )
    if item.days_of_grace_left <= 0:
        # The grace window has closed. This row is the call's last, so the
        # prompt must not promise a re-check the sweep will never run.
        return (
            f"      horizon: {item.horizon_at} ({item.horizon_band}) -- PASSED "
            f"{abs(item.days_to_horizon):.1f} day(s) ago, and the one-horizon grace window "
            "has now closed. THIS IS THE FINAL RE-CHECK of this call: after it the row "
            "stands and the grade derived from it is final. A truth you can see NOW still "
            "resolves it TRUE."
        )
    return (
        f"      horizon: {item.horizon_at} ({item.horizon_band}) -- PASSED "
        f"{abs(item.days_to_horizon):.1f} day(s) ago. This call is EXPIRED and is being "
        f"re-checked for one further horizon length; {item.days_of_grace_left:.1f} day(s) "
        "of that grace window remain. A truth arriving now still resolves it TRUE."
    )


def build_user_prompt(items: Sequence[ReevaluationItem]) -> str:
    """The live calls plus their current evidence. Pure."""
    if not items:
        raise ValueError("the re-evaluation turn needs at least one live prediction")
    blocks = []
    for index, item in enumerate(items, 1):
        lines = [
            f"  [{index}] prediction_id: {item.prediction_id}",
            f"      subject: {item.subject_descriptor}",
            f"      claim: {item.directional_claim}",
            f"      observable check: {item.observable_check}",
            _horizon_line(item),
            f"      current status: {item.status}",
            f"      your last confidence: {item.confidence}",
            f"      your last reasoning: {item.reasoning}",
        ]
        if item.matched_trend_topic:
            lines.append(f"      matched trend: {item.matched_trend_topic}")
        else:
            lines.append(
                "      matched trend: none -- this is a white-space prediction "
                "(no trend in the pipeline covers this subject yet)"
            )
        if item.trend_context:
            rendered = ", ".join(
                f"{key}={value}"
                for key, value in item.trend_context.items()
                if key != "basis" and value is not None
            )
            if rendered:
                lines.append(f"      trend context: {rendered}")
        if item.saturation:
            lines.append("      SATURATION EVIDENCE:")
            lines.append(item.saturation)
        blocks.append("\n".join(lines))
    body = "\n\n".join(blocks)
    return f"""YOUR LIVE CALLS -- {len(items)}, each due for re-evaluation.

{body}

For each id: read the observable check, restate your confidence, rewrite your
reasoning, and say what changed. Echo each id's prediction_id verbatim (and
its subject). The claim itself is frozen and cannot be revised.

JSON only."""
