#!/usr/bin/env bash
# Run the agents/lib pure-function unit tests (ADR-0004 #60 and friends).
# Explicit file list — `node --test <dir>` is flaky across Node versions.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --test agents/lib/*.test.mjs
