"""deploy/scheduler.sh -- the daily cron, as code (CRMA-766 AC1, AC6).

The cron is the difference between "the pillar runs itself" and "someone
remembers to fire it", so the script that creates it is worth testing rather
than reading once and trusting. Everything here runs against a FAKE gcloud on
the GCLOUD hook: no real gcloud, no project, no network, and nothing in GCP
is created, updated or fired by this file.

The three properties asserted are the three that were expensive to learn:

1. the OIDC audience is the BASE service URL -- pointing it at a tag URL
   produces a 401 with "the access token could not be verified" and nothing
   else wrong anywhere;
2. the script is idempotent -- it describes first, then create-or-update, so
   re-running it is how the schedule CHANGES rather than a thing that errors;
3. the POST body is valid JSON. It is built inside a shell parameter
   expansion, where a literal '}' has to be backslash-escaped and the
   backslash survives into the value -- which shipped a cron whose body the
   service would reject, and which nothing else would have caught.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

SCHEDULER_SH = Path(__file__).resolve().parents[1] / "deploy" / "scheduler.sh"
SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"


def _fake_gcloud(tmp_path: Path, *, job_exists: bool) -> Path:
    """A gcloud that answers the two reads the script makes and echoes every
    other invocation, so a test can see what would have been run."""
    path = tmp_path / "fake-gcloud"
    path.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$1 $2 $3" == "run services describe" ]]; then\n'
        f'  echo "{SERVICE_URL}"; exit 0\n'
        "fi\n"
        'if [[ "$1 $2 $3" == "scheduler jobs describe" ]]; then\n'
        f'  exit {0 if job_exists else 1}\n'
        "fi\n"
        'if [[ "$1 $2 $3" == "run services get-iam-policy" ]]; then\n'
        '  echo \'{"bindings":[{"role":"roles/run.invoker","members":'
        '["serviceAccount:crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"]}]}\'\n'
        "  exit 0\n"
        "fi\n"
        'printf "CALL"; for a in "$@"; do printf " %s" "$a"; done; printf "\\n"\n'
        "exit 0\n"
    )
    path.chmod(0o755)
    return path


def _run(tmp_path: Path, *args: str, job_exists: bool = False):
    gcloud = _fake_gcloud(tmp_path, job_exists=job_exists)
    return subprocess.run(
        ["bash", str(SCHEDULER_SH), *args],
        env={"PATH": "/usr/bin:/bin", "GCLOUD": str(gcloud)},
        capture_output=True,
        text=True,
    )


def test_the_script_is_valid_bash():
    assert subprocess.run(["bash", "-n", str(SCHEDULER_SH)]).returncode == 0


def test_it_creates_the_job_when_it_does_not_exist(tmp_path):
    result = _run(tmp_path, job_exists=False)
    assert result.returncode == 0, result.stderr
    assert "scheduler jobs create http trend-tree-prediction-daily-sweep" in result.stdout
    assert "scheduler jobs update" not in result.stdout


def test_it_updates_the_job_when_it_already_exists(tmp_path):
    # Idempotence: re-running the script is how the cron is changed.
    result = _run(tmp_path, job_exists=True)
    assert result.returncode == 0, result.stderr
    assert "scheduler jobs update http trend-tree-prediction-daily-sweep" in result.stdout
    assert "scheduler jobs create" not in result.stdout


def test_create_and_update_are_given_exactly_the_same_flags(tmp_path):
    # Two call sites, one argument list -- otherwise the created job and the
    # updated one drift, and only one of them is ever reviewed.
    created = _run(tmp_path, job_exists=False).stdout
    updated = _run(tmp_path, job_exists=True).stdout
    normalize = lambda text: sorted(  # noqa: E731 - a local, in a test
        part
        for line in text.split("\n")
        if line.startswith("CALL")
        for part in line.split(" --")[1:]
    )
    assert normalize(created) == normalize(updated)


def _flags(stdout: str) -> dict[str, str]:
    line = next(
        line for line in stdout.splitlines() if line.startswith("CALL") and "scheduler jobs" in line
    )
    return dict(
        re.match(r"--([a-z-]+)=(.*)", part).groups()  # type: ignore[union-attr]
        for part in re.findall(r"--[a-z-]+=[^\s]*(?:\s(?!--)[^\s]*)*", line)
    )


def test_the_oidc_audience_is_the_base_service_url_not_a_tag_url(tmp_path):
    flags = _flags(_run(tmp_path).stdout)
    assert flags["oidc-token-audience"] == SERVICE_URL
    assert "candidate---" not in flags["oidc-token-audience"]
    # ...while the URI is the route, on the same host.
    assert flags["uri"] == f"{SERVICE_URL}/sweep"


def test_it_fires_the_sweep_route_as_the_runtime_service_account(tmp_path):
    flags = _flags(_run(tmp_path).stdout)
    assert flags["uri"].endswith("/sweep")
    assert flags["http-method"] == "POST"
    assert (
        flags["oidc-service-account-email"]
        == "crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"
    )


def test_the_message_body_is_valid_json(tmp_path):
    body = _flags(_run(tmp_path).stdout)["message-body"]
    parsed = json.loads(body)
    assert parsed["prediction_limit"] >= 1
    assert parsed["max_predictions"] >= 1
    # Specifically: no stray backslash from the parameter expansion.
    assert "\\" not in body


def test_the_schedule_is_a_real_daily_cron(tmp_path):
    # Cloud Scheduler validates --schedule at creation, so an impossible date
    # is rejected outright and cannot be used to stage a paused job.
    flags = _flags(_run(tmp_path).stdout)
    minute, hour, dom, month, dow = flags["schedule"].split()
    assert (dom, month, dow) == ("*", "*", "*")
    assert 0 <= int(minute) <= 59
    assert 0 <= int(hour) <= 23
    assert flags["time-zone"] == "UTC"


def test_the_attempt_deadline_sits_inside_the_services_request_timeout(tmp_path):
    deploy_sh = (SCHEDULER_SH.parent / "deploy.sh").read_text()
    match = re.search(r"--timeout (\d+)", deploy_sh)
    assert match, "deploy.sh no longer sets --timeout; this bound cannot be checked"
    service_timeout = int(match.group(1))
    deadline = int(_flags(_run(tmp_path).stdout)["attempt-deadline"].rstrip("s"))
    assert deadline <= service_timeout


def test_a_dry_run_changes_nothing(tmp_path):
    result = _run(tmp_path, "--dry-run")
    assert result.returncode == 0, result.stderr
    assert "Would run" in result.stdout
    # No create, no update, no IAM binding.
    assert "CALL scheduler jobs create" not in result.stdout
    assert "CALL scheduler jobs update" not in result.stdout
    assert "add-iam-policy-binding" not in result.stdout


def test_an_existing_invoker_binding_is_left_alone(tmp_path):
    # crm-runtime@ already holds roles/run.invoker (verified read-only,
    # 2026-08-21), so the normal path must be a no-op read rather than a
    # rewrite of the service's IAM policy.
    result = _run(tmp_path)
    assert "already bound" in result.stdout
    assert "add-iam-policy-binding" not in result.stdout


def test_it_refuses_to_build_a_job_pointed_at_a_service_that_has_no_url(tmp_path):
    gcloud = tmp_path / "broken-gcloud"
    gcloud.write_text("#!/usr/bin/env bash\nexit 1\n")
    gcloud.chmod(0o755)
    result = subprocess.run(
        ["bash", str(SCHEDULER_SH)],
        env={"PATH": "/usr/bin:/bin", "GCLOUD": str(gcloud)},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "could not read" in result.stderr
    # A job pointed at an empty URL 404s once a day, silently.
    assert "404" in result.stderr


def test_an_unknown_flag_is_refused(tmp_path):
    result = _run(tmp_path, "--delete-everything")
    assert result.returncode != 0
    assert "unknown flag" in result.stderr


@pytest.mark.parametrize("flag", ["--pause", "--resume", "--describe"])
def test_the_lifecycle_flags_touch_only_the_job(tmp_path, flag):
    # job_exists=True: --describe execs gcloud's own describe, which exits
    # non-zero for a job that is not there. That is the right behaviour, and
    # it is not what this test is about.
    result = _run(tmp_path, flag, job_exists=True)
    assert result.returncode == 0, result.stderr
    assert "scheduler jobs create" not in result.stdout
    assert "scheduler jobs update" not in result.stdout


def test_the_script_documents_that_no_admin_access_is_needed(tmp_path):
    # AC6: the two permissions this needs were verified granted, so the
    # header has to say so -- and say what the minimum ask WOULD be, without
    # asking for anything wider.
    header = SCHEDULER_SH.read_text()
    assert "roles/run.invoker" in header
    assert "roles/cloudscheduler.admin" in header
    assert "roles/iam.serviceAccountUser" in header
    assert "no access request outstanding" in header
