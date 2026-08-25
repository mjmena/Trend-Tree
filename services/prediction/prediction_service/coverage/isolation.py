"""What the coverage phase may reach, and in which direction (CRMA-767).

Coverage detection is the one part of the pillar that reads a McClatchy-owned
table -- ``MCC_RAW.STORY_DATA.CUE_CONTENT_VECTORS``, the data team's story
embeddings. CONTEXT.md's **evidence purity** invariant is what makes that
delicate:

    "System-authored content (predictions, coverage detections) may inform
    agents as *context*, never enter as *evidence*: no pipeline-derived row
    enters ``FCT_SIGNALS`` or ``STG_EXTERNAL_SIGNALS``."

So this guard says two things, and the second is the one this story added.

1. **One statement, a read, and only granted objects.** Delegated to
   ``matching.isolation.assert_matching_sql`` rather than re-implemented:
   the checks are identical, and a third copy of the same regexes would be a
   third thing to keep in step. Violations are re-raised as
   ``CoverageIsolationViolation`` so a caller can tell which phase tripped.
2. **A denylist on top of the allowlist.** The allowlist already refuses an
   ungranted object, so this is belt-and-braces -- deliberately. AC5 names
   the tables by hand ("no coverage-derived row is written to
   ``STG_EXTERNAL_SIGNALS``, ``FCT_SIGNALS``, or any trend-scoring path"),
   and an allowlist protects that only as long as nobody widens it. A
   grant of ``FCT_SIGNALS`` is refused here whatever the call site says,
   which turns a plausible future edit -- "coverage would be better if it
   also read the signal corpus" -- into a failing test rather than a quiet
   breach of the isolation invariant.

Note what neither check has to cover: this package cannot write at all. The
read-only check means no INSERT, UPDATE, MERGE, DELETE or CREATE can be
issued from the coverage phase, so "no coverage-derived row is written to a
signals table" is not a rule anyone has to remember -- it is a thing the code
has no capability to do.
"""

from __future__ import annotations

import re

from ..matching.isolation import MatchingIsolationViolation, assert_matching_sql

#: The objects a coverage statement may never name, whatever it was granted.
#: The signal corpus and its staging table (evidence purity, CONTEXT.md), and
#: every trend-scoring surface (the PRD's isolation invariants: "prediction
#: outputs never influence HEAT_INDEX, LIFECYCLE_STATUS, or any other scoring
#: path"). Matched as substrings against the statement's own text, so
#: ``FCT_TREND_`` covers every ledger in the family without listing them.
COVERAGE_FORBIDDEN_TOKENS: tuple[str, ...] = (
    "STG_EXTERNAL_SIGNALS",
    "FCT_SIGNALS",
    "FCT_TRENDS",
    "FCT_TREND_",
    "STG_TREND_CANDIDATES",
    "DT_TREND_DASHBOARD",
    "HEAT_INDEX",
    "LIFECYCLE_STATUS",
)

_COMMENT_LINE = re.compile(r"--[^\n]*")
_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)


class CoverageIsolationViolation(RuntimeError):
    """A coverage statement tried to write, or reached an object the coverage
    phase may not read. Raised *before* the statement is issued."""


def assert_coverage_sql(sql: str, *, allowed_tables: tuple[str, ...]) -> None:
    """Raise ``CoverageIsolationViolation`` unless ``sql`` is a single read of
    granted, non-forbidden objects. Called by every coverage adapter before it
    hands a statement to a warehouse client."""
    try:
        assert_matching_sql(sql, allowed_tables=allowed_tables)
    except MatchingIsolationViolation as err:
        raise CoverageIsolationViolation(str(err)) from err

    # Checked against the grant too, not only the statement: a call site that
    # granted a forbidden object is the failure worth catching early, even if
    # the statement it happens to issue today never reads it.
    body = _COMMENT_BLOCK.sub(" ", _COMMENT_LINE.sub(" ", sql)).upper()
    haystack = body + " " + " ".join(name.upper() for name in allowed_tables)
    named = sorted({token for token in COVERAGE_FORBIDDEN_TOKENS if token in haystack})
    if named:
        raise CoverageIsolationViolation(
            "the coverage phase may not touch the signal corpus or any trend-scoring "
            f"object (evidence purity, CONTEXT.md); this statement or its grant names "
            f"{named}. Coverage detection reads published-content embeddings and nothing else."
        )
