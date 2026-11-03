// services/deploy.sh end to end against fake gcloud / crane / npm (CRMA-1454).
//
// A failed `gcloud run services describe` (expired credentials, a network
// error, an API 500) used to read as "the service does not exist", which sends
// deploy.sh down the bootstrap branch: a deploy WITHOUT --no-traffic, so an
// unprobed revision serves 100% before the smoke test runs. The script runs
// from a throwaway git repo so its clean-tree check passes whatever state this
// checkout is in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

function exe(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// describe: the canned outcome of `gcloud run services describe`.
function runDeploy({ describe }) {
  const root = mkdtempSync(join(tmpdir(), "deploy-describe-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const service = `trend-tree-demo-${randomUUID().slice(0, 8)}`;
  const deployLog = join(root, "deploys.log");
  for (const d of [join(repo, "services/demo"), join(repo, "services/lib"), join(repo, "services/prediction/deploy"), bin]) {
    mkdirSync(d, { recursive: true });
  }
  copyFileSync(join(SERVICES_DIR, "deploy.sh"), join(repo, "services/deploy.sh"));
  copyFileSync(join(SERVICES_DIR, "prediction/deploy/lib.sh"), join(repo, "services/prediction/deploy/lib.sh"));
  writeFileSync(join(repo, "services/lib/keep.mjs"), "");
  writeFileSync(join(repo, "services/demo/Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repo, "services/demo/server.mjs"), "");
  writeFileSync(
    join(repo, "services/demo/deploy.env"),
    [
      `SERVICE=${service}`,
      "PROJECT=mcc-crm-automations",
      "REGION=us-east4",
      "REPO=mcc",
      "SERVICE_ACCOUNT=sa@example.iam.gserviceaccount.com",
      "TIMEOUT=60",
      "PORT=8080",
      "HEALTH_PATH=/health",
    ].join("\n") + "\n",
  );
  const git = (...args) =>
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");

  exe(
    join(bin, "gcloud"),
    `case "$*" in
  "run services describe"*) ${describe} ;;
  "run deploy"*) echo "$*" >> "${deployLog}" ;;
  "auth print-access-token"*) echo fake-token ;;
esac`,
  );
  exe(join(bin, "crane"), 'cat >/dev/null; echo "image@sha256:0"');
  exe(join(bin, "npm"), "true");

  const proc = spawnSync("bash", [join(repo, "services/deploy.sh"), "demo"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const result = { proc, deployed: existsSync(deployLog), leftovers: readdirSync(tmpdir()).filter((f) => f.startsWith(`${service}-`)) };
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("a failed describe aborts before any deploy", () => {
  const { proc, deployed } = runDeploy({
    describe: "echo 'ERROR: (gcloud.run.services.describe) Reauthentication failed.' >&2; exit 1",
  });
  assert.notEqual(proc.status, 0);
  assert.equal(deployed, false, "gcloud run deploy must not run");
  assert.match(proc.stderr, /Reauthentication failed/);
});

test("the build context and env file are removed when the script exits", () => {
  const { leftovers } = runDeploy({
    describe: "echo 'ERROR: (gcloud.run.services.describe) Reauthentication failed.' >&2; exit 1",
  });
  assert.deepEqual(leftovers, []);
});

test("a not-found describe still takes the bootstrap path", () => {
  const { deployed, proc } = runDeploy({
    describe: "echo 'ERROR: (gcloud.run.services.describe) Cannot find service [demo]' >&2; exit 1",
  });
  assert.equal(deployed, true, proc.stderr);
});
