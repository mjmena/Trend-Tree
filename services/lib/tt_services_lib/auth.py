"""Google ingress verification for authenticated-only Cloud Run services
(CRMA-762 AC4), in two modes -- Cloud Run IAM (OIDC) and IAP.

**Cloud Run IAM (``oidc``) is the deployed posture** and this module's
default. The service runs with ``--no-allow-unauthenticated`` and IAP off, so
Google's frontend enforces ``roles/run.invoker`` and callers present a plain
``Authorization: Bearer <id_token>`` header, issued by
``https://accounts.google.com`` with the *service URL* as its audience.

**IAP (``iap``) is retained, not dead code.** It is the pattern most other
locked-down services in the McClatchy estate use (helm, mcc-audience-builder,
mcc-newsletters/dashboard; this module is the Python-side equivalent of
helm's ``api/src/iap.mjs``), and CRMA-762 shipped behind it first, so it stays
selectable rather than being deleted and re-derived if IAP is reinstated.

The earlier edge-level 404 that motivated the original switch *away* from bare
Cloud Run IAM was not a flaw in the OIDC pattern: the service had been
deployed with ``run.googleapis.com/invoker-iam-disabled: true`` while IAP was
never actually provisioned (zero bindings on its IAP IAM policy), so no
authorization layer was bound at all and the frontend answered a generic 404
to everything. With the invoker IAM check re-enabled the service authorizes
correctly and returns 403 to unauthenticated callers.

The two modes differ in every particular that matters, which is why they are
separate verification paths rather than one parameterized one:

===============  ==================================  ============================
                 IAP                                 Cloud Run IAM (OIDC)
===============  ==================================  ============================
token header     ``X-Goog-IAP-JWT-Assertion``        ``Authorization: Bearer ...``
issuer           ``https://cloud.google.com/iap``    ``https://accounts.google.com``
audience         ``/projects/{NUM}/locations/        the service URL, e.g.
                 {REGION}/services/{SERVICE}``       ``https://svc-xxxx-uk.a.run.app``
signing keys     gstatic IAP JWKS                    googleapis OAuth2 certs
===============  ==================================  ============================

See https://cloud.google.com/iap/docs/signed-headers-howto and
https://cloud.google.com/run/docs/authenticating/service-to-service.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import HTTPException, Request
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token

# Which ingress-auth layer this service sits behind. `oidc` is the deployed
# posture (Cloud Run IAM); `iap` is kept selectable for a reinstatement.
AUTH_MODE_OIDC = "oidc"
AUTH_MODE_IAP = "iap"
AUTH_MODES = (AUTH_MODE_OIDC, AUTH_MODE_IAP)
DEFAULT_AUTH_MODE = AUTH_MODE_OIDC

IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"
IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion"
# The only issuer an IAP assertion may carry. ``id_token.verify_token``
# checks the signature, ``exp``/``iat`` and ``aud`` -- but *not* ``iss``
# (only ``verify_oauth2_token`` does, and it hard-codes Google's own
# accounts.google.com issuer, which is the wrong one here). Verified against
# the installed google-auth source, not assumed. So we assert it ourselves.
IAP_ISSUER = "https://cloud.google.com/iap"

AUTHORIZATION_HEADER = "authorization"
_BEARER_SCHEME = "bearer"
# The certs ``verify_oauth2_token`` uses internally (google-auth's private
# ``_GOOGLE_OAUTH2_CERTS_URL``). Named here only so the caching transport
# below can recognize that fetch; the value it passes is google-auth's.
GOOGLE_OAUTH2_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"
# google-auth's own ``_GOOGLE_ISSUERS``. ``verify_oauth2_token`` already
# rejects anything else (checked against the installed source: it does
# `if idinfo["iss"] not in _GOOGLE_ISSUERS: raise GoogleAuthError`), but we
# re-assert it below so the check holds for a substituted verifier too.
GOOGLE_OIDC_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

# Google rotates these key sets slowly; google-auth's ``_fetch_certs`` does no
# caching at all, so without this every authenticated request paid a fresh TLS
# round-trip before it could verify anything.
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
    """A ``google.auth.transport.Request`` that memoizes *only* the key-set
    GET at ``url``, for ``ttl`` seconds. Every other request passes straight
    through untouched, and a non-200 is never cached.
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
# is reused across calls instead of rebuilt per request. One per key set: the
# two modes verify against different signing keys.
_iap_jwks_request = _JwksCachingRequest(
    GoogleAuthRequest(), url=IAP_JWKS_URL, ttl=_JWKS_TTL_SECONDS
)
_oidc_certs_request = _JwksCachingRequest(
    GoogleAuthRequest(), url=GOOGLE_OAUTH2_CERTS_URL, ttl=_JWKS_TTL_SECONDS
)


class AuthError(Exception):
    """A request could not be authenticated. The message is caller-safe."""


@dataclass(frozen=True)
class CallerIdentity:
    email: str
    audience: str


