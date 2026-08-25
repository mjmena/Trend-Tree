"""Generation-phase blindness to trend, heat and lifecycle state (CRMA-763).

The PRD makes this a structural guarantee, not a prompt instruction:

    "Generation-phase blindness to trend/heat tables is a code-structure
    guarantee (the generation module has no trend-table access)."

**What actually enforces it, honestly stated.** Two things carry it, and they
are not equally strong:

1. **A narrow signature, checked by a test.** ``generate_predictions``
   (generation/run.py) takes readers, not a warehouse client, and
   tests/test_blindness.py asserts its parameter list. That is a real
   constraint on the *shape* of the phase -- widening it is a visible diff
   and a failing test -- but it is not a runtime capability boundary. The
   readers' Protocols are structural and this repo runs no type checker, and
   in production ``SnowflakeSignalReader`` is handed the very same
   write-capable ``SnowflakeClient`` the rest of the service uses
   (routes/generate.py). Nothing at runtime stops that object from being
   asked for something else. The phase is blind because of what the code
   says, and a test keeps the code saying it.

2. **A statement guard that does run.** Every statement the phase issues
   goes through ``assert_generation_sql`` first. It enforces, in order: one
   statement only; a read, not a write; no trend/heat/lifecycle token
   anywhere in the text (denylist); and every FROM/JOIN target named in an
   explicit allowlist (plus the statement's own CTEs). The allowlist is what
   makes the check positive rather than a game of guessing which names to
   forbid -- ``DIM_TRENDS`` (no underscore, so no denylist hit),
   ``IDENTIFIER('FCT_'||'TRENDS')`` (assembled at runtime) and a
   ``;``-separated second statement are all rejected because they are not on
   it, not because anyone remembered them.

Layer 2 is the load-bearing one. It runs on the statement as the connector
will render it, against every adapter in this package, and it is what would
turn "someone widened the query" into a raised exception rather than a
silent self-fulfilling prophecy.

Its own limit, also stated: it matches the FROM target's *object* name, not
its database/schema qualification. Qualification is ``Settings.qualify``'s
job. The question this guard answers is "which objects", not "whose copy".
"""

from __future__ import annotations

import re

#: The objects a generation-phase statement may name in a FROM or JOIN.
#: Compared on the final dot-component, so a qualified
#: ``MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS`` matches ``FCT_SIGNALS``.
#:
#: This is the *default* grant. A caller may pass a different tuple for a
#: statement that legitimately needs another object -- today the only one is
#: generation/signals.py's live-subject read, which grants itself
#: ``FCT_PREDICTION_VERDICT_LEDGER`` and nothing else. That is deliberate and
#: narrow: the verdict ledger is the prediction pillar's own output, not
#: trend/heat/lifecycle state, so reading it tells the agent what the agent
#: already said rather than what the trend pipeline has noticed. CONTEXT.md's
#: isolation invariant points the other way (no trend-scoring path reads
#: prediction output) and is untouched by this. Every grant is per-statement
#: and written at the call site, so widening one is a visible diff.
DEFAULT_ALLOWED_TABLES: tuple[str, ...] = ("FCT_SIGNALS",)

# Substrings that mean "this statement can see the trend pipeline's own
# opinion of the world". Matched case-insensitively against the rendered SQL.
# Kept as defense in depth behind the FROM-target allowlist: it catches a
# forbidden object named somewhere other than a FROM (a scalar subquery in a
# SELECT list, a column reference), which the allowlist alone would not see.
#
# Deliberately NOT in this list:
#
# * the bare token ``TREND_`` -- the signal corpus itself lives in the schema
#   ``MCC_PRESENTATION.TREND_AGENT``, so a bare match would reject the one
#   query generation is allowed to run;
# * the bare column ``TREND_ID`` -- the verdict ledger's own
#   ``MATCHED_TREND_ID`` contains it, and every table that *carries* a
#   TREND_ID (FCT_TRENDS, FCT_TREND_*, DT_TREND_*, STG_TREND_CANDIDATES) is
#   already named below, so selecting one is unreachable anyway.
#
# Each entry is specific enough to clear ``TREND_AGENT.FCT_SIGNALS``.
FORBIDDEN_TABLE_TOKENS: tuple[str, ...] = (
    # Canonical trend identity + everything hanging off it. The FCT_TREND_
    # prefix covers FCT_TREND_SIGNALS, FCT_TREND_LIFECYCLE_LEDGER,
    # FCT_TREND_ENRICHMENT_LEDGER, FCT_TREND_SOURCE_METRICS,
    # FCT_TREND_GTRENDS_DAILY, FCT_TREND_PREDICTION_LEDGER, ...
    "FCT_TRENDS",
    "FCT_TREND_",
    # Dashboard + derived dynamic tables: DT_TREND_DASHBOARD, DT_TREND_DAILY,
    # DT_TREND_CONNECTIONS, DT_LLM_TREND_EMBEDDINGS.
    "DT_TREND_",
    "TREND_EMBEDDINGS",
    # Pre-promotion trend state.
    "STG_TREND_CANDIDATES",
    "STG_REVISIT_BATCH_QUEUE",
    "STG_ENRICHMENT_QUEUE",
    "DIM_TREND_",
    # The scored quantities themselves, wherever they are selected from.
    "HEAT_INDEX",
    "LIFECYCLE_STATUS",
    "PREDICTION_SCORE",
    "PREDICTION_FLAG",
    # Stored procedures that read or mutate trend state.
    "PROC_PROMOTION_APPLY",
    "PROC_LIFECYCLE_APPLY",
    "PROC_ENRICHMENT_APPLY",
    "PROC_CLUSTER_SIGNAL_SUBSET",
)

