"""Google IAP JWT-assertion verification for authenticated-only ingress
(CRMA-762 AC4).

Revised from a first attempt at bare Cloud Run `run.invoker` + service-to-
service OIDC: that pattern has zero working examples anywhere in the
McClatchy estate (CRMA-509/511 research) and, in practice deploying CRMA-762,
produced an unexplained edge-level 404 with no path to a clear root cause.
Every other locked-down service in the estate (helm, mcc-audience-builder,
mcc-newsletters/dashboard) fronts itself with Cloud Run's native IAP
integration instead (`gcloud beta run deploy --iap --no-allow-unauthenticated`)
-- the proven pattern, confirmed working end to end elsewhere. This module
is the Python-side equivalent of helm's `api/src/iap.mjs` (Node + `jose`),
not a fresh invention.

IAP delivers its signed assertion in the ``X-Goog-IAP-JWT-Assertion`` header
-- a different token from a plain ``Authorization: Bearer`` header, and a
different verification target from Cloud Run's own service-to-service OIDC
(issuer ``https://accounts.google.com``). The IAP assertion's issuer is
``https://cloud.google.com/iap``, verified against IAP's own JWKS endpoint
(``https://www.gstatic.com/iap/verify/public_key-jwk``), with an audience of
the form ``/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}``
for Cloud Run's native IAP integration -- see
https://cloud.google.com/iap/docs/signed-headers-howto. That audience string
is static and known before any deploy (no chicken-and-egg URL bootstrap,
unlike the bare-OIDC attempt this replaces).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException, Request
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token

IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"
IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion"


class AuthError(Exception):
    """A request could not be authenticated. The message is caller-safe."""


@dataclass(frozen=True)
class CallerIdentity:
    email: str
    audience: str


class TokenVerifier(Protocol):
    """Decodes and verifies a raw IAP JWT assertion, returning its claims.
    Raises on any invalid assertion (bad signature, expired, wrong
    audience...). The real implementation (``google_iap_verifier``) wraps
    ``google.oauth2.id_token.verify_token`` against IAP's JWKS endpoint;
    tests substitute a fake that returns canned claims or raises -- no
    network, no real signed assertion.
    """

    def __call__(self, token: str, audience: str) -> dict[str, Any]: ...


def google_iap_verifier(token: str, audience: str) -> dict[str, Any]:
    return id_token.verify_token(
        token, GoogleAuthRequest(), audience=audience, certs_url=IAP_JWKS_URL
    )


def verify_iap_assertion(
    assertion: str | None,
    *,
    audience: str,
    verify: TokenVerifier = google_iap_verifier,
) -> CallerIdentity:
    """Verify the ``X-Goog-IAP-JWT-Assertion`` header value against
    ``audience`` (this service's IAP audience string, not its URL). Raises
    ``AuthError`` on anything that doesn't check out -- missing header,
    malformed, wrong/expired signature, or an audience mismatch.
    """
    if not assertion:
        raise AuthError(f"missing {IAP_ASSERTION_HEADER} header")
    try:
        claims = verify(assertion, audience)
    except Exception as err:  # noqa: BLE001 - normalized into AuthError for the caller
        raise AuthError(f"IAP assertion verification failed: {err}") from err
    email = claims.get("email")
    if not email:
        raise AuthError("IAP assertion carries no email claim")
    return CallerIdentity(email=email, audience=audience)


def require_caller_dependency(
    audience: str,
    *,
    verify: TokenVerifier = google_iap_verifier,
):
    """Returns a FastAPI ``Depends``-compatible callable bound to ``audience``
    and a verifier -- the indirection point tests substitute a fake verifier
    through, so route tests never need a real IAP-signed assertion.

    This is defense-in-depth: IAP itself already blocks any request that
    doesn't carry a valid assertion before it reaches this container. Reading
    the header again here means the app can log/act on *which* identity
    called it, and never trusts the edge check blindly.
    """

    def _dependency(request: Request) -> CallerIdentity:
        try:
            return verify_iap_assertion(
                request.headers.get(IAP_ASSERTION_HEADER), audience=audience, verify=verify
            )
        except AuthError as err:
            raise HTTPException(status_code=401, detail=str(err)) from err

    return _dependency
