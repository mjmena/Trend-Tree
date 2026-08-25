"""Appending verdicts to the ledger (CRMA-766).

The MERGE itself lives in ``domain/ledger.py``; this is the loop around it,
extracted so the sweep route -- which writes two batches in one request, from
two phases with different failure semantics -- does not carry its own copy.

Two properties it holds, both inherited from the routes that already do this
by hand:

* **A partial batch is real history.** The ledger is append-only, and rows
  that landed before a failure stay. The report says how many, so the caller
  can say so out loud rather than implying an all-or-nothing write.
* **rows == 0 is not a failure.** It means the MERGE matched an id already in
  the ledger: a retried attempt whose predecessor had committed. Exactly one
  row exists either way; this attempt just is not the one that put it there.

No FastAPI here on purpose -- this raises its own exception and the route
decides what HTTP that is, because "the sweep failed after 3 of 6 rows" and
"generation failed after 0 of 2" are not the same message.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field

from .domain.claim import Verdict
from .domain.ledger import MERGE_VERDICT, insert_params

log = logging.getLogger(__name__)


class VerdictWriteFailed(RuntimeError):
    """A verdict MERGE failed after the shared client exhausted its retries.
    Carries how far the batch got, because the rows that landed stay."""

    def __init__(self, *, written: int, total: int, prediction_eval_id: str) -> None:
        super().__init__(
            f"verdict write failed after {written} of {total} row(s) landed; "
            f"the ledger keeps them (failed on {prediction_eval_id})"
        )
        self.written = written
        self.total = total
        self.prediction_eval_id = prediction_eval_id


class LedgerWriter:
    """Something that can run the verdict MERGE. Narrowed to the one method
    this module uses."""

    def execute(self, sql: str, params: dict) -> int:  # pragma: no cover - Protocol-ish
        raise NotImplementedError


@dataclass(frozen=True)
class WriteReport:
    #: PREDICTION_EVAL_IDs this call actually inserted.
    written: set[str] = field(default_factory=set)
    #: PREDICTION_EVAL_IDs whose MERGE matched an existing row -- a
    #: deduplicated retry, not a failure.
    deduplicated: set[str] = field(default_factory=set)

    def __len__(self) -> int:
        return len(self.written)


def write_verdicts(
    client, table: str, verdicts: Sequence[Verdict], *, chain_id: str
) -> WriteReport:
    """MERGE each verdict, in order. Raises ``VerdictWriteFailed`` on the
    first failure, having kept whatever landed before it."""
    written: set[str] = set()
    deduplicated: set[str] = set()
    for verdict in verdicts:
        try:
            rows = client.execute(MERGE_VERDICT.format(table=table), insert_params(verdict))
        except Exception as err:
            log.exception(
                "verdict write failed",
                extra={
                    "chain_id": chain_id,
                    "prediction_eval_id": verdict.prediction_eval_id,
                },
            )
            raise VerdictWriteFailed(
                written=len(written),
                total=len(verdicts),
                prediction_eval_id=verdict.prediction_eval_id,
            ) from err
        if rows > 0:
            written.add(verdict.prediction_eval_id)
        else:
            deduplicated.add(verdict.prediction_eval_id)
            log.info(
                "verdict write was a no-op (this evaluation is already in the ledger)",
                extra={
                    "chain_id": chain_id,
                    "prediction_eval_id": verdict.prediction_eval_id,
                },
            )
    return WriteReport(written=written, deduplicated=deduplicated)
