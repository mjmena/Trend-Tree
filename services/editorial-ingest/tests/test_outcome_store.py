from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import pytest
from procedure_database import ProcedureDatabase

from editorial_ingest.outcomes import SnowflakeNominationStore


@pytest.mark.parametrize("encoded", [False, True])
def test_read_deserializes_connector_variants_timestamps_and_partial_failure(encoded):
    import json

    def variant(value):
        return json.dumps(value) if encoded else value

    class Connector:
        def query(self, sql, params):
            return [
                {
                    "NOMINATION_ID": "nom-1",
                    "REQUEST": variant({"nomination_id": "nom-1", "brief": "private", "urls": []}),
                    "DROPPED_URLS": variant(
                        [{"url": "https://example.com/dead", "reason": "dead_410"}]
                    ),
                    "STATUS": "failed",
                    "RESULT": variant(
                        {
                            "trend_id": "existing-trend",
                            "error": {
                                "code": "processing_incomplete",
                                "message": "Processing incomplete.",
                            },
                        }
                    ),
                    "CREATED_AT": datetime(2026, 11, 17, 12, tzinfo=UTC),
                    "UPDATED_AT": datetime(2026, 11, 17, 13, tzinfo=UTC),
                    "OWNER": None,
                    "LEASE_UNTIL": None,
                    "QUEUE_CONFIRMED_AT": datetime(2026, 11, 17, 12, tzinfo=UTC),
                    "PLAN": variant({"topic": "Private saved topic"}),
                }
            ]

    receipt = SnowflakeNominationStore(Connector()).get("nom-1")
    assert receipt.snapshot() == {
        "nomination_id": "nom-1",
        "status": "failed",
        "trend_id": "existing-trend",
        "dropped_urls": [{"url": "https://example.com/dead", "reason": "dead_410"}],
        "status_url": "/nominations/nom-1",
        "error": {"code": "processing_incomplete", "message": "Processing incomplete."},
    }
    assert receipt.created_at == receipt.queue_confirmed_at == "2026-11-17 12:00:00+00:00"
    assert receipt.updated_at == "2026-11-17 13:00:00+00:00"
    assert receipt.owner is receipt.lease_until is None
    assert receipt.plan == {"topic": "Private saved topic"}
    assert receipt.request == {"nomination_id": "nom-1", "brief": "private", "urls": []}


def test_receipt_read_works_on_a_read_only_database_and_preserves_private_fields(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    store = SnowflakeNominationStore(database)
    payload = {"nomination_id": "nom-1", "brief": "First content", "urls": []}
    dropped = [{"url": "https://example.com/dead", "reason": "dead_410"}]
    store.accept(payload, dropped)
    store.mark_queued("nom-1")
    store.claim("nom-1", "worker")
    planned = store.save_plan("nom-1", "worker", {"topic": "The saved topic"})

    class ReadOnlyDatabase:
        def query(self, sql, params):
            with database.connect() as conn:
                conn.execute("PRAGMA query_only = ON")
                cursor = conn.execute(
                    sql.replace("MCC_RAW.MARKETING_DEV.", "").replace("%(id)s", ":id"),
                    params,
                )
                return [
                    dict(zip([c[0] for c in cursor.description], row, strict=True))
                    for row in cursor
                ]

    reader = SnowflakeNominationStore(ReadOnlyDatabase())
    assert reader.get("nom-1") == planned
    assert reader.get("unknown") is None


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


def test_expired_worker_cannot_prepare_or_promote_even_before_another_worker_claims(tmp_path):
    import pytest

    from editorial_ingest.handler import Judgment, TaskError, apply_promotion

    database = ProcedureDatabase(tmp_path / "receipts.db")
    store = SnowflakeNominationStore(database)
    task = {"nomination_id": "nom-1", "urls": [], "brief": "A topic", "nominated_by": "editor"}
    store.accept(task, [])
    store.claim("nom-1", "expired")
    store.save_plan("nom-1", "expired", {"topic": "A topic"})
    database.advance(961)
    with pytest.raises(ValueError, match="ownership lost"):
        store.prepare("nom-1", "expired", [])
    with pytest.raises(TaskError, match="ownership lost"):
        apply_promotion(database, task, "A topic", Judgment(), {}, owner="expired")
    assert store.reconcile_missing("nom-1").status == "failed"


def test_failed_revival_keeps_committed_target_and_recovers_on_retry(tmp_path):
    database = ProcedureDatabase(tmp_path / "receipts.db")
    with database.connect() as conn:
        conn.execute("""INSERT INTO STG_TREND_CANDIDATES
                     (CANDIDATE_ID, TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID)
                     VALUES ('nom-1', 'A topic', CURRENT_TIMESTAMP,
                             'existing-trend', 'existing-trend')""")
    store = SnowflakeNominationStore(database)
    store.accept({"nomination_id": "nom-1", "urls": []}, [])
    store.claim("nom-1", "worker")
    interrupted = store.attempt_failed("nom-1", "worker")
    assert interrupted.status == "pending"
    assert interrupted.trend_id == "existing-trend"
    assert "was updated" in interrupted.error["message"]
    recovered = store.reconcile_missing("nom-1")
    assert (recovered.status, recovered.trend_id, recovered.error) == (
        "merged",
        "existing-trend",
        None,
    )


def test_database_connections_are_reused_per_thread_without_blocking_other_threads():
    from threading import Barrier, get_ident

    from editorial_ingest.outcomes import ThreadLocalSnowflakeClient

    entered = Barrier(2)

    class Connection:
        def __init__(self):
            self.owner = get_ident()

        def query(self, sql, params=None):
            assert get_ident() == self.owner
            if sql == "first":
                entered.wait(timeout=5)
            return [{"connection": id(self)}]

    client = ThreadLocalSnowflakeClient(Connection)

    def read_twice(_):
        return client.query("first"), client.query("second")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(read_twice, range(2)))
    assert results[0][0] == results[0][1]
    assert results[1][0] == results[1][1]
    assert results[0][0] != results[1][0]
