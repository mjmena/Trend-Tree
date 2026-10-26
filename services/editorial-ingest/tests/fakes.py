"""Fakes for the editorial-ingest route tests: no network, no Cloud Tasks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from editorial_ingest.tasks import EnqueueError


@dataclass
class FakeTaskQueue:
    """Holds tasks by name. Refuses a second task with a name it already
    holds, as Cloud Tasks does."""

    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail: bool = False

    def enqueue(self, name: str, payload: dict[str, Any]) -> bool:
        if self.fail:
            raise EnqueueError("queue unavailable")
        if name in self.tasks:
            return False
        self.tasks[name] = payload
        return True


def fake_fetch(statuses: dict[str, int | Exception]):
    """A URL fetcher answering from a table: url -> HTTP status, or an
    exception to raise (a network error / timeout). Unknown URLs answer 200."""

    def fetch(url: str) -> tuple[str, int]:
        answer = statuses.get(url, 200)
        if isinstance(answer, Exception):
            raise answer
        return url, answer

    return fetch
