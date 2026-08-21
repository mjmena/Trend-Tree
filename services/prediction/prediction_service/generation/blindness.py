"""Generation-phase blindness, enforced at the statement level (CRMA-763).

The PRD makes this a structural guarantee, not a prompt instruction:

    "Generation-phase blindness to trend/heat tables is a code-structure
    guarantee (the generation module has no trend-table access)."

Two layers carry it, and neither is a comment:

1. **Capability.** ``generate_predictions`` (generation/run.py) takes a
   ``SignalReader`` -- an interface whose entire surface is "give me recent
   rows of the signal corpus". It never receives a ``SnowflakeClient``, so
   there is no object in the generation call graph that *can* issue an
   arbitrary query or any write at all. The trend tables are not merely
   un-queried; they are unreachable.
2. **Statement guard.** The one adapter that does touch a warehouse
   (``SnowflakeSignalReader``) runs every statement through
   ``assert_generation_sql`` before it is issued. A statement that names a
   trend, heat, lifecycle, candidate or dashboard object -- or that is not a
   read -- raises ``BlindnessViolation`` instead of executing.

Layer 2 exists because layer 1 is only as good as the adapter: someone
constructing ``SnowflakeSignalReader`` against a different table, or widening
its query later, would otherwise quietly re-open the door that layer 1
closes. The guard turns that into a test failure and a 500, not a silent
self-fulfilling prophecy.
"""

from __future__ import annotations

import re

# Substrings that mean "this statement can see the trend pipeline's own
# opinion of the world". Matched case-insensitively against the rendered SQL.
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


class BlindnessViolation(RuntimeError):
    """A generation-phase statement reached for something generation must not
    see, or tried to write. Raised *before* the statement is issued."""


def _strip_comments(sql: str) -> str:
    return _COMMENT_BLOCK.sub(" ", _COMMENT_LINE.sub(" ", sql))


def assert_generation_sql(sql: str) -> None:
    """Raise ``BlindnessViolation`` unless ``sql`` is a read that names no
    trend/heat/lifecycle object. Called by every generation-phase adapter
    before it hands a statement to a warehouse client."""
    body = _strip_comments(sql)
    upper = body.upper()

    stripped = upper.strip()
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