# Generation reads. It does not write -- not to the signal corpus (the
# CONTEXT.md "evidence purity" invariant: no prediction-derived row ever
# enters FCT_SIGNALS), and not to the ledger either (the verdict write is a
# separate phase, run by the route with its own client after generation has
# returned).
_READ_PREFIXES = ("SELECT", "WITH")

_COMMENT_LINE = re.compile(r"--[^\n]*")
_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)

# A FROM/JOIN target: the identifier chunk that follows the keyword. Stops at
# whitespace, a comma, a parenthesis or a semicolon, so `FROM (SELECT ...)`
# yields nothing here and the inner FROM is checked on its own.
_FROM_TARGET = re.compile(r"\b(?:FROM|JOIN)\s+([^\s(),;]+)")

# Names bound by this statement's own WITH clause. They are not warehouse
# objects and must not be measured against the allowlist.
_CTE_NAME = re.compile(r"(?:\bWITH\s+|,\s*)([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(")


class BlindnessViolation(RuntimeError):
    """A generation-phase statement reached for something generation must not
    see, or tried to write. Raised *before* the statement is issued."""


def _strip_comments(sql: str) -> str:
    return _COMMENT_BLOCK.sub(" ", _COMMENT_LINE.sub(" ", sql))


def _object_name(identifier: str) -> str:
    """The final dot-component of a (possibly qualified, possibly quoted)
    identifier: ``DB.SCHEMA."FCT_SIGNALS"`` -> ``FCT_SIGNALS``."""
    return identifier.rstrip(",").split(".")[-1].strip('"').strip()


def assert_generation_sql(
    sql: str, *, allowed_tables: tuple[str, ...] = DEFAULT_ALLOWED_TABLES
) -> None:
    """Raise ``BlindnessViolation`` unless ``sql`` is a single read whose
    FROM/JOIN targets are all in ``allowed_tables`` and which names no
    trend/heat/lifecycle object anywhere. Called by every generation-phase
    adapter before it hands a statement to a warehouse client."""
    body = _strip_comments(sql)
    upper = body.upper()

    stripped = upper.strip()

    # One statement. A `;`-separated rider would sail past every other check
    # here, which only ever looks at the text as a whole.
    if ";" in stripped.rstrip(";"):
        raise BlindnessViolation(
            "the generation phase issues one statement at a time; this text contains "
            f"more than one: {stripped[:80]!r}"
        )

    if not stripped.startswith(_READ_PREFIXES):
        raise BlindnessViolation(
            "the generation phase issues reads only "
            f"(expected the statement to start with one of {list(_READ_PREFIXES)}): "
            f"{stripped[:80]!r}"
        )

    hits = sorted({token for token in FORBIDDEN_TABLE_TOKENS if token in upper})
    if hits:
        raise BlindnessViolation(
            "generation is structurally blind to trend, heat and lifecycle state; "
            f"this statement names {hits}. See docs/prd/prediction-pillar-v1.md "
            "('generation is structurally blind to FCT_TRENDS, heat, and lifecycle')."
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
        raise BlindnessViolation(
            "generation is structurally blind to everything but the objects it was "
            f"granted; this statement reads {unexpected}, and only "
            f"{sorted(allowed_tables)} (plus this statement's own CTEs) are allowed."
        )
