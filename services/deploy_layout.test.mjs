// The Dockerfile and services/deploy.sh's crane staging describe the SAME
// image by two different mechanisms — the Dockerfile is what `docker run`
// reproduces locally, the crane staging is what actually ships (there is no
// Docker daemon on a dev Mac and cloudbuild.builds.create is denied in
// mcc-crm-automations). Nothing forces them to agree, so this checks it.
//
// A mismatch here is not cosmetic: if the crane `--workdir` and the
// Dockerfile's WORKDIR drift apart, the image starts in the wrong directory
// and `node server.mjs` fails at startup — visible only after a push.
//
// deploy.sh is generic over the service name, so its own assertions run once.
// Everything read out of a service directory runs per service (CRMA-986 added
// the second one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICES = ["ecomm-agent", "scrape-gateway"];

const deploySh = readFileSync(join(SERVICES_DIR, "deploy.sh"), "utf8");

const read = (service, file) => readFileSync(join(SERVICES_DIR, service, file), "utf8");

// Last occurrence wins: a Dockerfile sets WORKDIR twice (once for the deps
// stage, once for the runtime stage) and the runtime one is what matters.
const dockerDirective = (dockerfile, name) => {
  const hits = [...dockerfile.matchAll(new RegExp(`^\\s*${name}\\s+(.+)$`, "gm"))];
  return hits.length ? hits.at(-1)[1].trim() : null;
};

// --- deploy.sh, once --------------------------------------------------------

test("crane stages the workdir, entrypoint, user and base image generically", () => {
  assert.match(deploySh, /--workdir "\/app\/services\/\$NAME"/);
  assert.match(deploySh, /--entrypoint node/);
  assert.match(deploySh, /--cmd server\.mjs/);
  assert.match(deploySh, /--user node/);
  assert.match(deploySh, /BASE_IMAGE:-node:22-slim/);
});

test("the staged tree carries services/lib — every service imports across it", () => {
  assert.match(deploySh, /cp -R "\$REPO_ROOT\/services\/lib"/);
});

test("dependencies install from the lockfile, production-only, in the deploy path", () => {
  assert.match(deploySh, /npm ci --omit=dev --prefix/);
});

test("a local node_modules never leaks into the staged image", () => {
  assert.match(deploySh, /--exclude=node_modules/);
});

// --- per service ------------------------------------------------------------

