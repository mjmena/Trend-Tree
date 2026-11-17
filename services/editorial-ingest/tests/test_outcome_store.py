from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from procedure_database import ProcedureDatabase

from editorial_ingest.outcomes import SnowflakeNominationStore


def test_concurrent_acceptance_keeps_one_original_request_and_dropped_urls(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    stores = [SnowflakeNominationStore(database) for _ in range(2)]
    first = {"nomination_id": "nom-1", "brief": "first", "urls": []}
    second = {"nomination_id": "nom-1", "brief": "second", "urls": []}
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(
            pool.map(
                lambda args: args[0].accept(args[1], [{"url": args[1]["brief"]}]),
                zip(stores, [first, second], strict=True),
            )
        )
    stored = stores[0].get("nom-1")
    assert stored is not None
    assert receipts[0].request == receipts[1].request == stored.request
    assert stored.dropped_urls == [{"url": stored.request["brief"]}]
    assert stored.snapshot() == {
        "nomination_id": "nom-1",
        "status": "pending",
        "trend_id": None,
        "dropped_urls": stored.dropped_urls,
        "error": None,
        "status_url": "/nominations/nom-1",
    }


def test_overlapping_deliveries_have_one_owner_and_cannot_replace_its_plan(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    store = SnowflakeNominationStore(database)
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda owner: store.claim("nom-1", owner), ["one", "two"]))
    owned = [claim for claim in claims if claim is not None]
    assert len(owned) == 1
    owner = owned[0].owner
    saved = store.save_plan("nom-1", owner, {"topic": "A durable evaluation"})
    assert saved.plan == {"topic": "A durable evaluation"}
    assert store.claim("nom-1", "third") is None


def test_retry_preserves_evaluation_and_late_attempt_failure_cannot_release_new_owner(tmp_path):
    store = SnowflakeNominationStore(ProcedureDatabase(tmp_path / "receipts.db"))
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    store.claim("nom-1", "one")
    store.save_plan("nom-1", "one", {"topic": "An agreed topic"})
    retrying = store.attempt_failed("nom-1", "one")
    assert retrying.status == "pending"
    assert retrying.error == {
        "code": "processing_retry",
        "message": "Processing was interrupted and will retry.",
    }
    reclaimed = store.claim("nom-1", "two")
    assert reclaimed.plan == {"topic": "An agreed topic"}
    store.attempt_failed("nom-1", "one")
    assert store.get("nom-1").owner == "two"


def test_missing_task_waits_for_active_owner_before_recording_failure(tmp_path):
    store = SnowflakeNominationStore(ProcedureDatabase(tmp_path / "receipts.db"))
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    queued = store.mark_queued("nom-1")
    assert queued.queue_confirmed_at is not None
    store.claim("nom-1", "worker")
    assert store.reconcile_missing("nom-1").status == "pending"
    store.attempt_failed("nom-1", "worker")
    failed = store.reconcile_missing("nom-1")
    assert failed.status == "failed"
    assert failed.error["code"] == "processing_failed"
    assert store.claim("nom-1", "late-worker").status == "failed"


def test_committed_candidate_recovers_created_before_late_failure(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    with database.connect() as conn:
        conn.execute(
            """INSERT INTO STG_TREND_CANDIDATES
                     (CANDIDATE_ID, TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID)
                     VALUES (?, ?, ?, ?, ?)""",
            ("nom-1", "A committed topic", "2026-11-17 10:00:00", "trend-1", None),
        )
    store = SnowflakeNominationStore(database)
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    store.claim("nom-1", "worker")
    completed = store.complete("nom-1", "worker")
    assert (completed.status, completed.trend_id, completed.error) == ("created", "trend-1", None)
    store.attempt_failed("nom-1", "worker")
    assert store.get("nom-1").status == "created"


def test_missing_task_recovers_revival_and_keeps_that_outcome_after_lifecycle_changes(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    with database.connect() as conn:
        conn.execute(
            """INSERT INTO STG_TREND_CANDIDATES
                     (CANDIDATE_ID, TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID)
                     VALUES (?, ?, ?, ?, ?)""",
            ("nom-1", "A committed topic", "2026-11-17 10:00:00", "trend-1", "trend-1"),
        )
        conn.execute("""INSERT INTO FCT_TREND_LIFECYCLE_LEDGER
                     (TREND_ID, NEW_STATUS, NEW_HEAT, NEW_HEAT_SMOOTHED, HEAT_BASE)
                     VALUES ('trend-1', 'RETIRED', 25, 20, 30)""")
    store = SnowflakeNominationStore(database)
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    recovered = store.reconcile_missing("nom-1")
    assert (recovered.status, recovered.trend_id) == ("resurgent", "trend-1")
    with database.connect() as conn:
        conn.execute("UPDATE FCT_TREND_LIFECYCLE_LEDGER SET NEW_STATUS = 'STABLE'")
    assert store.reconcile_missing("nom-1").status == "resurgent"


def test_promotion_fences_a_replaced_owner_before_any_domain_write(tmp_path):
    import pytest

    from editorial_ingest.handler import Judgment, TaskError, apply_promotion

    database = ProcedureDatabase(tmp_path / "receipts.db")
    store = SnowflakeNominationStore(database)
    task = {"nomination_id": "nom-1", "urls": [], "brief": "A topic", "nominated_by": "editor"}
    store.accept(task, [])
    store.claim("nom-1", "one")
    store.save_plan("nom-1", "one", {"topic": "A topic"})
    store.prepare("nom-1", "one", [])
    store.attempt_failed("nom-1", "one")
    store.claim("nom-1", "two")
    with pytest.raises(TaskError, match="ownership lost"):
        apply_promotion(database, task, "A topic", Judgment(), {}, owner="one")
    assert store.get("nom-1").owner == "two"


def test_promotion_replay_recovers_the_committed_candidate_without_recreating_a_trend(tmp_path):
    from editorial_ingest.handler import Judgment, apply_promotion

    database = ProcedureDatabase(tmp_path / "receipts.db")
    with database.connect() as conn:
        conn.execute("""INSERT INTO STG_TREND_CANDIDATES
                     (CANDIDATE_ID, TOPIC, PROMOTED_AT, PROMOTED_TO)
                     VALUES ('nom-1', 'A topic', CURRENT_TIMESTAMP, 'committed-trend')""")
    store = SnowflakeNominationStore(database)
    task = {"nomination_id": "nom-1", "urls": [], "brief": "A topic", "nominated_by": "editor"}
    store.accept(task, [])
    store.claim("nom-1", "worker")
    result = apply_promotion(database, task, "A topic", Judgment(), {}, owner="worker")
    assert result == {
        "candidate_id": "nom-1",
        "decision": "PROMOTE_NEW",
        "target_trend_id": "committed-trend",
        "status": "ok",
    }
