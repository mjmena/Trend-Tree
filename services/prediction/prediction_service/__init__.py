"""trend-tree-prediction: the prediction pillar's Cloud Run service (CRMA-762).

This is the services/ namespace's first service -- a skeleton that proves the
deploy -> authenticated call -> verdict-ledger-write path end to end. The real
generate/match/verdict pipeline (docs/prd/prediction-pillar-v1.md's three-phase
run) is later scope; ``routes.run`` today validates a claim and appends one
verdict row, nothing more.
"""

from __future__ import annotations
