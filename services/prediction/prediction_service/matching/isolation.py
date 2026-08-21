"""What the matching phase may reach, and in which direction (CRMA-764).

Matching is the mirror image of generation. Generation must not *see* trend
state; matching must see it -- that is the whole compare step -- but it must
never *write* anything, anywhere. So the guard here keeps the half of
``assert_generation_sql`` that still applies (one statement, a read, and
every FROM/JOIN target on an explicit allowlist) and drops the half that does
not (the trend/heat/lifecycle denylist, which matching's own queries would
trip on every call).

**This does not touch generation/blindness.py.** Reusing
``assert_generation_sql`` here would have meant loosening its denylist, and
that denylist is the load-bearing guarantee behind the PRD's "generation is
structurally blind to FCT_TRENDS, heat, and lifecycle". A second, separate
guard with its own allowlist leaves the generation grant exactly as CRMA-763
wrote it -- every blindness test still passes unchanged -- and gives this
phase a positive statement of its own reach.

What it enforces:

* one statement (a ``;``-separated rider would sail past every other check);
* a read -- ``SELECT``/``WITH`` only. The verdict write is the route's job,
  with the route's own client, after matching has returned, so no write
  capability is exercised from inside this package. That is CONTEXT.md's
  evidence-purity invariant made structural: nothing prediction-derived can
  reach ``FCT_SIGNALS`` or any trend table from here, because nothing here
  can write at all;
* every FROM/JOIN target named in an allowlist passed at the call site, plus
  the statement's own CTEs. Each grant is written where the statement is
  issued, so widening one is a visible diff.

Its limits, stated: it matches a FROM target's *object* name, not its
database/schema qualification (``Settings.qualify`` owns that), and it reads
the statement template. Numeric binds are coerced to ints before use (see
``positive_int``) and string binds are quoted by the Snowflake connector, so
neither can change a statement's shape after this check has run.
"""

from __future__ import annotations

import re
from typing import Any

_READ_PREFIXES = ("SELECT", "WITH")

_COMMENT_LINE = re.compile(r"--[^\n]*")
_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)

# The identifier chunk after FROM/JOIN. Stops at whitespace, a comma, a
# parenthesis or a semicolon, so `FROM (SELECT ...)` yields nothing here and
# the inner FROM is checked on its own.
_FROM_TARGET = re.compile(r"\b(?:FROM|JOIN)\s+([^\s(),;]+)")

# Names bound by this statement's own WITH clause -- not warehouse objects.
_CTE_NAME = re.compile(r"(?:\bWITH\s+|,\s*)([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(")


class MatchingIsolationViolation(RuntimeError):
    """A matching-phase statement tried to write, or reached an object this
    phase was not granted. Raised *before* the statement is issued."""


def positive_int(name: str, value: Any) -> int:
    """Coerce a scope bound to a positive int, or refuse.

    The Snowflake connector's ``pyformat`` paramstyle binds client-side, so a
    numeric parameter is substituted into the statement text. Forcing it to an
    int is what makes substitution incapable of changing the statement's shape
    after ``assert_matching_sql`` has looked at it.
    """
    coerced = int(value)
    if coerced < 1:
        raise ValueError(f"{name} must be at least 1, got {coerced}")
    return coerced


def _strip_comments(sql: str) -> str:
    return _COMMENT_BLOCK.sub(" ", _COMMENT_LINE.sub(" ", sql))


def _object_name(identifier: str) -> str:
    """The final dot-component of a (possibly qualified, possibly quoted)
    identifier: ``DB.SCHEMA."FCT_TRENDS"`` -> ``FCT_TRENDS``."""
    return identifier.rstrip(",").split(".")[-1].strip('"').strip()


def assert_matching_sql(sql: str, *, allowed_tables: tuple[str, ...]) -> None:
    """Raise ``MatchingIsolationViolation`` unless ``sql`` is a single read
    whose FROM/JOIN targets are all in ``allowed_tables``. Called by every
    matching-phase adapter before it hands a statement to a warehouse client."""
    body = _strip_comments(sql)
    upper = body.upper()
    stripped = upper.strip()

    if ";" in stripped.rstrip(";"):
        raise MatchingIsolationViolation(
            "the matching phase issues one statement at a time; this text contains "
            f"more than one: {stripped[:80]!r}"
        )

    if not stripped.startswith(_READ_PREFIXES):
        raise MatchingIsolationViolation(
            "the matching phase issues reads only -- the verdict write belongs to the "
            f"route, after matching has returned (expected one of {list(_READ_PREFIXES)}): "
            f"{stripped[:80]!r}"
        )

    allowed = {_object_name(name).upper() for name in allowed_tables}
    allowed |= {name.upper() for name in _CTE_NAME.findall(body)}
    unexpected = sorted(
        {
            _object_name(target)
            for target in _FROM_TARGET.findall(upper)
            if _object_name(target) not in allowed
        }
    )
    if unexpected:
        raise MatchingIsolationViolation(
            "the matching phase reads only the objects it was granted at the call site; "
            f"this statement reads {unexpected}, and only {sorted(allowed_tables)} "
            "(plus this statement's own CTEs) are allowed."
        )
