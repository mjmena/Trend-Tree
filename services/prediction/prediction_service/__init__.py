"""trend-tree-prediction: the prediction pillar's Cloud Run service (CRMA-762).

This is the services/ namespace's first service. CRMA-762 built the skeleton
that proves the deploy -> authenticated call -> verdict-ledger-write path end
to end (``routes.run``: validate a claim, append one verdict row). CRMA-763
added the first of the PRD's three phases:

* ``routes.generate`` / ``generation`` -- **generate**. Reads the signal
  corpus, emits falsifiable 4-part claims, appends them as ACTIVE verdict
  rows. Structurally blind to FCT_TRENDS, heat and lifecycle
  (``generation.blindness``).
* **match** (CRMA-764) and the daily re-evaluation **sweep** (CRMA-766) are
  not built. Until matching exists every generated prediction carries
  ``MATCHED_TREND_ID = NULL`` -- a white-space prediction, ledger-only in v1.
"""

from __future__ import annotations