for (const service of SERVICES) {
  const dockerfile = read(service, "Dockerfile");
  const deployEnv = read(service, "deploy.env");
  const server = read(service, "server.mjs");
  const lock = JSON.parse(read(service, "package-lock.json"));

  test(`${service}: the Dockerfile's runtime WORKDIR matches crane's --workdir`, () => {
    assert.equal(dockerDirective(dockerfile, "WORKDIR"), `/app/services/${service}`);
  });

  test(`${service}: the Dockerfile's CMD, USER and base image match crane's staging`, () => {
    assert.equal(dockerDirective(dockerfile, "CMD"), '["node", "server.mjs"]');
    assert.equal(dockerDirective(dockerfile, "USER"), "node");
    const froms = [...dockerfile.matchAll(/^\s*FROM\s+(\S+)/gm)].map((m) => m[1]);
    assert.equal(froms.at(-1), "node:22-slim");
  });

  test(`${service}: the image carries services/lib and installs from the lockfile`, () => {
    assert.match(dockerfile, /COPY services\/lib \/app\/services\/lib/);
    assert.match(dockerfile, /npm ci --omit=dev/);
  });

  // A service with no dependencies is a real case here (scrape-gateway needs
  // only Node 22's global fetch), and it breaks the deps-stage pattern in a
  // way that is invisible until a build: `npm ci` with nothing to install
  // creates NO node_modules directory, so the runtime stage's
  // `COPY --from=deps /deps/node_modules` fails on a missing source path.
  // deploy.sh is unaffected — it installs in place in the staged tree — so
  // this breaks only local reproduction, which is exactly the Dockerfile/crane
  // drift this file exists to catch.
  test(`${service}: a zero-dependency image still creates the node_modules it copies`, () => {
    const deps = Object.keys(lock.packages ?? {}).filter((k) => k !== "");
    if (deps.length > 0) return;
    assert.match(
      dockerfile,
      /mkdir -p \/deps\/node_modules/,
      `${service} declares no dependencies, so npm ci creates no node_modules and ` +
        `the runtime stage's COPY --from=deps would fail — the deps stage must mkdir it`,
    );
  });

  // The cross-build is only sound because every dependency is pure JavaScript.
  // A package with an install script or an os/cpu constraint has platform
  // -specific content, and resolving it on macOS would ship the wrong
  // architecture to a linux/amd64 Cloud Run service.
  test(`${service}: no dependency has native code or a platform constraint`, () => {
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
  test(`${service}: the health path is not /healthz, and the server serves what deploy.env probes`, () => {
    const health = deployEnv.match(/^HEALTH_PATH=(\S+)$/m)?.[1];
    assert.ok(health, "deploy.env must set HEALTH_PATH");
    assert.notEqual(health, "/healthz", "Google's edge swallows /healthz on *.run.app");
    assert.ok(
      server.includes(`route === "${health}"`),
      `server.mjs serves no route matching deploy.env's HEALTH_PATH (${health})`,
    );
  });

  // deploy.env names secrets, never values. A value here would be committed.
  test(`${service}: deploy.env names secrets rather than carrying values`, () => {
    const secrets = deployEnv.match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
    for (const pair of secrets.split(",").filter(Boolean)) {
      assert.match(
        pair.trim(),
        /^[A-Z0-9_]+=[a-z0-9-]+:(latest|\d+)$/,
        `${pair} is not ENV_NAME=secret-name:version — a literal value must never land here`,
      );
    }
  });
}

// --- service-specific secret bindings ---------------------------------------

test("ecomm-agent names a Secret Manager secret that exists", () => {
  // generic-gemini-api-key was confirmed present in mcc-crm-automations on
  // 2026-08-21 (version 1, enabled). The placeholder it replaced did not
  // exist, which would have failed the deploy at `gcloud run deploy`.
  const secrets = read("ecomm-agent", "deploy.env").match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.match(secrets, /GEMINI_API_KEY=generic-gemini-api-key:latest/);
  assert.doesNotMatch(secrets, /=gemini-api-key:/, "that secret does not exist in the project");
});

// brightdata-api-key is NEW to the project — unlike the ecomm agent's secrets
// it does not exist yet, and `gcloud run deploy` fails outright if a named
// secret is absent. CRMA-986 creates it during vendor provisioning. This
// asserts the name the deploy will look for, so a typo is caught here rather
// than at the first deploy.
test("scrape-gateway names the Bright Data key it expects provisioning to create", () => {
  const secrets = read("scrape-gateway", "deploy.env").match(/^SECRETS="([^"]*)"/m)?.[1] ?? "";
  assert.match(secrets, /BRIGHTDATA_API_KEY=brightdata-api-key:latest/);
});

// The Web Unlocker zone is Kickstarter's, and it is a control-panel object
// rather than a dataset id that can be read off a docs page. Provisioned
// 2026-09-07 and verified end-to-end: it returned Kickstarter's discover JSON
// through Turnstile with no challenge (CRMA-986 gate check 2).
test("scrape-gateway names the provisioned Web Unlocker zone", () => {
  const env = read("scrape-gateway", "deploy.env");
  const zone = env.match(/^BD_WEB_UNLOCKER_ZONE: '([^']*)'$/m)?.[1];
  assert.ok(zone, "deploy.env must declare BD_WEB_UNLOCKER_ZONE");
  assert.equal(zone, "trend_tree_scoping");
  assert.doesNotMatch(zone, /REPLACE_ME/, "the placeholder was never replaced");
});
