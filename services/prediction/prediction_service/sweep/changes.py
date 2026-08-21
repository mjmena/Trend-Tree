"""WHAT_CHANGED -- what moved since the prior evaluation (CRMA-766 AC3).

The user story is "a 'what changed' note on every re-evaluation, so that I
can see why confidence moved since I last looked". So this text has one job:
name the differences between this row and the previous row for the same
PREDICTION_ID, in a sentence a strategist reads.

**It is composed, not generated.** The note has a deterministic spine --
confidence direction and delta, status transition, match change, evidence
change -- built here from the two rows, with the model's own sentence
appended when there is one. That ordering is deliberate:

* a sweep with no model configured, or one whose model call failed, still
  writes a truthful WHAT_CHANGED rather than a NULL or a shrug;
* the facts in the note are the facts in the ledger, so the note cannot
  claim a movement the columns do not show;
* the model gets to say *why*, which is the part it is actually better at,
  and its sentence is clearly the tail rather than the whole thing.

Nothing here is stored beyond the composed string. In particular the
direction word is computed at composition time from the two confidences
(sweep/direction.py) -- there is no direction column, by decision.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.claim import MAX_LENGTHS
from .direction import (
    FIRST_EVALUATION,
    UNCHANGED,
    confidence_delta,
    confidence_direction,
)

#: What the note says when a re-evaluation genuinely moved nothing. Said out
#: loud rather than left empty: "nothing changed" is information, and an
#: empty WHAT_CHANGED reads as "the sweep did not run".
NOTHING_MOVED = "Nothing moved since the previous evaluation"


def _confidence_clause(prior: float | None, current: float) -> tuple[str | None, str | None]:
    """``(movement, held)``.

    Split because "confidence held at 68.0" is a fact about this row but not
    a *change*, and a note whose only content was a thing that did not move
    would answer "what changed?" with something that did not. So it is
    carried alongside the movements and only leads the sentence when there
    are none.
    """
    direction = confidence_direction(prior, current)
    if direction == FIRST_EVALUATION:
        return None, None
    if direction == UNCHANGED:
        return None, f"confidence held at {current:.1f}"
    delta = confidence_delta(prior, current)
    sign = "+" if (delta or 0) > 0 else ""
    return (
        f"Confidence {direction} from {float(prior or 0):.1f} to {current:.1f} "
        f"({sign}{delta})",
        None,
    )


def _status_clause(prior_status: str, status: str, reason: str) -> str | None:
    if (prior_status or "").upper() == (status or "").upper():
        return None
    return f"Status moved {prior_status.upper()} -> {status.upper()}: {reason}"


def _match_clause(
    prior_trend_id: str | None, trend_id: str | None, topic: str | None
) -> str | None:
    if prior_trend_id == trend_id:
        return None
    if prior_trend_id is None and trend_id is not None:
        named = f' ("{topic}")' if topic else ""
        return f"No longer white space: the subject now matches trend {trend_id}{named}"
    if prior_trend_id is not None and trend_id is None:
        return (
            f"Back to white space: the subject no longer matches trend {prior_trend_id} "
            "(the trend pipeline moved, the claim did not)"
        )
    return f"Matched trend changed from {prior_trend_id} to {trend_id}"


def compose_what_changed(
    *,
    prior_confidence: float | None,
    confidence: float,
    prior_status: str,
    status: str,
    status_reason: str,
    prior_trend_id: str | None = None,
    trend_id: str | None = None,
    trend_topic: str | None = None,
    evidence_notes: Sequence[str] = (),
    model_note: str | None = None,
    observation_rationale: str | None = None,
) -> str:
    """The composed note. Never empty, never longer than the column.

    Clause order is the order a reader cares about: what the call now says
    (confidence), what state it is in (status), what it is about (the match),
    then the evidence and the model's explanation.
    """
    clauses: list[str] = []
    movement, held = _confidence_clause(prior_confidence, confidence)
    if movement:
        clauses.append(movement)
    status_clause = _status_clause(prior_status, status, status_reason)
    if status_clause:
        clauses.append(status_clause)
    match_clause = _match_clause(prior_trend_id, trend_id, trend_topic)
    if match_clause:
        clauses.append(match_clause)
    clauses.extend(note for note in evidence_notes if note and note.strip())

    if clauses:
        if held:
            clauses.append(held.capitalize())
    else:
        # Nothing moved -- but the observable check was still read, and
        # saying what it read is the difference between "we looked and
        # nothing had changed" and "nobody looked".
        tail = "; ".join(part for part in (held, observation_rationale) if part)
        clauses.append(f"{NOTHING_MOVED}{': ' + tail if tail else ''}")

    note = ". ".join(clause.rstrip(". ") for clause in clauses) + "."
    if model_note and model_note.strip():
        note = f"{note} {model_note.strip()}"
    limit = MAX_LENGTHS["what_changed"]
    if len(note) > limit:
        note = note[: limit - 1].rstrip() + "…"
    return note
