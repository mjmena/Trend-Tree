"""Tests for deploy/lib.sh -- the deploy gate's "does this service exist?"
decision (CRMA-762).

Why this has its own test file rather than being read once and trusted: the
answer decides whether deploy.sh takes the BOOTSTRAP branch, and the bootstrap
branch deploys WITHOUT --no-traffic (gcloud rejects --no-traffic when creating
a service) and, in oidc mode, with a deliberately unmatchable placeholder
audience. Run against an existing, healthy service that branch promotes an
unprobed revision to 100% traffic and 401s every caller.

The original `gcloud ... 2>/dev/null || true` collapsed every failure mode --
expired credentials, a network blip, an API 500 -- into the same empty string
that means "no such service", so a transient describe failure was enough to
trigger it. These tests pin the three-way distinction that replaced it, with a
fake gcloud on the GCLOUD hook: no real gcloud, no project, no network.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

LIB_SH = Path(__file__).resolve().parents[1] / "deploy" / "lib.sh"
DEPLOY_SH = Path(__file__).resolve().parents[1] / "deploy" / "deploy.sh"


@dataclass(frozen=True)
class Result:
    returncode: int
    stdout: str
    stderr: str


def _fake_gcloud(tmp_path: Path, *, stdout: str = "", stderr: str = "", code: int = 0) -> Path:
    path = tmp_path / "fake-gcloud"
    path.write_text(
        "#!/usr/bin/env bash\n"
        # %b, not %s: the canned messages carry \n escapes.
        f"printf '%b' {stdout!r}\n"
        f"printf '%b' {stderr!r} >&2\n"
        f"exit {code}\n"
    )
    path.chmod(0o755)
    return path


def _resolve(gcloud: Path) -> Result:
    proc = subprocess.run(
        [
            "bash",
            "-c",
            f'set -euo pipefail; source "{LIB_SH}"; '
            "resolve_service_url trend-tree-prediction us-east4 mcc-crm-automations",
        ],
        env={"PATH": "/usr/bin:/bin", "GCLOUD": str(gcloud)},
        capture_output=True,
        text=True,
    )
    return Result(proc.returncode, proc.stdout, proc.stderr)


def test_existing_service_returns_its_url(tmp_path: Path):
    gcloud = _fake_gcloud(tmp_path, stdout="https://trend-tree-prediction-abc-uk.a.run.app\n")

    result = _resolve(gcloud)

    assert result.returncode == 0
    assert result.stdout == "https://trend-tree-prediction-abc-uk.a.run.app"


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: (gcloud.run.services.describe) Cannot find service [trend-tree-prediction]\n",
        "ERROR: (gcloud.run.services.describe) NOT_FOUND: Resource "
        "'namespaces/mcc-crm-automations/services/trend-tree-prediction' was not found.\n",
        "ERROR: (gcloud.run.services.describe) Service does not exist.\n",
    ],
)
def test_a_genuinely_missing_service_is_reported_as_empty_and_succeeds(
    tmp_path: Path, message: str
):
    # The one case where the bootstrap branch is correct.
    gcloud = _fake_gcloud(tmp_path, stderr=message, code=1)

    result = _resolve(gcloud)

    assert result.returncode == 0
    assert result.stdout == ""


@pytest.mark.parametrize(
    "message",
    [
        # Expired / missing credentials
        "ERROR: (gcloud.run.services.describe) You do not currently have an active account "
        "selected.\n",
        # Transport blip
        "ERROR: (gcloud.run.services.describe) There was a problem refreshing your current "
        "auth tokens: Connection reset by peer\n",
        # Server-side failure
        "ERROR: (gcloud.run.services.describe) INTERNAL: Internal error encountered. (503)\n",
        # Permissions -- the service may well exist
        "ERROR: (gcloud.run.services.describe) PERMISSION_DENIED: Permission "
        "'run.services.get' denied.\n",
    ],
)
def test_any_other_failure_is_an_error_not_an_empty_url(tmp_path: Path, message: str):
    # THE finding: none of these mean "the service does not exist", and
    # treating them as such promotes an unprobed revision onto a live service.
    gcloud = _fake_gcloud(tmp_path, stderr=message, code=1)

    result = _resolve(gcloud)

    assert result.returncode != 0
    assert result.stdout == ""
    assert message.strip() in result.stderr  # gcloud's own words reach the operator


def test_a_not_found_message_is_matched_case_insensitively(tmp_path: Path):
    gcloud = _fake_gcloud(tmp_path, stderr="ERROR: cannot find SERVICE [x]\n", code=1)

    assert _resolve(gcloud).returncode == 0


def test_deploy_sh_no_longer_swallows_describe_failures():
    # Belt-and-braces on the call site: the failure mode was a `2>/dev/null ||
    # true` around the describe, and the fix is worthless if it comes back.
    source = DEPLOY_SH.read_text()
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )

    assert "2>/dev/null || true" not in code
    assert "resolve_service_url" in code
    # Assigns $URL rather than echoing: `URL="$(service_url)"` would run the
    # abort inside a command substitution, where `exit 1` leaves only the
    # subshell and the caller continues with an empty URL -- the same bug.
    assert 'URL="$(service_url)"' not in code
    assert "set_service_url" in code


def test_the_gate_probes_the_authenticated_no_op_route_and_not_run():
    # Probe 3 has to hit a route that actually runs require_caller, and it
    # must not be /run: /run appends a real FCT_PREDICTION_VERDICT_LEDGER row,
    # and a promote gate that writes a ledger row on every deploy is a bug of
    # its own. /whoami is the side-effect-free stand-in (see app.py).
    source = DEPLOY_SH.read_text()

    assert "/whoami" in source
    assert '"${CANDIDATE_URL}/run"' not in source
