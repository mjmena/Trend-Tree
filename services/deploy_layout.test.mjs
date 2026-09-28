// The Dockerfile and services/deploy.sh's crane staging describe the SAME
// image by two different mechanisms — the Dockerfile is what `docker run`
// reproduces locally, the crane staging is what actually ships (there is no
// Docker daemon on a dev Mac and cloudbuild.builds.create is denied in
// mcc-crm-automations). Nothing forces them to agree, so this checks it, for
// every Node service and job that deploy.sh builds.
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
const deploySh = readFileSync(join(SERVICES_DIR, "deploy.sh"), "utf8");

function load(name) {
  const read = (file) => readFileSync(join(SERVICES_DIR, name, file), "utf8");
  const dockerfile = read("Dockerfile");
  const deployEnv = read("deploy.env");
  const envValue = (key) => deployEnv.match(new RegExp(`^${key}=(\\S+)$`, "m"))?.[1];
  // Last occurrence wins: the Dockerfile sets WORKDIR twice (once for the deps
  // stage, once for the runtime stage) and the runtime one is what matters.
  const dockerDirective = (directive) => {
    const hits = [...dockerfile.matchAll(new RegExp(`^\\s*${directive}\\s+(.+)$`, "gm"))];
    return hits.length ? hits.at(-1)[1].trim() : null;
  };
  return {
    name,
    read,
    dockerfile,
    deployEnv,
    kind: envValue("KIND") ?? "service",
    entrypoint: envValue("ENTRYPOINT") ?? "server.mjs",
    envValue,
    dockerDirective,
    lock: JSON.parse(read("package-lock.json")),
  };
}

const UNITS = [load("ecomm-agent"), load("catalog-sync"), load("tiktok-ingest")];

test("crane --workdir is parameterized on the unit name", () => {
  assert.match(deploySh, /--workdir "\/app\/services\/\$NAME"/);
});

test("crane entrypoint is node and its cmd comes from deploy.env's ENTRYPOINT", () => {
  assert.match(deploySh, /--entrypoint node/);
  assert.match(deploySh, /--cmd "\$ENTRYPOINT"/);
  assert.match(deploySh, /ENTRYPOINT="\$\{ENTRYPOINT:-server\.mjs\}"/);
});

test("crane runs as the same non-root user as the Dockerfile", () => {
  assert.match(deploySh, /--user node/);
  for (const u of UNITS) assert.equal(u.dockerDirective("USER"), "node", u.name);
});

test("crane base image matches the Dockerfile's runtime FROM", () => {
  assert.match(deploySh, /BASE_IMAGE:-node:22-slim/);
  for (const u of UNITS) {
    const froms = [...u.dockerfile.matchAll(/^\s*FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.equal(froms.at(-1), "node:22-slim", u.name);
  }
});

test("the staged tree carries services/lib — every unit imports across it", () => {
  assert.match(deploySh, /cp -R "\$REPO_ROOT\/services\/lib"/);
  for (const u of UNITS) assert.match(u.dockerfile, /COPY services\/lib \/app\/services\/lib/, u.name);
});

test("dependencies install from the lockfile, production-only, in both paths", () => {
  assert.match(deploySh, /npm ci --omit=dev --prefix/);
  for (const u of UNITS) assert.match(u.dockerfile, /npm ci --omit=dev/, u.name);
});

test("a local node_modules never leaks into the staged image", () => {
  assert.match(deploySh, /--exclude=node_modules/);
});

for (const u of UNITS) {
  test(`${u.name}: Dockerfile WORKDIR and CMD match what crane sets`, () => {
    assert.equal(u.dockerDirective("WORKDIR"), `/app/services/${u.name}`);
    assert.equal(u.dockerDirective("CMD"), `["node", "${u.entrypoint}"]`);
    assert.ok(u.read(u.entrypoint), `services/${u.name}/${u.entrypoint} must exist`);
  });

  // The cross-build is only sound because every dependency is pure
  // JavaScript. A package with an install script or an os/cpu constraint has
  // platform-specific content, and resolving it on macOS would ship the wrong
  // architecture to linux/amd64 Cloud Run.
  test(`${u.name}: no dependency has native code or a platform constraint`, () => {
    const offenders = Object.entries(u.lock.packages ?? {})
      .filter(([, v]) => v.hasInstallScript || v.os || v.cpu)
      .map(([k]) => k || "(root)");
    assert.deepEqual(
      offenders,
      [],
      `these packages are platform-specific, so the daemon-free cross-build in ` +
        `services/deploy.sh is no longer safe: ${offenders.join(", ")}`,
    );
  });
}

// Google's edge intercepts the exact path /healthz on *.run.app and returns
// its own 404 before Cloud Run sees the request, so a healthy revision fails
// its own dark-deploy smoke test. Diagnosed on CRMA-762.
test("ecomm-agent: the health path is not /healthz, and the server serves what deploy.env probes", () => {
  const u = load("ecomm-agent");
  const health = u.envValue("HEALTH_PATH");
  assert.ok(health, "deploy.env must set HEALTH_PATH");
  assert.notEqual(health, "/healthz", "Google's edge swallows /healthz on *.run.app");
  assert.ok(
    u.read("server.mjs").includes(`route === "${health}"`),
    `server.mjs serves no route matching deploy.env's HEALTH_PATH (${health})`,
  );
});

test("ecomm-agent: deploy.env names a Secret Manager secret that exists", () => {
  // generic-gemini-api-key was confirmed present in mcc-crm-automations on
  // 2026-08-21 (version 1, enabled). The placeholder it replaced did not
  // exist, which would have failed the deploy at `gcloud run deploy`.
  const secrets = load("ecomm-agent").deployEnv.match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.match(secrets, /GEMINI_API_KEY=generic-gemini-api-key:latest/);
  assert.doesNotMatch(secrets, /=gemini-api-key:/, "that secret does not exist in the project");
});

test("catalog-sync: deploys as a job and mounts only the Snowflake key", () => {
  const u = load("catalog-sync");
  assert.equal(u.kind, "job");
  const secrets = u.deployEnv.match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.equal(secrets, "SNOWFLAKE_PRIVATE_KEY=snowflake-private-key:latest");
  assert.match(deploySh, /gcloud run jobs deploy "\$SERVICE"/);
});

test("tiktok-ingest: deploys as a job with one retry, and names its secrets without values", () => {
  const u = load("tiktok-ingest");
  assert.equal(u.kind, "job");
  assert.equal(u.envValue("MAX_RETRIES"), "1");
  const secrets = u.deployEnv.match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.deepEqual(secrets.split(",").sort(), [
    "GEMINI_API_KEY=generic-gemini-api-key:latest",
    "SERPAPI_API_KEY=serpapi-api-key:latest",
    "SNOWFLAKE_PRIVATE_KEY=snowflake-private-key:latest",
  ]);
  assert.doesNotMatch(u.deployEnv, /api_key=|SERPAPI_API_KEY:/, "deploy.env must never hold a key value");
});
