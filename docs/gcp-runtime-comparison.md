# GCP Runtime Comparison — Facts (CRMA-435)

## The question

For a service shaped like Trend Tree's enrichment/agent workflows — synchronous HTTP endpoint,
3–5 min wall-clock per request, Node.js, outbound calls to Snowflake + Anthropic + social/search
APIs, low volume (~tens of requests/day), occasional small fan-out bursts (several requests at
once) — gather concrete facts for four GCP runtimes:

1. Cloud Run (services)
2. Cloud Functions 2nd gen (Cloud Run functions)
3. GKE Autopilot
4. Plain GCE VM

Dimensions: request timeout limits, concurrency model, cold starts / min-instances, **local-dev
story (weighted heaviest)**, deploy/rollback mechanics, pricing at ~30 req/day × 4 min ×
1 vCPU / 1 GiB, secret/credential integration.

Facts only — no runtime recommendation (that's CRMA-436). All sources are official Google docs
(docs.cloud.google.com / cloud.google.com pricing pages) plus official tool docs
(functions-framework GitHub, skaffold.dev), fetched 2026-08-07.

## Fact matrix

| | Cloud Run (services) | Functions 2nd gen | GKE Autopilot | GCE VM |
|---|---|---|---|---|
| Max sync HTTP timeout | 60 min (default 5 min) | 60 min HTTP (gen1: 9 min) | none (yours/LB's) | none |
| 5-min request OK? | yes | yes (gen2 only) | yes | yes |
| Concurrency | 1–1000/instance, default 80; autoscales | same (it is Cloud Run) | your server + HPA (min 1 replica) | your server |
| 5-request burst | one instance or fan-out per `--concurrency` | same | absorbed in-process | absorbed in-process |
| Scale to zero | yes (default) | yes | no (native) | no |
| Cold start | container boot on scale-from-0; `min-instances` to avoid | same + buildpack-built image | none if replica warm; node scheduling on scale-up | none |
| Local = prod artifact? | **yes** — `docker run` the same image, or bare `node` | no — same framework, not the built container | image yes; platform needs minikube/Skaffold | **yes** — bare `node` / same container |
| `node --inspect` | trivially | via framework process | port-forward / `skaffold debug` | trivially |
| Deploy | `gcloud run deploy` (image or `--source`) → revision | `gcloud functions deploy` (source + Cloud Build) | push image + `kubectl apply` | DIY / `update-container` (VM restarts) |
| Rollback | traffic pointer to old revision | same (gen2) | `kubectl rollout undo` | DIY |
| Est. $/mo @ workload | **≈ $0.86** (scale-to-0) / ≈ $14 (min-inst 1) | ≈ $0.86 | ≈ $12–36 (+ cluster fee $0 w/ free tier) | ≈ $12 (e2-small); $0 (free e2-micro) |
| Secrets | Secret Manager → env var or volume, native flags | same | CSI add-on, file mounts only, Workload Identity | app calls API via VM service account |

## 1. Cloud Run (services)

### Request timeout
- Default **5 min (300 s)**, configurable up to **60 min (3600 s)**. If no response within the
  timeout, the connection is closed with a **504**. A 5-min synchronous request fits with room to
  spare. ([request-timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout))
- For timeouts > 15 min Google recommends client retry/reconnect handling (connection-loss risk
  grows with duration) — not relevant at 3–5 min. Note: on a 504, the instance is *not* killed;
  the abandoned work can keep consuming CPU. (same doc)

### Concurrency / burst behavior
- Per-instance max concurrent requests: default **80 × vCPUs** (gcloud/Terraform; console default
  80), settable 1–**1000**. ([about-concurrency](https://docs.cloud.google.com/run/docs/about-concurrency))
- Autoscaler adds instances when existing ones hit their concurrency limit (and backs off sending
  to CPU-saturated instances). **5 simultaneous requests** land on one instance at default
  concurrency; set `--concurrency=1` to force one instance per request (5 instances spin up).
  Long CPU-heavy requests argue for low concurrency per instance. (same doc)

### Cold starts / min-instances
- Scale-to-zero by default; `--min-instances=N` keeps N warm instances. Under **request-based
  billing** idle min-instances bill at a *lower idle rate*; under **instance-based billing** the
  full rate applies for the whole instance lifetime.
  ([min-instances](https://docs.cloud.google.com/run/docs/configuring/min-instances))
- Docs don't publish a cold-start number; it is container-startup-dominated (image pull + Node
  boot). For a 3–5-min request, a cold start of a few seconds is noise.

### Local dev (the artifact is just a container / Node server)
- The prod artifact is **your own container image (or plain Node HTTP server)** — the only
  contract is "listen on `$PORT`". Google's documented local options
  ([testing/local](https://docs.cloud.google.com/run/docs/testing/local)):
  1. `docker run -p 9090:8080 -e PORT=8080 IMAGE_URL` — **the exact production image**, locally.
  2. Same + mounted ADC credentials for Google-API access.
  3. Cloud Code IDE emulator (VS Code / JetBrains) with CPU/mem/env config.
  4. `gcloud beta code dev` — build-from-source + auto-rebuild-on-change loop.
- Because the app is an ordinary Node server, `node --inspect index.js` (or `--inspect` inside the
  container with the port published) works with zero platform shims. Edit → rerun loop is plain
  `node`/nodemon outside Docker, or docker rebuild for full-fidelity runs.
- Fidelity gaps: locally there is no metadata server / attached service identity — you substitute
  Application Default Credentials or a key file (called out in the local-testing doc). Otherwise
  the container is bit-identical to prod.

### Deploy / rollback
- Deploy = `gcloud run deploy SERVICE --image IMAGE_URL` (or `--source .` for build-from-source).
  Each deploy creates an **immutable revision**; tags resolve to digests pinned to the revision.
  ([deploying](https://docs.cloud.google.com/run/docs/deploying))
- Rollback is a traffic pointer move, no rebuild:
  `gcloud run services update-traffic SERVICE --to-revisions REV=100`; gradual rollouts via
  `--no-traffic` + `--to-revisions LATEST=5`; canary splits supported. In-flight requests finish
  on their revision. ([rollouts-rollbacks](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration))

### Secrets
- Native Secret Manager integration: expose a secret as an **env var** (resolved at instance
  start; pin versions) or a **volume file** (fetched on read → picks up rotation). gcloud:
  `--update-secrets=ENV=SECRET:VERSION` or `--update-secrets=/path/file=SECRET:VERSION`. Runtime
  service account needs `roles/secretmanager.secretAccessor`.
  ([secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets))
- Local dev: same secrets readable via Secret Manager API under ADC (`gcloud auth
  application-default login`), or plain `.env` since the app just reads env vars.

### Pricing — see pricing section below (rates pending).

## 2. Cloud Run functions (Cloud Functions 2nd gen)

### What it is
- A 2nd-gen function **is a Cloud Run service deployed from source code** — the docs say so
  verbatim. Gen1 runs on separate legacy infrastructure.
  ([version-comparison](https://docs.cloud.google.com/functions/docs/concepts/version-comparison))

### Request timeout
- **HTTP-triggered gen2: up to 60 min**; event-driven gen2: up to 9 min; **gen1: 9 min (540 s)
  max for everything**. Confirmed by the gcloud reference: `--timeout` "cannot be more than 540s"
  (gen1) / "3600s" (gen2). ([version-comparison](https://docs.cloud.google.com/functions/docs/concepts/version-comparison),
  [gcloud functions deploy](https://docs.cloud.google.com/sdk/gcloud/reference/functions/deploy))
- So a 3–5-min synchronous request rules out gen1 outright and fits gen2 comfortably.

### Concurrency
- Gen2 supports **up to 1000 concurrent requests per instance** (gen1: exactly 1).
  ([version-comparison](https://docs.cloud.google.com/functions/docs/concepts/version-comparison))
- Because a gen2 function *is* a Run service, concurrency is set with the same
  `gcloud run services update SERVICE --concurrency N` machinery (default 80);
  `gcloud functions deploy --concurrency` left unset takes the server default.
  ([configuring/concurrency](https://docs.cloud.google.com/run/docs/configuring/concurrency))
- Burst of 5: same autoscaler behavior as Cloud Run services.

### Cold starts / min-instances
- Same substrate as Cloud Run ⇒ same scale-to-zero and `--min-instances` story. Source-deployed
  functions still cold-start a container built from your source via buildpacks.

### Local dev — Functions Framework
- Production wraps your exported function in the open-source **Functions Framework** — the *same*
  framework you run locally: `npm i --save-dev @google-cloud/functions-framework`, then
  `npx @google-cloud/functions-framework --target=fnName` (or an npm `start` script) serves it at
  `localhost:8080`; test with curl. ([local-dev-functions](https://docs.cloud.google.com/run/docs/local-dev-functions),
  [functions-framework-nodejs](https://github.com/GoogleCloudPlatform/functions-framework-nodejs))
- Debugging: the framework is a plain Node/Express process, so
  `node --inspect node_modules/.bin/functions-framework --target=fnName` works; the official local-dev
  doc itself does **not** document debugging or watch/reload — you assemble that (nodemon etc.).
- **Fidelity gap**: locally you run source + framework; production runs a container that Cloud
  Build assembled from your source with buildpacks. You never run the *built artifact* locally
  unless you pull the produced image and `docker run` it — i.e., strictly worse artifact-fidelity
  than deploying your own image to Cloud Run. Env/secrets/identity gaps same as Cloud Run local.

### Deploy / rollback
- Deploy = `gcloud functions deploy NAME --gen2 --runtime=nodejs22 --trigger-http --source=.` —
  uploads source, Cloud Build builds the container, then a Run revision rolls out (deploy includes
  a cloud build every time). ([gcloud functions deploy](https://docs.cloud.google.com/sdk/gcloud/reference/functions/deploy))
- Rollback/traffic-splitting: **supported in gen2** (not gen1) because the function is a Run
  service — same `gcloud run services update-traffic` revision mechanics.
  ([version-comparison](https://docs.cloud.google.com/functions/docs/concepts/version-comparison))

### Secrets
- Same Secret Manager env-var / volume integration as Cloud Run (it *is* Cloud Run); flags exist
  on `gcloud functions deploy` (`--set-secrets`). Locally: ADC + Secret Manager API or `.env`.

### Pricing
- The Cloud Functions pricing page states 2nd-gen functions **are billed per Cloud Run pricing**
  (1st gen has a separate legacy page). ([functions pricing](https://cloud.google.com/functions/pricing))
  Numbers: see pricing section below.

## 3. GKE Autopilot

### Request timeout
- Kubernetes itself imposes **no request timeout** — your Node server and whatever fronts it
  (Service/Ingress/Gateway) own the limit. Holding a request 5 min is purely an app/LB-config
  matter. (No GCP-imposed cap analogous to Cloud Run's; if you add an external HTTP(S) LB, its
  backend timeout is configurable.)

### Concurrency / burst
- Your pod is a plain Node server: it takes as many concurrent requests as it accepts. Bursts are
  handled by replica count / HPA; **HPA minReplicas ≥ 1 — no native scale-to-zero for HTTP**
  (needs KEDA/Knative on top). 5 simultaneous requests just hit the running pod(s).

### Cold start / scaling latency
- Autopilot provisions nodes to fit pods; on the container-optimized compute platform "new Pods
  don't need to wait for new nodes to boot up," but first workloads in an idle cluster "take more
  time to schedule." Practically: you keep ≥ 1 replica warm, so no per-request cold start.
  ([autopilot-overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview))

### Local dev
- Prod artifact = your container image; runnable locally with `docker run` (same fidelity as
  Cloud Run) — but prod *behavior* also includes K8s manifests, Service/Ingress, probes,
  ServiceAccount → replicating that locally means **minikube/kind + Skaffold**.
- `skaffold dev` watches source, rebuilds/syncs, redeploys, auto port-forwards and streams logs;
  works against minikube, remote clusters, local Docker, even Cloud Run; client-side only.
  ([skaffold.dev/docs](https://skaffold.dev/docs/))
- Debugger: `node --inspect` works in a local container; through K8s you port-forward 9229 or use
  `skaffold debug`/Cloud Code. Strictly more moving parts than `node index.js`.
- Fidelity gaps: local cluster ≠ Autopilot (no Autopilot node constraints, no Workload Identity —
  secrets/identity must be faked locally).

### Deploy / rollback
- Deploy = push image + `kubectl apply` / `kubectl set image` (or Skaffold/CD). Rollback =
  `kubectl rollout undo deployment/X` — Deployments keep a revision history natively. You own
  manifests, probes, PodDisruptionBudgets, upgrades of the cluster itself (Autopilot manages
  nodes, not your YAML).

### Secrets
- **Secret Manager add-on** (managed Secrets Store CSI driver, `secrets-store-gke.csi.k8s.io`)
  mounts secrets as **files** via a `SecretProviderClass`; auth via **Workload Identity
  Federation** (on by default in Autopilot). Env-var injection is *not* part of the add-on;
  K8s-native Secrets remain an option.
  ([secret-manager add-on](https://docs.cloud.google.com/secret-manager/docs/secret-manager-managed-csi-component))
- Local dev cannot reproduce Workload Identity; you fall back to ADC/key files or plain env vars.

## 4. Plain GCE VM

### Request timeout / concurrency
- None imposed — it's your Node process on a VM; timeouts and concurrency are whatever your
  server (and any LB you add) allows. 5-min synchronous requests: trivially fine.
- Bursts: one always-on process handles them in-process; no autoscaling unless you add a MIG.

### Cold start
- None — the VM is always on (that's also why it's always billed). Reboot/maintenance windows are
  the availability consideration instead.

### Local dev
- Highest fidelity of all four in one sense: prod is "a Node process on Linux" — locally you run
  the same `node --inspect index.js`; nothing platform-shaped intervenes. If you use the
  container-VM path (below), `docker run` of the same image applies, same as Cloud Run.
- No framework, no emulator, no manifests. The gap is environmental (systemd unit, VM metadata
  identity) rather than platform behavior.

### Deploy / rollback
- DIY. Options, all on you:
  - **Container on VM**: `gcloud compute instances create-with-container` /
    `update-container` — Compute Engine boots Container-Optimized OS and `docker run`s your image;
    updating the container **stops and restarts the VM**; one container per VM.
    ([deploying-containers](https://docs.cloud.google.com/compute/docs/containers/deploying-containers))
  - **MIG rolling updates** for template-based deploys with canary (max 2 template versions) and
    surge/unavailable controls — heavyweight for a single tiny service.
    ([MIG rolling updates](https://docs.cloud.google.com/compute/docs/instance-groups/rolling-out-updates-to-managed-instance-groups))
  - Or plain SSH + git pull + restart. Rollback = redeploy previous version yourself; no managed
    revision history.

### Secrets
- VM's attached service account provides ADC via the metadata server; app calls the Secret
  Manager API with `roles/secretmanager.secretAccessor` — same client-library code path locally
  (with `gcloud auth application-default login`) and in prod. No mounting/env integration is
  provided; you fetch at boot/runtime yourself.

## 5. Pricing at this workload

Workload: **30 req/day × 4 min × 1 vCPU / 1 GiB** ⇒ ~900 req/mo, 216,000 vCPU-s + 216,000 GiB-s
of request time per month. Rates: us-central1 list, from the official pricing pages
([Cloud Run](https://cloud.google.com/run/pricing), [GKE](https://cloud.google.com/kubernetes-engine/pricing),
[GCE general-purpose](https://cloud.google.com/products/compute/pricing/general-purpose),
[free tier](https://docs.cloud.google.com/free/docs/free-cloud-features)).

| Runtime | Arithmetic | Est. monthly |
|---|---|---|
| Cloud Run / Functions gen2, request-based | CPU 216,000 × $0.000024 = $5.18; RAM 216,000 × $0.0000025 = $0.54; requests 900 ≈ $0.00 → list **$5.73**; free tier (180k vCPU-s, 360k GiB-s, 2M req) leaves 36k vCPU-s → | **≈ $0.86** (list $5.73) |
| Cloud Run, + `min-instances=1` (request-based idle rate) | 2,628,000 s/mo × ($0.0000025 CPU + $0.0000025 RAM idle) = $13.14 idle + active premium | **≈ $14/mo** |
| Cloud Run, instance-based billing | ≥ 216,000 s × ($0.000018 + $0.000002) = $4.32 list (free tier 240k/450k covers it); real cost higher — you pay full rate for post-request lingering instance time | **$0–few $** |
| GKE Autopilot, 1 always-on 1 vCPU/1 GiB pod | 730 h × ($0.0445/vCPU-h + $0.0049225/GiB-h) = **$36.08** pods + cluster fee $0.10/h = $73/mo (free-tier credit $74.40 covers one cluster's fee) | **≈ $36** (+LB if any) |
| GKE Autopilot, pod downsized to 0.25 vCPU/1 GiB (allowed: min 50m CPU with bursting, ratio 1:1–1:6.5) | 730 × (0.25 × $0.0445 + $0.0049225) = **$11.72** | **≈ $12** (+LB) |
| GCE `e2-small` (2 shared vCPU, 2 GiB) | $0.016752855/h × 730 = **$12.23** + boot disk (30 GB standard PD is in the always-free tier) | **≈ $12** |
| GCE `e2-micro` (1 GiB — tight for Node) | Always-free: 1 e2-micro/mo in us-west1/us-central1/us-east1 | **$0** (free tier) |

Notes: request-based billing bills CPU/RAM only while requests are in flight (min-instance idle
at the idle rate); instance-based bills the whole instance lifecycle at a lower rate with no
per-request fee. Autopilot pod prices are per-resource-hour on requests, plus every cluster pays
the $0.10/h management fee (one cluster's fee absorbed by the $74.40/mo free-tier credit;
credit covers the cluster fee only, not compute). External load balancing for GKE/GCE is billed
separately (Cloud Load Balancing). Source deploys (Functions or `--source`) additionally incur
Cloud Build + Artifact Registry storage charges
([run pricing](https://cloud.google.com/run/pricing), [deploying-source-code](https://docs.cloud.google.com/run/docs/deploying-source-code)).

## 6. Cross-cutting observations (facts that discriminate — no ranking)

- **Functions gen2 *is* Cloud Run.** The docs define a 2nd-gen function as "a Cloud Run service
  deployed from source code" billed at Cloud Run prices. What Functions adds is the source-deploy
  ergonomics + Functions Framework signature; what it removes is direct control of the artifact
  (you never hand it an image). Cloud Run itself also offers source deploys (Dockerfile if
  present, else buildpacks) — so the *capability* gap between the two has essentially collapsed
  to "who writes the HTTP server line."
  ([version-comparison](https://docs.cloud.google.com/functions/docs/concepts/version-comparison),
  [deploying-source-code](https://docs.cloud.google.com/run/docs/deploying-source-code))
- **Timeout ladder**: gen1 functions 540 s max (**cannot** hold 5 min + margin safely) → gen2 HTTP
  / Cloud Run services 3600 s max, default 300 s (must be raised above default for a 5-min p95) →
  GKE/GCE unlimited.
- **Local-dev fidelity is the axis where the four differ most**: GCE/Cloud Run run the literal
  prod artifact locally (`node --inspect` / `docker run`, zero shims); Functions runs the same
  *framework* but never the built container; GKE runs the same container but needs
  minikube+Skaffold to approximate the platform around it. Identity (metadata server / Workload
  Identity) is the one gap **none** of the four can reproduce locally — all fall back to ADC.
- **Cost shape**: Cloud Run request-based is the only model that bills ~nothing for a mostly-idle
  service (≈ $1/mo, free tier absorbing most); every always-on option (Autopilot pod, VM,
  min-instances=1) lands in the $12–36/mo band regardless of runtime.
- **Burst behavior differs in kind**: Cloud Run autoscales per-request (concurrency knob decides
  whether 5 requests share one instance or fan out to 5); GKE/GCE absorb bursts in-process unless
  you build autoscaling.
- **Rollback**: managed revision history + traffic-pointer rollback on Cloud Run/gen2; `kubectl
  rollout undo` on GKE; DIY on GCE (container-VM update even restarts the VM).
