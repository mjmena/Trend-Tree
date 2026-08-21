"""deploy/scheduler.sh -- the daily cron, as code (CRMA-766 AC1, AC6).

The cron is the difference between "the pillar runs itself" and "someone
remembers to fire it", so the script that creates it is worth testing rather
than reading once and trusting. Everything here runs against a FAKE gcloud on
the GCLOUD hook: no real gcloud, no project, no network, and nothing in GCP
is created, updated or fired by this file.

The properties asserted are the ones that were expensive to learn, or that
fail silently once a day if they are wrong:

1. the OIDC audience is the BASE service URL -- pointing it at a tag URL
   produces a 401 with "the access token could not be verified" and nothing
   else wrong anywhere;
2. the script is idempotent -- it describes first, then create-or-update, so
   re-running it is how the schedule CHANGES rather than a thing that errors;
3. the POST body is valid JSON. It is built inside a shell parameter
   expansion, where a literal '}' has to be backslash-escaped and the
   backslash survives into the value -- which shipped a cron whose body the
   service would reject, and which nothing else would have caught;
4. the body pins a per-calendar-day idempotency key, because Cloud Scheduler
   retries -- and a retry without one appends a second full set of
   evaluations for the same day (the sweep side of that is asserted in
   tests/test_sweep_route.py);
5. the invoker check asks about the ROLE, not only the member -- otherwise a
   member holding some other role passes and the grant is skipped;
6. --verify can FAIL. Every failure mode it is supposed to catch -- a job
   that will not fire, a request that never reaches the service, a non-2xx --
   exits non-zero, and it never reports a previous run's log lines as this
   fire's.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

SCHEDULER_SH = Path(__file__).resolve().parents[1] / "deploy" / "scheduler.sh"
SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
INVOKER = "crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"
#: Relative, and the script is run with cwd=tmp_path, so every fake gcloud
#: invocation lands in one file per test.
CALL_LOG_NAME = "gcloud-calls.log"


def _fake_gcloud(
    tmp_path: Path,
    *,
    job_exists: bool,
    invoker_bound: bool = True,
    run_ok: bool = True,
    log_statuses: tuple[str, ...] = ("200",),
) -> Path:
    """A gcloud that answers the reads the script makes and echoes every other
    invocation, so a test can see what would have been run.

    ``invoker_bound`` is what makes the IAM fixture able to FAIL. The script
    asks gcloud to match the role and the member together (--filter), so the
    fake answers that query rather than dumping a whole policy: an unbound
    invoker -- or one holding a different role -- is an empty answer.
    """
    path = tmp_path / "fake-gcloud"
    path.write_text(
        "#!/usr/bin/env bash\n"
        # Every invocation is recorded to a FILE, not to stdout/stderr: the
        # script consumes both from some of these calls (and sends stderr to
        # /dev/null), and a test still has to be able to see what was asked.
        '{ printf "CALL"; for a in "$@"; do printf " %s" "$a"; done; printf "\\n"; }'
        f' >> "{CALL_LOG_NAME}"\n'
        'if [[ "$1 $2 $3" == "run services describe" ]]; then\n'
        f'  echo "{SERVICE_URL}"; exit 0\n'
        "fi\n"
        'if [[ "$1 $2 $3" == "scheduler jobs describe" ]]; then\n'
        f'  exit {0 if job_exists else 1}\n'
        "fi\n"
        # The policy read answers the query it was ASKED, the way gcloud's own
        # --filter does. So a script that stopped naming roles/run.invoker --
        # matching the member alone, which passes when that member holds some
        # other role -- gets an empty answer here and re-grants, and
        # test_an_existing_invoker_binding_is_left_alone fails.
        'if [[ "$1 $2 $3" == "run services get-iam-policy" ]]; then\n'
        + (
            '  if [[ "$*" == *"roles/run.invoker"* && "$*" == *"serviceAccount:'
            f'{INVOKER}"* ]]; then\n'
            f'    echo "serviceAccount:{INVOKER}"\n'
            "  fi\n"
            if invoker_bound
            else "  :\n"
        )
        + "  exit 0\n"
        "fi\n"
        'if [[ "$1 $2 $3" == "scheduler jobs run" ]]; then\n'
        f'  exit {0 if run_ok else 1}\n'
        "fi\n"
        'if [[ "$1 $2" == "logging read" ]]; then\n'
        + "".join(f'  echo "{status}"\n' for status in log_statuses)
        + "  exit 0\n"
        "fi\n"
        'printf "CALL"; for a in "$@"; do printf " %s" "$a"; done; printf "\\n"\n'
        "exit 0\n"
    )
    path.chmod(0o755)
    return path


def _calls(tmp_path: Path, needle: str) -> str:
    """The one recorded gcloud invocation containing ``needle``."""
    log = tmp_path / CALL_LOG_NAME
    return next(
        line
        for line in log.read_text().splitlines()
        if line.startswith("CALL") and needle in line
    )


def _run(tmp_path: Path, *args: str, job_exists: bool = False, **fake):
    gcloud = _fake_gcloud(tmp_path, job_exists=job_exists, **fake)
    return subprocess.run(
        ["bash", str(SCHEDULER_SH), *args],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "GCLOUD": str(gcloud),
            # --verify polls with a bounded wait; a test does not wait.
            "VERIFY_INTERVAL_S": "0",
            "VERIFY_ATTEMPTS": "2",
        },
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


def test_the_scheduled_body_pins_a_per_calendar_day_idempotency_key(tmp_path):
    # Cloud Scheduler retries -- including abandoning an attempt at the
    # deadline while that attempt is still running and about to commit. A
    # retry under a fresh chain_id derives fresh PREDICTION_EVAL_IDs and
    # appends a SECOND full set of evaluations for the same day, which the
    # append-only ledger cannot tell from real history. Bodies are static and
    # Cloud Scheduler has no template variables, so the body asks the route to
    # derive the id from the date.
    body = json.loads(_flags(_run(tmp_path).stdout)["message-body"])
    assert body["daily_chain_id"] is True
    # ...and it does NOT hard-code a date, which would go stale the next day.
    assert "chain_id" not in body


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


def test_a_missing_invoker_binding_is_granted(tmp_path):
    # The fixture has to be able to fail, or the check above proves nothing.
    result = _run(tmp_path, invoker_bound=False)
    assert result.returncode == 0, result.stderr
    assert "already bound" not in result.stdout
    assert "add-iam-policy-binding" in result.stdout


def test_the_invoker_check_asks_about_the_role_not_only_the_member(tmp_path):
    # Grepping the whole policy for the member alone passes when $INVOKER
    # holds some OTHER role on the service, skips the grant, and ships a cron
    # that 403s once a day forever.
    _run(tmp_path)
    call = _calls(tmp_path, "get-iam-policy")
    assert "roles/run.invoker" in call
    assert INVOKER in call


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


# --- --verify: the one flag whose whole job is to be trustworthy ----------


def test_verify_passes_when_this_fire_returns_2xx(tmp_path):
    result = _run(tmp_path, "--verify", job_exists=True, log_statuses=("200",))
    assert result.returncode == 0, result.stderr
    assert "returned 2xx" in result.stdout


def test_verify_fails_when_the_job_cannot_be_fired(tmp_path):
    # A nonexistent job, a paused job and a permission error all land here,
    # and `|| true` used to turn every one of them into a pass.
    result = _run(tmp_path, "--verify", job_exists=True, run_ok=False)
    assert result.returncode != 0
    assert "Aborting" in result.stderr
    assert "Nothing was verified" in result.stderr


def test_verify_fails_when_no_request_ever_reaches_the_service(tmp_path):
    # `gcloud logging read` exits 0 on empty, and Cloud Run request logs are
    # not synchronously available -- so the likely outcome of reading
    # immediately was an empty table printed under "The real result".
    result = _run(tmp_path, "--verify", job_exists=True, log_statuses=())
    assert result.returncode != 0
    assert "no Cloud Run request" in result.stderr


@pytest.mark.parametrize("status", ["401", "403", "502"])
def test_verify_fails_when_this_fire_did_not_get_a_2xx(tmp_path, status):
    result = _run(tmp_path, "--verify", job_exists=True, log_statuses=(status,))
    assert result.returncode != 0
    assert "no request since" in result.stderr
    assert status in result.stderr


def test_verify_waits_before_reading_the_log(tmp_path):
    # Firing and reading in the same breath reads a log that cannot have the
    # entry yet. The read is polled, so an entry that appears on the second
    # look still passes.
    gcloud = tmp_path / "slow-gcloud"
    marker = tmp_path / "attempts"
    gcloud.write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$1 $2 $3" == "run services describe" ]]; then\n'
        f'  echo "{SERVICE_URL}"; exit 0\n'
        "fi\n"
        'if [[ "$1 $2 $3" == "scheduler jobs run" ]]; then exit 0; fi\n'
        'if [[ "$1 $2" == "logging read" ]]; then\n'
        f'  echo x >> {marker}\n'
        f'  if [[ "$(wc -l < {marker})" -ge 2 ]]; then echo "200"; fi\n'
        "  exit 0\n"
        "fi\n"
        "exit 0\n"
    )
    gcloud.chmod(0o755)
    result = subprocess.run(
        ["bash", str(SCHEDULER_SH), "--verify"],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "GCLOUD": str(gcloud),
            "VERIFY_INTERVAL_S": "0",
            "VERIFY_ATTEMPTS": "5",
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert marker.read_text().count("x") >= 2


def test_verify_reads_only_entries_from_this_fire(tmp_path):
    # `--freshness 15m` with no timestamp floor happily prints the PREVIOUS
    # run's rows as this fire's -- a green light for a run that never
    # happened.
    _run(tmp_path, "--verify", job_exists=True)
    call = _calls(tmp_path, "logging read")
    assert "timestamp>=" in call
    assert "Google-Cloud-Scheduler" in call


def test_verify_creates_and_updates_nothing(tmp_path):
    result = _run(tmp_path, "--verify", job_exists=True)
    assert "scheduler jobs create" not in result.stdout
    assert "scheduler jobs update" not in result.stdout
    assert "add-iam-policy-binding" not in result.stdout