class TokenVerifier(Protocol):
    """Decodes and verifies a raw JWT, returning its claims. Raises on any
    invalid token (bad signature, expired, wrong audience...). The real
    implementations (``google_iap_verifier`` / ``google_oidc_verifier``) wrap
    ``google.oauth2.id_token``; tests substitute a fake that returns canned
    claims or raises -- no network, no real signed token.
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


def google_oidc_verifier(token: str, audience: str) -> dict[str, Any]:
    """Verify a Google-issued OIDC ID token -- the ``Authorization: Bearer``
    token a Cloud Run IAM caller sends. Same cache-and-retry-once shape as the
    IAP verifier, against Google's OAuth2 certs rather than IAP's JWKS.

    Read off the installed google-auth (2.56.3), ``verify_oauth2_token``:
    it delegates to ``verify_token`` (signature, ``iat``/``exp`` via
    ``_verify_iat_and_exp``, and ``aud`` -- rejecting any token whose ``aud``
    is not the one passed) and *then*, unlike ``verify_token``, checks
    ``idinfo["iss"] in ("accounts.google.com", "https://accounts.google.com")``.
    What it does not do: any check of ``email_verified``, ``azp``, or who the
    caller is -- authorization is Cloud Run IAM's job at the edge.
    """
    try:
        return id_token.verify_oauth2_token(token, _oidc_certs_request, audience=audience)
    except Exception:
        if not _oidc_certs_request.invalidate():
            raise
        return id_token.verify_oauth2_token(token, _oidc_certs_request, audience=audience)


def bearer_token(header_value: str | None) -> str | None:
    """The token out of an ``Authorization: Bearer <token>`` header value, or
    None if the header is absent, carries another scheme, or has no token
    after the scheme. The scheme match is case-insensitive per RFC 7235.
    """
    if not header_value:
        return None
    scheme, _, token = header_value.partition(" ")
    if scheme.lower() != _BEARER_SCHEME:
        return None
    token = token.strip()
    return token or None


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


def verify_oidc_token(
    token: str | None,
    *,
    audience: str,
    verify: TokenVerifier = google_oidc_verifier,
) -> CallerIdentity:
    """Verify a Cloud Run IAM caller's OIDC ID token against ``audience``
    (this service's URL, not an IAP audience string). Raises ``AuthError`` on
    a missing token, a bad/expired signature, an audience mismatch, or a
    non-Google issuer.

    ``google_oidc_verifier`` already rejects a non-Google ``iss``; asserting
    it again here means the check also holds for a substituted verifier, the
    same reason ``verify_iap_assertion`` does it.
    """
    if not token:
        raise AuthError("missing Authorization: Bearer <id_token> header")
    try:
        claims = verify(token, audience)
    except Exception as err:  # noqa: BLE001 - normalized into AuthError for the caller
        raise AuthError(f"OIDC token verification failed: {err}") from err
    issuer = claims.get("iss")
    if issuer not in GOOGLE_OIDC_ISSUERS:
        raise AuthError(f"OIDC token has unexpected issuer: {issuer!r}")
    email = claims.get("email")
    if not email:
        raise AuthError("OIDC token carries no email claim")
    return CallerIdentity(email=email, audience=audience)


_DEFAULT_VERIFIERS: dict[str, TokenVerifier] = {
    AUTH_MODE_OIDC: google_oidc_verifier,
    AUTH_MODE_IAP: google_iap_verifier,
}


def require_caller_dependency(
    audience: str,
    *,
    mode: str = DEFAULT_AUTH_MODE,
    verify: TokenVerifier | None = None,
):
    """Returns a FastAPI ``Depends``-compatible callable bound to ``audience``,
    an auth ``mode`` and a verifier -- the indirection point tests substitute a
    fake verifier through, so route tests never need a real signed token.
    ``verify=None`` means "the real verifier for this mode", so a caller can
    never pair the IAP verifier with the OIDC header, or vice versa.

    ``mode`` selects where the token comes from and what must have signed it:
    ``oidc`` (default) is Cloud Run IAM, the service's deployed posture --
    ``Authorization: Bearer`` signed by accounts.google.com, audience = the
    service URL. ``iap`` is the alternative, retained for a reinstatement --
    the ``X-Goog-IAP-JWT-Assertion`` header signed by IAP. An unknown mode
    raises here, at construction, rather than failing per request.

    This is defense-in-depth either way: the edge (Cloud Run IAM, or IAP)
    already rejects a caller without a valid token before it reaches this
    container. Verifying again here means the app can log/act on *which*
    identity called it, and never trusts the edge check blindly.
    """
    if mode not in AUTH_MODES:
        raise ValueError(f"unknown auth mode {mode!r}; expected one of {AUTH_MODES}")
    verify_token = _DEFAULT_VERIFIERS[mode] if verify is None else verify

    def _dependency(request: Request) -> CallerIdentity:
        try:
            if mode == AUTH_MODE_IAP:
                return verify_iap_assertion(
                    request.headers.get(IAP_ASSERTION_HEADER),
                    audience=audience,
                    verify=verify_token,
                )
            if mode == AUTH_MODE_OIDC:
                return verify_oidc_token(
                    bearer_token(request.headers.get(AUTHORIZATION_HEADER)),
                    audience=audience,
                    verify=verify_token,
                )
            # Unreachable today -- `mode` was checked against AUTH_MODES at
            # construction. Spelled out anyway so that adding a third mode to
            # AUTH_MODES without a branch here fails CLOSED (401) instead of
            # silently being handled as OIDC, which an `else` would have done.
            raise AuthError(f"auth mode {mode!r} has no verification path")
        except AuthError as err:
            raise HTTPException(status_code=401, detail=str(err)) from err

    return _dependency
