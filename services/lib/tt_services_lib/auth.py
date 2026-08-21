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

import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException, Request
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token

IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"
IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion"
# The only issuer an IAP assertion may carry. ``id_token.verify_token``
# checks the signature, ``exp``/``iat`` and ``aud`` -- but *not* ``iss``
# (only ``verify_oauth2_token`` does, and it hard-codes Google's own
# accounts.google.com issuer, which is the wrong one here). Verified against
# the installed google-auth source, not assumed. So we assert it ourselves.
IAP_ISSUER = "https://cloud.google.com/iap"

# IAP rotates its JWKS slowly; google-auth's ``_fetch_certs`` does no caching
# at all, so without this every authenticated request paid a fresh TLS
# round-trip to www.gstatic.com before it could verify anything.
_JWKS_TTL_SECONDS = 3600


class _CachedResponse:
    """The two attributes ``google.oauth2.id_token._fetch_certs`` reads off a
    transport response (``status``/``data``), captured so it can be replayed
    from cache."""

    __slots__ = ("status", "data")

    def __init__(self, status: int, data: bytes) -> None:
        self.status = status
        self.data = data


class _JwksCachingRequest:
    """A ``google.auth.transport.Request`` that memoizes *only* the IAP JWKS
    GET, for ``ttl`` seconds. Every other request passes straight through
    untouched, and a non-200 is never cached.
    """

    def __init__(
        self, inner: Any, *, url: str, ttl: float, min_refresh_interval: float = 60.0
    ) -> None:
        self._inner = inner
        self._url = url
        self._ttl = ttl
        self._min_refresh_interval = min_refresh_interval
        self._lock = threading.Lock()
        self._fetched_at = 0.0
        self._cached: tuple[float, _CachedResponse] | None = None

    def __call__(self, url: str, method: str = "GET", **kwargs: Any) -> Any:
        if url != self._url or method != "GET":
            return self._inner(url, method=method, **kwargs)
        now = time.monotonic()
        with self._lock:
            if self._cached is not None and now < self._cached[0]:
                return self._cached[1]
        response = self._inner(url, method=method, **kwargs)
        status = getattr(response, "status", None)
        if status == 200:
            cached = _CachedResponse(status, response.data)
            with self._lock:
                self._fetched_at = time.monotonic()
                self._cached = (self._fetched_at + self._ttl, cached)
            return cached
        return response

    def invalidate(self) -> bool:
        """Drop the cached key set so the next call refetches -- but at most
        once per ``min_refresh_interval``, so a flood of bad tokens can't turn
        into a flood of JWKS fetches. Returns whether anything was dropped.
        """
        with self._lock:
            if self._cached is None:
                return False
            if time.monotonic() - self._fetched_at < self._min_refresh_interval:
                return False
            self._cached = None
            return True


# Module-level so the underlying requests.Session (and its connection pool)
# is reused across calls instead of rebuilt per request.
_iap_jwks_request = _JwksCachingRequest(
    GoogleAuthRequest(), url=IAP_JWKS_URL, ttl=_JWKS_TTL_SECONDS
)


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
    """Verify against IAP's JWKS (cached, see ``_JwksCachingRequest``). A
    signature failure on a cached key set is retried once against a freshly
    fetched one, so a key rotation inside the TTL window self-heals instead
    of 401-ing every caller until the TTL expires.
    """
    try:
        return id_token.verify_token(
            token, _iap_jwks_request, audience=audience, certs_url=IAP_JWKS_URL
        )
    except Exception:
        # Rate-limited (see ``invalidate``): a flood of bad tokens refetches
        # the key set at most once a minute, and if the cache was refreshed
        # too recently to be the suspect, the original error stands.
        if not _iap_jwks_request.invalidate():
            raise
        return id_token.verify_token(
            token, _iap_jwks_request, audience=audience, certs_url=IAP_JWKS_URL
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
    malformed, wrong/expired signature, an audience mismatch, or an issuer
    that isn't IAP.

    The ``iss`` check happens *here* rather than inside ``google_iap_verifier``
    on purpose: it then holds for every verifier this seam is given, including
    a substituted one, so no verifier can silently widen what counts as an IAP
    assertion.
    """
    if not assertion:
        raise AuthError(f"missing {IAP_ASSERTION_HEADER} header")
    try:
        claims = verify(assertion, audience)
    except Exception as err:  # noqa: BLE001 - normalized into AuthError for the caller
        raise AuthError(f"IAP assertion verification failed: {err}") from err
    issuer = claims.get("iss")
    if issuer != IAP_ISSUER:
        raise AuthError(f"IAP assertion has unexpected issuer: {issuer!r}")
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
