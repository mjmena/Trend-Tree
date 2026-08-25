"""The matching phase -- the compare step (CRMA-764).

Generation is blind to trend state by construction (generation/blindness.py).
This package is the phase that is *allowed* to look: each open prediction is
compared against current trends via the descriptor vocabulary (ADR-0003) and
embeddings, and a hit records ``MATCHED_TREND_ID`` plus
``EVIDENCE.trend_context``. No hit leaves ``MATCHED_TREND_ID`` NULL -- a
white-space prediction, ledger-only in v1.

The phase is a separate route (``POST /match``) rather than a tail on
``POST /generate`` so that the generation run's statement set stays exactly
what tests/test_blindness.py asserts it is: the signal corpus and the
pillar's own verdict ledger, nothing else. Matching's reach into trend
tables can never leak into a generation run because it is not on that call
path at all.
"""
