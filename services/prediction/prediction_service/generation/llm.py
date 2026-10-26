"""Re-export of ``tt_services_lib.gemini``, where the Gemini client moved
(CRMA-1668) so the editorial-ingest service can share it. Kept so this
service's imports and tests (``generation.llm``) are unchanged."""

from tt_services_lib.gemini import *  # noqa: F403
