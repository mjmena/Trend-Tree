-- Adds `strategist` to the EVIDENCE column's documented key list on the live
-- FCT_PREDICTION_VERDICT_LEDGER (CRMA-768).
--
-- Comment only -- no type, nullability or data change. The contracted keys
-- are enforced in code (domain/claim.py REQUIRED_EVIDENCE_KEYS); this column
-- comment is the warehouse-side copy of that list, and leaving it naming
-- four keys while the service writes five is the kind of drift that makes an
-- analyst mistrust the ledger's own documentation.
--
-- NOT APPLIED. Every other change in CRMA-768 is live (the service's own
-- code, and the new FCT_PREDICTION_STRATEGIST_LABELS table); this one alters
-- an existing object and is left for a human to run.
ALTER TABLE MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER
  MODIFY COLUMN EVIDENCE COMMENT 'contracted keys, all required to be present even when null: source_signals (FCT_SIGNALS ids), saturation (ET + GDELT), trend_context (heat/accel/growth/age, NULL for white-space), coverage (internal-coverage detections), strategist (latest Approve/Dismiss, the queue posture it settled, and which rung of the precedence ladder settled it)';
