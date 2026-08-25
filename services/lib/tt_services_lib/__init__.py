"""Shared library for Trend Tree's services/ namespace (CRMA-762).

Two modules, both extracted so later agent extractions under services/ inherit
them instead of reinventing:

- ``snowflake_client``: a retrying Snowflake client (Protocol + real impl).
- ``auth``: Google OIDC bearer-token verification for authenticated-only
  Cloud Run ingress.

Not pip-installed in the deployed image -- copied as a sibling source
directory next to each service's own package (see each service's
deploy/deploy.sh and Dockerfile), and added to sys.path locally via each
service's ``[tool.pytest.ini_options] pythonpath`` entry for tests.
"""

from __future__ import annotations
