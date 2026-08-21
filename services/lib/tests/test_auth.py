"""Unit tests for ingress token verification in both auth modes (CRMA-762
AC4): Cloud Run IAM / OIDC (the deployed posture, and the default) and IAP.
The fake verifiers below stand in for google.oauth2.id_token, so these run
with no network and no real Google-signed token.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from tt_services_lib.auth import (
    AUTH_MODE_IAP,
    AUTH_MODE_OIDC,
    AUTHORIZATION_HEADER,
    DEFAULT_AUTH_MODE,
    IAP_ASSERTION_HEADER,
    IAP_ISSUER,
    AuthError,
    bearer_token,
    require_caller_dependency,
    verify_iap_assertion,
    verify_oidc_token,
)

AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"
SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
GOOGLE_ISSUER = "https://accounts.google.com"


def _ok_verifier(token: str, audience: str) -> dict:
    assert token == "good-assertion"
    assert audience == AUDIENCE
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": IAP_ISSUER}


def _rejecting_verifier(token: str, audience: str) -> dict:
    raise ValueError("invalid_token: signature verification failed")


def _no_email_verifier(token: str, audience: str) -> dict:
    return {"aud": audience, "iss": IAP_ISSUER}


def _wrong_issuer_verifier(token: str, audience: str) -> dict:
    # A signature-valid Google ID token that is *not* an IAP assertion --
    # google.oauth2.id_token.verify_token checks aud/exp/iat but never iss, so
    # nothing below the app layer would reject this.
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "https://accounts.google.com",
    }


def _no_issuer_verifier(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience}


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
    """Only the ``headers`` mapping the dependency reads. ``assertion`` fills
    the IAP header, ``authorization`` the raw Authorization header -- a test
    can set either, or both, to pin down that a mode ignores the other one's
    header."""

    def __init__(self, assertion: str | None = None, *, authorization: str | None = None) -> None:
        self.headers: dict[str, str] = {}
        if assertion:
            self.headers[IAP_ASSERTION_HEADER] = assertion
        if authorization:
            self.headers[AUTHORIZATION_HEADER] = authorization


def test_dependency_raises_http_401_on_invalid_assertion():
    dependency = require_caller_dependency(AUDIENCE, mode=AUTH_MODE_IAP, verify=_rejecting_verifier)

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest("bad-assertion"))

    assert exc_info.value.status_code == 401


def test_dependency_raises_http_401_on_missing_assertion():
    dependency = require_caller_dependency(AUDIENCE, mode=AUTH_MODE_IAP, verify=_ok_verifier)

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest(None))

    assert exc_info.value.status_code == 401


def test_dependency_returns_identity_on_valid_assertion():
    dependency = require_caller_dependency(AUDIENCE, mode=AUTH_MODE_IAP, verify=_ok_verifier)

    identity = dependency(_FakeRequest("good-assertion"))

    assert identity.email == "caller@x.iam.gserviceaccount.com"


def test_rejects_non_iap_issuer():
    with pytest.raises(AuthError, match="unexpected issuer"):
        verify_iap_assertion("x", audience=AUDIENCE, verify=_wrong_issuer_verifier)


def test_rejects_missing_issuer_claim():
    with pytest.raises(AuthError, match="unexpected issuer"):
        verify_iap_assertion("x", audience=AUDIENCE, verify=_no_issuer_verifier)


def test_dependency_raises_http_401_on_non_iap_issuer():
    dependency = require_caller_dependency(
        AUDIENCE, mode=AUTH_MODE_IAP, verify=_wrong_issuer_verifier
    )

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest("signed-but-not-by-iap"))

    assert exc_info.value.status_code == 401


def test_jwks_response_is_cached_for_its_ttl():
    from tt_services_lib.auth import IAP_JWKS_URL, _JwksCachingRequest

    calls: list[str] = []

    class _Response:
        status = 200
        data = b'{"keys": []}'

    def _inner(url: str, method: str = "GET", **kwargs: object) -> _Response:
        calls.append(url)
        return _Response()

    request = _JwksCachingRequest(_inner, url=IAP_JWKS_URL, ttl=3600)

    first = request(IAP_JWKS_URL, method="GET")
    second = request(IAP_JWKS_URL, method="GET")

    assert len(calls) == 1  # the second verification did no network at all
    assert first.data == second.data == b'{"keys": []}'


def test_jwks_cache_does_not_swallow_other_urls_or_non_200():
    from tt_services_lib.auth import IAP_JWKS_URL, _JwksCachingRequest

    calls: list[str] = []

    class _ServerError:
        status = 500
        data = b"nope"

    def _inner(url: str, method: str = "GET", **kwargs: object) -> _ServerError:
        calls.append(url)
        return _ServerError()

    request = _JwksCachingRequest(_inner, url=IAP_JWKS_URL, ttl=3600)
    request(IAP_JWKS_URL, method="GET")
    request(IAP_JWKS_URL, method="GET")
    request("https://example.com/other", method="GET")

    assert len(calls) == 3  # nothing cached: two failed fetches + an unrelated URL


# --- Cloud Run IAM (OIDC) mode -------------------------------------------
#
# Different header, different issuer, different audience shape from IAP --
# see tt_services_lib.auth's module docstring for the full comparison.


def _ok_oidc_verifier(token: str, audience: str) -> dict:
    assert token == "good-token"
    assert audience == SERVICE_URL
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _bare_issuer_oidc_verifier(token: str, audience: str) -> dict:
    # google-auth accepts the issuer with or without the https:// scheme
    # (_GOOGLE_ISSUERS holds both forms), so we must too.
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "accounts.google.com",
    }


def _audience_checking_oidc_verifier(token: str, audience: str) -> dict:
    # What the real verifier does with a mismatched `aud`: google.auth.jwt.decode
    # raises before verify_oauth2_token ever looks at the claims.
    if audience != SERVICE_URL:
        raise ValueError(f"Token has wrong audience {SERVICE_URL}, expected one of ['{audience}']")
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _iap_issuer_oidc_verifier(token: str, audience: str) -> dict:
    # A real IAP assertion presented on the Authorization header. Signature
    # and audience could both check out; the issuer is what disqualifies it.
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": IAP_ISSUER}


def _no_email_oidc_verifier(token: str, audience: str) -> dict:
    return {"aud": audience, "iss": GOOGLE_ISSUER}


def test_oidc_accepts_a_valid_token():
    identity = verify_oidc_token("good-token", audience=SERVICE_URL, verify=_ok_oidc_verifier)
    assert identity.email == "caller@x.iam.gserviceaccount.com"
    assert identity.audience == SERVICE_URL


def test_oidc_accepts_the_scheme_less_google_issuer():
    identity = verify_oidc_token(
        "t", audience=SERVICE_URL, verify=_bare_issuer_oidc_verifier
    )
    assert identity.email == "caller@x.iam.gserviceaccount.com"


def test_oidc_rejects_a_missing_token():
    with pytest.raises(AuthError, match="missing Authorization"):
        verify_oidc_token(None, audience=SERVICE_URL, verify=_ok_oidc_verifier)


def test_oidc_rejects_an_empty_token():
    with pytest.raises(AuthError, match="missing Authorization"):
        verify_oidc_token("", audience=SERVICE_URL, verify=_ok_oidc_verifier)


def test_oidc_rejects_an_invalid_signature():
    with pytest.raises(AuthError, match="OIDC token verification failed"):
        verify_oidc_token("bad", audience=SERVICE_URL, verify=_rejecting_verifier)


def test_oidc_rejects_a_wrong_audience():
    with pytest.raises(AuthError, match="OIDC token verification failed"):
        verify_oidc_token(
            "t",
            audience="https://some-other-service-uk.a.run.app",
            verify=_audience_checking_oidc_verifier,
        )


def test_oidc_rejects_an_iap_issuer():
    with pytest.raises(AuthError, match="unexpected issuer"):
        verify_oidc_token("t", audience=SERVICE_URL, verify=_iap_issuer_oidc_verifier)


def test_oidc_rejects_a_missing_issuer_claim():
    with pytest.raises(AuthError, match="unexpected issuer"):
        verify_oidc_token(
            "t",
            audience=SERVICE_URL,
            verify=lambda token, audience: {"email": "a@b.c", "aud": audience},
        )


def test_oidc_rejects_a_missing_email_claim():
    with pytest.raises(AuthError, match="no email claim"):
        verify_oidc_token("t", audience=SERVICE_URL, verify=_no_email_oidc_verifier)


# --- Authorization header parsing ----------------------------------------


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("Bearer good-token", "good-token"),
        ("bearer good-token", "good-token"),  # RFC 7235: scheme is case-insensitive
        ("BEARER good-token", "good-token"),
        ("Bearer  padded-token  ", "padded-token"),
        ("Basic dXNlcjpwdw==", None),  # another scheme is not a bearer token
        ("good-token", None),  # a bare token with no scheme
        ("Bearer", None),
        ("Bearer   ", None),
        ("", None),
        (None, None),
    ],
)
def test_bearer_token_parsing(header, expected):
    assert bearer_token(header) == expected


# --- Mode selection -------------------------------------------------------


def test_default_mode_is_cloud_run_iam_oidc():
    # The deployed posture. If this flips, a deploy that sets no
    # PREDICTION_SERVICE_AUTH_MODE starts 401-ing every real caller.
    assert DEFAULT_AUTH_MODE == AUTH_MODE_OIDC

    dependency = require_caller_dependency(SERVICE_URL, verify=_ok_oidc_verifier)
    identity = dependency(_FakeRequest(authorization="Bearer good-token"))

    assert identity.email == "caller@x.iam.gserviceaccount.com"


def test_unknown_mode_is_refused_at_construction():
    # Not per request: a typo'd mode must break the deploy, not quietly serve.
    with pytest.raises(ValueError, match="unknown auth mode"):
        require_caller_dependency(SERVICE_URL, mode="iap-ish", verify=_ok_oidc_verifier)


def test_oidc_dependency_returns_identity_on_a_valid_bearer_token():
    dependency = require_caller_dependency(
        SERVICE_URL, mode=AUTH_MODE_OIDC, verify=_ok_oidc_verifier
    )

    identity = dependency(_FakeRequest(authorization="Bearer good-token"))

    assert identity.email == "caller@x.iam.gserviceaccount.com"
    assert identity.audience == SERVICE_URL


def test_oidc_dependency_raises_http_401_without_an_authorization_header():
    dependency = require_caller_dependency(
        SERVICE_URL, mode=AUTH_MODE_OIDC, verify=_ok_oidc_verifier
    )

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest())

    assert exc_info.value.status_code == 401


def test_oidc_dependency_raises_http_401_on_a_rejected_token():
    dependency = require_caller_dependency(
        SERVICE_URL, mode=AUTH_MODE_OIDC, verify=_rejecting_verifier
    )

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest(authorization="Bearer bad-token"))

    assert exc_info.value.status_code == 401


def test_oidc_mode_ignores_the_iap_header():
    # The modes do not fall back to each other: an IAP assertion is not a
    # Cloud Run IAM credential, whatever it is signed with.
    dependency = require_caller_dependency(
        SERVICE_URL, mode=AUTH_MODE_OIDC, verify=_ok_oidc_verifier
    )

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest("good-assertion"))

    assert exc_info.value.status_code == 401


def test_iap_mode_ignores_the_authorization_header():
    dependency = require_caller_dependency(
        AUDIENCE, mode=AUTH_MODE_IAP, verify=_ok_verifier
    )

    with pytest.raises(HTTPException) as exc_info:
        dependency(_FakeRequest(authorization="Bearer good-token"))

    assert exc_info.value.status_code == 401


def test_each_mode_defaults_to_its_own_real_verifier():
    # verify=None must never pair one mode's header with the other mode's
    # verifier -- the pairing is what makes the audience/issuer checks line up.
    from tt_services_lib.auth import (
        _DEFAULT_VERIFIERS,
        google_iap_verifier,
        google_oidc_verifier,
    )

    assert _DEFAULT_VERIFIERS[AUTH_MODE_OIDC] is google_oidc_verifier
    assert _DEFAULT_VERIFIERS[AUTH_MODE_IAP] is google_iap_verifier
