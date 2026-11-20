import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run_sourcing_poll_tests.sh", import.meta.url));

for (const [name, fixtureStatus, cleanupStatus, expectedStatus] of [
  ["success", 0, 0, 0],
  ["early SQL failure", 7, 0, 7],
  ["cleanup failure after success", 0, 9, 1],
  ["cleanup failure after SQL failure", 7, 9, 7],
]) {
  test(`poll runner performs exit cleanup and preserves status: ${name}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "poll-runner-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "calls");
    writeFileSync(join(dir, "snow"), `#!/usr/bin/env bash
if [[ "$*" == *"sourcing_poll_cleanup.sql"* ]]; then
  echo cleanup >> "$POLL_TEST_LOG"
  if [[ $(wc -l < "$POLL_TEST_LOG") -gt 1 ]]; then exit "$POLL_CLEANUP_STATUS"; fi
else
  echo fixture >> "$POLL_TEST_LOG"
  exit "$POLL_FIXTURE_STATUS"
fi
`, { mode: 0o755 });
    const result = spawnSync("bash", [runner], {
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, POLL_TEST_LOG: log,
        POLL_FIXTURE_STATUS: String(fixtureStatus), POLL_CLEANUP_STATUS: String(cleanupStatus),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["cleanup", "fixture", "cleanup"]);
    if (cleanupStatus) assert.match(result.stderr, /fixture cleanup failed/);
  });
}
