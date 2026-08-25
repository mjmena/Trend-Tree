// The Dockerfile and services/deploy.sh's crane staging describe the SAME
// image by two different mechanisms — the Dockerfile is what `docker run`
// reproduces locally, the crane staging is what actually ships (there is no
// Docker daemon on a dev Mac and cloudbuild.builds.create is denied in
// mcc-crm-automations). Nothing forces them to agree, so this checks it.
//
// A mismatch here is not cosmetic: if the crane `--workdir` and the
// Dockerfile's WORKDIR drift apart, the image starts in the wrong directory
// and `node server.mjs` fails at startup — visible only after a push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE = "ecomm-agent";

const deploySh = readFileSync(join(SERVICES_DIR, "deploy.sh"), "utf8");
const dockerfile = readFileSync(join(SERVICES_DIR, SERVICE, "Dockerfile"), "utf8");
const deployEnv = readFileSync(join(SERVICES_DIR, SERVICE, "deploy.env"), "utf8");
const server = readFileSync(join(SERVICES_DIR, SERVICE, "server.mjs"), "utf8");
const lock = JSON.parse(readFileSync(join(SERVICES_DIR, SERVICE, "package-lock.json"), "utf8"));

// Last occurrence wins: the Dockerfile sets WORKDIR twice (once for the deps
// stage, once for the runtime stage) and the runtime one is what matters.
const dockerDirective = (name) => {
  const hits = [...dockerfile.matchAll(new RegExp(`^\\s*${name}\\s+(.+)$`, "gm"))];
  return hits.length ? hits.at(-1)[1].trim() : null;
};

test("crane --workdir matches the Dockerfile's runtime WORKDIR", () => {
  assert.equal(dockerDirective("WORKDIR"), `/app/services/${SERVICE}`);
  assert.match(deploySh, /--workdir "\/app\/services\/\$NAME"/);
});

test("crane entrypoint+cmd match the Dockerfile's CMD", () => {
  assert.equal(dockerDirective("CMD"), '["node", "server.mjs"]');
  assert.match(deploySh, /--entrypoint node/);
  assert.match(deploySh, /--cmd server\.mjs/);
});

test("crane runs as the same non-root user as the Dockerfile", () => {
  assert.equal(dockerDirective("USER"), "node");
  assert.match(deploySh, /--user node/);
});

test("crane base image matches the Dockerfile's runtime FROM", () => {
  const froms = [...dockerfile.matchAll(/^\s*FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.at(-1), "node:22-slim");
  assert.match(deploySh, /BASE_IMAGE:-node:22-slim/);
});

test("the staged tree carries services/lib — the service imports across it", () => {
  assert.match(dockerfile, /COPY services\/lib \/app\/services\/lib/);
  assert.match(deploySh, /cp -R "\$REPO_ROOT\/services\/lib"/);
});

test("dependencies install from the lockfile, production-only, in both paths", () => {
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(deploySh, /npm ci --omit=dev --prefix/);
});

test("a local node_modules never leaks into the staged image", () => {
  assert.match(deploySh, /--exclude=node_modules/);
});

// The cross-build is only sound because every dependency is pure JavaScript.
// A package with an install script or an os/cpu constraint has platform
// -specific content, and resolving it on macOS would ship the wrong
// architecture to a linux/amd64 Cloud Run service.
test("no dependency has native code or a platform constraint", () => {
  const offenders = Object.entries(lock.packages ?? {})
    .filter(([, v]) => v.hasInstallScript || v.os || v.cpu)
    .map(([k]) => k || "(root)");
  assert.deepEqual(
    offenders,
    [],
    `these packages are platform-specific, so the daemon-free cross-build in ` +
      `services/deploy.sh is no longer safe: ${offenders.join(", ")}`,
  );
});

// Google's edge intercepts the exact path /healthz on *.run.app and returns
// its own 404 before Cloud Run sees the request, so a healthy revision fails
// its own dark-deploy smoke test. Diagnosed on CRMA-762.
test("the health path is not /healthz, and the server serves what deploy.env probes", () => {
  const health = deployEnv.match(/^HEALTH_PATH=(\S+)$/m)?.[1];
  assert.ok(health, "deploy.env must set HEALTH_PATH");
  assert.notEqual(health, "/healthz", "Google's edge swallows /healthz on *.run.app");
  assert.ok(
    server.includes(`route === "${health}"`),
    `server.mjs serves no route matching deploy.env's HEALTH_PATH (${health})`,
  );
});

test("deploy.env names a Secret Manager secret that exists", () => {
  // generic-gemini-api-key was confirmed present in mcc-crm-automations on
  // 2026-08-21 (version 1, enabled). The placeholder it replaced did not
  // exist, which would have failed the deploy at `gcloud run deploy`.
  const secrets = deployEnv.match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.match(secrets, /GEMINI_API_KEY=generic-gemini-api-key:latest/);
  assert.doesNotMatch(secrets, /=gemini-api-key:/, "that secret does not exist in the project");
});
