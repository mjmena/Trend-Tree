"""Unit tests for IAP JWT-assertion verification (CRMA-762 AC4) -- the fake
verifiers below stand in for google.oauth2.id_token.verify_token against
IAP's JWKS endpoint, so these run with no network and no real IAP-signed
assertion.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from tt_services_lib.auth import (
    IAP_ASSERTION_HEADER,
    AuthError,
    require_caller_dependency,
    verify_iap_assertion,
)

AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"


def _ok_verifier(token: str, audience: str) -> dict:
    assert token == "good-assertion"
    assert audience == AUDIENCE
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience}


def _rejecting_verifier(token: str, audience: str) -> dict:
    raise ValueError("invalid_token: signature verification failed")


def _no_email_verifier(token: str, audience: str) -> dict:
    return {"aud": audience}


def test_accepts_valid_assertion():
    identity = verify_iap_assertion("good-assertion", audience=AUDIENCE, verify=_ok_verifier)
    assert identity.email == "caller@x.iam.gserviceaccount.com"
    assert identity.audience == AUDIENCE


def test_rejects_missing_header():
    with pytest.raises(AuthError, match="missing .* header"):
        verify_iap_assertion(None, audience=AUDIENCE, verify=_ok_verifier)


def test_rejects_empty_header():
    with pytest.raises(AuthError, match="missing .* header"):
        verify_iap_assertion("", audience=AUDIENCE, verify=_ok_verifier)


def test_rejects_invalid_signature():
    with pytest.raises(AuthError, match="IAP assertion verification failed"):
        verify_iap_assertion("bad-assertion", audience=AUDIENCE, verify=_rejecting_verifier)


def test_rejects_missing_email_claim():
    with pytest.raises(AuthError, match="no email claim"):
        verify_iap_assertion("x", audience=AUDIENCE, verify=_no_email_verifier)


class _FakeRequest:
    def __init__(self, assertion: str | None) -> None:
        self.headers = {IAP_ASSERTION_HEADER: assertion} if assertion else {}


def test_dependency_raises_http_401_on_invalid_assertion():
    dependency = require_caller_dependency(AUDIENCE, verify=_rejecting_verifier)

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest("bad-assertion"))

    assert exc_info.value.status_code == 401


def test_dependency_raises_http_401_on_missing_assertion():
    dependency = require_caller_dependency(AUDIENCE, verify=_ok_verifier)

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest(None))

    assert exc_info.value.status_code == 401


def test_dependency_returns_identity_on_valid_assertion():
    dependency = require_caller_dependency(AUDIENCE, verify=_ok_verifier)

    identity = dependency(_FakeRequest("good-assertion"))

    assert identity.email == "caller@x.iam.gserviceaccount.com"
