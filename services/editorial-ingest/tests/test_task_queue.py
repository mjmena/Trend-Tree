from types import SimpleNamespace

import pytest

from editorial_ingest.tasks import CloudTasksQueue


@pytest.mark.parametrize(
    ("status", "expected"),
    [(200, "present"), (404, "missing"), (403, "unknown"), (503, "unknown")],
)
def test_lookup_only_reports_absence_when_cloud_tasks_confirms_it(status, expected):
    class Session:
        def get(self, url, **kwargs):
            assert url == (
                "https://cloudtasks.googleapis.com/v2/"
                "projects/project/locations/region/queues/queue/tasks/nom-123"
            )
            assert kwargs["timeout"] <= 5
            return SimpleNamespace(status_code=status)

    queue = CloudTasksQueue(
        project="project",
        location="region",
        queue="queue",
        target_url="https://example.com/tasks/nominations",
        audience="https://example.com",
        service_account="queue@example.com",
        session=Session(),
    )
    assert queue.lookup("nom-123") == expected


def test_task_lookup_transport_failure_does_not_mean_the_task_is_missing():
    class Session:
        def get(self, url, **kwargs):
            raise TimeoutError("private transport details")

    queue = CloudTasksQueue(
        project="project",
        location="region",
        queue="queue",
        target_url="https://example.com/tasks/nominations",
        audience="https://example.com",
        service_account="queue@example.com",
        session=Session(),
    )
    assert queue.lookup("nom-123") == "unknown"
