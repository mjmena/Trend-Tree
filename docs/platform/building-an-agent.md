# Build an agent on McClatchy's GCP

**Who this is for:** anyone who can direct an AI coding assistant, but does not
write backend services every day. You do not need to know Cloud Run, Docker, or
OIDC. You need to know which decisions are already made, which commands to run,
and which mistakes your AI will make if you do not stop it.

**What you get:** an agent that runs on a schedule or answers an authenticated
HTTP call, holds real credentials, calls a model, and writes rows you can query.

**What it costs:** about a day if you follow this page. About a week if you do
not, because you will re-derive the traps in section 6. Every trap here was paid
for once already.

---

## 1. This pattern already runs in production

Three agents run on it today, in the shared GCP project `mcc-crm-automations`,
region `us-east4`. Verified 2026-09-08.

| Agent | What it does | How it is triggered | Run time |
|---|---|---|---|
| `trend-tree-ecomm-agent` | Sources products for a trend | Cloud Scheduler, `POST /poll` every 15 min | ~11s per tick |
| `trend-tree-prediction` | Scores and resolves trend predictions | Cloud Scheduler, `POST /sweep` daily 14:00 UTC | 393s |
| `trend-tree-scrape-gateway` | Fetches from a scraping vendor | Called on demand, `POST /pull` | seconds |

All three are Node or Python HTTP servers in a container. All three are private
— no public URL. All three deploy with one command.

The fleet moved to Cloud Run for the development loop, not for the runtime. On
the previous platform, every change needed a commit and a deploy before you
could see it fail. Here, you edit a pure function and re-run it against a saved
fixture in **0.05s**. A full live run takes **72s**. That gap is the whole
point.

---

## 2. Decide first: do you need a service?

Do not build a service by default. Build one when **at least one** of these is
true.

- It must run on a schedule, with nobody watching.
- Another system must be able to call it.
- It needs a credential a person should not hold — a Snowflake key, a vendor
  API key.
- It runs longer than a chat turn, or loops over many records.
- It must write rows somewhere, reliably, and retry when it fails.

Do **not** build a service when any of these is true.

- It is a one-off analysis. Use your AI assistant and `snow sql -c claude`.
- It is one prompt a person runs by hand a few times a month. Use a chat.
- It is pure SQL with no judgment in it. Use a Snowflake task.

If you build one, hold this rule the whole way through:

> **The model supplies judgment. Your code supplies the truth.**

The model never validates its own output. Your code checks every value the model
returned against something real, drops what does not match, and fails loudly if
everything was invented. In the ecomm agent, `buildSourcingRunPlan` drops any
product the model picked that was not in the pool it was shown. If *every* pick
was invented, the run fails. It does not quietly report "no match".

---

## 3. The shape of an agent here

One directory holds one service. Copy `services/ecomm-agent/` and you get the
whole shape.

| File | What it is |
|---|---|
| `server.mjs` | The HTTP server. Three routes, no more. Thin. |
| `run_*.mjs`, `selector.mjs`, … | The judgment. Pure functions. Where the real work lives. |
| `Dockerfile` | How the image is laid out. Read section 6 before you trust it. |
| `deploy.env` | Config and **secret names** — never secret values. |
| `package.json` | This service's dependencies. Its own, not the repo's. |

Shared code lives in `services/lib/` and is imported directly. That works only
because **every image is built from the repository root**, not from the service
directory.

> **Never add a `package.json` at the repository root.** The old platform's
> GitHub sync watches the root and will react to it.

### The three routes

- `GET /health` — returns 200. The deploy script calls this before it sends
  traffic to your new version. **Not `/healthz`.** See section 6.
- `POST /<verb>` — does one unit of work for one record. A person fires this by
  hand to test or to repair.
- `POST /poll` — does a batch. Cloud Scheduler calls this.

`/poll` must not reimplement `/<verb>`. Both drive the same internal path, so a
bug you see in the batch always reproduces on a single manual call. That is how
you debug a scheduled agent.

Cloud Scheduler needs a batch route because Scheduler cannot enumerate anything.
It fires one fixed request on a clock. **The service owns the loop.**

### Where the model call goes

Use `services/lib/gemini_loop.mjs`. It calls the Gemini REST API with plain
`fetch()`. There is no SDK to install.

The model id is pinned in your code. The prompt text is **not** — the service
reads it at run time from the Snowflake table
`MCC_RAW.MARKETING_DEV.DIM_LLM_PROMPT`. That table deploys live, outside git, so
changing it has a three-part rule. See section 5, step 6.

---

## 4. What you can do yourself, and what you cannot

`mcc-crm-automations` is a **shared** project. Other teams' services live in it.

**Self-service. Do these yourself, no ticket:**

- Deploy a Cloud Run service.
- Grant another account permission to call your service (`run.invoker`).
- Create a Cloud Scheduler job.
- Read an existing secret from Secret Manager. The runtime account
  `crm-runtime@` already holds project-level access to every secret, so you do
  not need a per-secret grant.

**Denied. Do not plan around these:**

- Creating a service account (`iam.serviceAccounts.create`).
- Creating a service-account key.
- Cloud Build (`cloudbuild.builds.create`). This is why the deploy script does
  not use `docker build`.
- **Every GCP monitoring *create***: alert policies, notification channels,
  uptime checks, log sinks, log metrics. Reads are allowed. Creates are not.

That last one has a consequence you must design around:

> **GCP will never page you.** Nothing in Google Cloud can send an alert about
> your agent.

So monitoring is three layers you build yourself, using no GCP credential:

1. The smoke test at deploy time catches an agent that is broken at rest.
2. The caller raises when a call fails, and reports it.
3. Freshness of the rows in Snowflake catches an agent that returns 200 and does
   nothing.

Layer 3 is the one people skip. Do not skip it. A silent agent looks identical
to a healthy one.

**Two more consequences of the shared project.** Name your service with a team
prefix — `trend-tree-…` — because names collide across the whole project. And
there is **no per-project cost fence**: a runaway loop spends the shared budget.
Keep `MAX_INSTANCES` low and pick the cheapest model that does the job.

---

## 5. Build it, in order

**Step 1 — copy the template.** Copy `services/ecomm-agent/` to
`services/<your-name>/`. It is the reference implementation, and the tests cover
it.

**Step 2 — edit `deploy.env`.** Five things change: `SERVICE`, `TIMEOUT`,
`ENV_VARS`, `SECRETS`, and the sizing block. Leave `HEALTH_PATH=/health` alone.
A secrets entry names a secret. It never holds a value:

```
SECRETS="GEMINI_API_KEY=generic-gemini-api-key:latest"
```

A test enforces that shape, so a literal value cannot reach the file by
accident.

**Step 3 — write the judgment first, as pure functions.** A pure function takes
values in and returns values out. It touches no network. You can run it against
a saved fixture in a fraction of a second, and you can test it without deploying
anything. Put every decision your agent makes in one of these. This step is what
makes the pattern fast, and it is the step people skip.

**Step 4 — write `server.mjs`.** Three routes. Parse the body, call your pure
functions, return JSON. Do **no** authentication check in your own code. Cloud
Run rejects every unauthenticated caller before your container sees the request.
A second check inside the process is the thing most likely to drift out of step
with the real grant.

Map your HTTP statuses deliberately:

- **200** — the run reached a recorded end state. **This includes a failed
  run.** A failure that was written down is a real outcome, and the next tick
  retries it.
- **400** — the request itself was malformed. Retrying it unchanged cannot help.
- **500** — nothing could be recorded at all. This is the only genuinely
  retryable failure.

If you get this wrong, Cloud Scheduler retries a business failure forever.

**Step 5 — call the model through `services/lib/gemini_loop.mjs`.** Two things
in that file look like they need cleaning up. They do not. See section 6.

**Step 6 — put the prompt in the registry.** Prompt text goes in
`DIM_LLM_PROMPT`, not in your code. That table deploys live and outside git, so
**one commit must carry both of these**:

1. The prompt change itself, as a `sql/update_prompts_*.sql` migration.
2. The matching version bump in the `q_prompt_drift` manifest inside
   `audit-agent-p_xMC9nm3/workflow.yaml` — **both copies**, `sql.value` and
   `sql.query`.

A daily audit compares the live table against that manifest. It reports anything
it cannot account for as a governance failure.

**Step 7 — run the tests.** `scripts/test_services_lib.sh`.

**Step 8 — commit.** The deploy script **refuses to build from a dirty tree**,
and the reason is worth understanding. The image is tagged with the git commit
id. An image built from uncommitted work carries a tag that names code nobody
can check out. The tag would be false, and you could never roll back to it.

**Step 9 — deploy.**

```sh
services/deploy.sh <your-name>                 # full flow
services/deploy.sh <your-name> --no-build      # redeploy this commit's image
services/deploy.sh <your-name> --no-promote    # stop after the smoke test
```

Five stages run in order. Build the image. Deploy it **with no traffic**, under
the tag `candidate`. Smoke-test it at its own private URL. Promote it by moving
the traffic pointer. The script prints the rollback command *before* it
promotes.

Nothing you deploy touches live traffic until the smoke test passes.

**Step 10 — let your caller in.**

```sh
gcloud run services add-iam-policy-binding <service> --region us-east4 \
  --member=serviceAccount:crm-runtime@mcc-crm-automations.iam.gserviceaccount.com \
  --role=roles/run.invoker
```

**Step 11 — schedule it.** Copy `services/prediction/deploy/scheduler.sh`. It is
the reference implementation. It is safe to re-run, and its `--verify` flag
fires the job once and then proves a success in the request log.

Two facts about Cloud Scheduler change how you write the service:

- **Scheduler bodies are static.** There are no template variables. If a run
  needs a date or an id, send a flag and let the service derive the value. The
  prediction sweep sends `daily_chain_id: true` and the service builds
  `pred-sweep-daily-YYYY-MM-DD` itself, so a retry merges into the same run
  instead of creating a second one.
- **`gcloud scheduler jobs run` tells you nothing.** It prints no useful output
  and leaves `status.code: -1` whatever happened. Read the Cloud Run request log
  instead. Take a timestamp before you fire, or you will read the *previous* run
  and believe it was this one.

**Codify the job in the repository.** One Scheduler job in this project exists
only in GCP and in nobody's code. If someone deletes it, nothing restores it.

---

## 6. The traps

Each of these already cost somebody a day. Your AI assistant will walk into most
of them, confidently, because its training data says otherwise. They are grouped
by the symptom you will actually see.

### Deploy and build

**Symptom: `docker: command not found`, or the build fails on a Mac.**
There is no Docker daemon on a dev Mac, and Cloud Build is denied in this
project. The deploy script builds the image with `crane` instead — it stages a
file tree and appends it onto a base image, with no daemon. Do not let your AI
"fix" this by installing Docker or by switching to Cloud Build. Neither path
works here.

**The `Dockerfile` is not what builds the image.** `crane` builds it. The
Dockerfile is the local-reproduction copy. A test,
`services/deploy_layout.test.mjs`, exists only to assert that the two describe
the same image. If you change one, change the other.

**Symptom: a dependency fails at run time but worked locally.**
The build cross-compiles from an arm64 Mac to linux/amd64. That is only sound
while every dependency is pure JavaScript. The layout test blocks any lockfile
entry that carries an install script or a platform constraint. If it fails on a
new dependency, choose a different dependency.

### Authentication

**Symptom: 404 from a service you know is healthy.**
Google's edge intercepts the exact path `/healthz` on `*.run.app` and answers
its own 404 before Cloud Run sees the request. A healthy version fails its own
smoke test. **Use `/health`.** `/livez` and `/readyz` also route through
normally.

⚠️ `CLAUDE.md` still documents the ecomm agent's health route as `/healthz`.
That is stale. **Trust the code.**

**Symptom: 401 when you call the candidate URL.**
The OIDC audience must be the **base** service URL. It is never the
`candidate---…` tagged URL. Measured: base returns 200, tag returns 401.

Learn this distinction. It is your best debugging tool:

- **401** — the token was read and rejected. It is the *wrong token*. Fix the
  audience.
- **403** — there is no invoker binding. Fix the permission (step 10).

**Symptom: a 404 you are tempted to fix with `--iap`.**
Do not. `--iap` sets `invoker-iam-disabled: true`, and with IAP not actually
provisioned, nothing authorizes the request at all. The correct flag is
`--invoker-iam-check`.

Tell the two 404s apart by the response headers. A real Cloud Run rejection
carries `server: Google Frontend`. The edge's own error page carries **no**
`server:` header.

**The smoke test does not call as you.** It impersonates a service account. That
permission sits on the service-account resource, not on the project, so a
project-level permission check will not reveal it. This one gets re-derived
about once a month.

### Working with the model

**Do not let your AI rebuild the message array.** Model turns must go back into
the conversation **verbatim**. Gemini validates a `thoughtSignature` on them, and
a reconstructed array returns 400. It looks like harmless tidying. It is not.

**Do not let your AI run tool calls in parallel.** Dispatch is sequential, never
`Promise.all`. Gemini matches responses to calls by name, with a positional
fallback when one tool is called twice in a turn. Parallel dispatch corrupts that
matching.

**Never bind a model's reply to your records by position alone.** This is the
most expensive mistake on this list. One project shipped it **three times**. In
one case a prediction took a different prediction's evidence, and the pipeline
permanently closed the wrong call as true.

The rule: accept an entry only when the id it echoed **and** its position both
agree. If they disagree, **drop the entry**. Do not try to reconcile it.

**Ask a model for an enum, never a number.** A verdict is
`strong | partial | weak`. It is not a score from 0 to 100. A number invites
somebody to average it, and an average of model opinions means nothing. A
verdict that is not a number cannot be averaged by accident.

**Never blend a retrieval score with a model verdict into one column.** Keep them
separate. They are different kinds of claim.

### Run time

**Symptom: the deploy succeeded, then every run fails on a missing column.**
You deployed code before its database migration. The smoke test cannot catch
this, because a health probe never writes a row. Run the migration first.

**Symptom: Cloud Scheduler retries forever.** You returned a 5xx for a business
failure. Re-read the status mapping in step 4.

**Watch your time budget.** The prediction sweep runs 393s against a 600s
service timeout and a 590s Scheduler deadline. That headroom is thin, and it
shrinks as the data grows. Check your run time against your timeout every time
you add work.

---

## 7. Prove it works, and undo it

> **"It worked" means rows landed.** A 200 from the service is not proof. A
> green deploy is not proof. Query the table.

Verify an ecomm run in `FCT_TREND_SOURCING_LEDGER`, a prediction run in
`FCT_PREDICTION_VERDICT_LEDGER`. Query with `snow sql -c claude`, and run it
**unsandboxed**. A service that writes nothing by design — the scrape gateway is
one — is verified through its own read route instead.

Run these commands rather than trusting any document, including this one.

```sh
# What is deployed, and is it serving?
gcloud run services list --project mcc-crm-automations --region us-east4

# Which commit is live?
gcloud run services describe <service> --project mcc-crm-automations \
  --region us-east4 --format='value(spec.template.spec.containers[0].image)'
git branch -a --contains <sha>          # is that commit on production?

# What is on a schedule?
gcloud scheduler jobs list --project mcc-crm-automations --location us-east4

# Did the last runs succeed?
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="<service>"' \
  --project mcc-crm-automations --freshness=24h --limit=10
```

**Rollback is the same command that promoted.** Aim it at the previous revision:

```sh
gcloud run services update-traffic <service> --region us-east4 \
  --project mcc-crm-automations --to-revisions <prior-revision>=100
```

That symmetry is deliberate. The deploy script prints this exact line, filled in,
before it promotes anything. Keep the output.

---

## 8. Paste this into your AI before you start

Your assistant is competent and will still make the section 6 mistakes, because
the wider internet disagrees with this environment. Give it the constraints up
front.

```text
I am building an LLM agent as a Cloud Run service in McClatchy's shared GCP
project mcc-crm-automations, region us-east4. Follow these constraints. They are
settled decisions and measured findings, not preferences. Ask me before
departing from any of them.

PLATFORM
- Copy services/ecomm-agent/ as the template. One directory is one service.
- Every image builds with the REPO ROOT as build context, because services
  import services/lib/.
- Never create a package.json at the repository root.
- Deploy only with services/deploy.sh <name>. Do not write a new deploy path.
- The build uses `crane`, not `docker build`. There is no Docker daemon and
  Cloud Build is denied. Do not "fix" this.
- The Dockerfile does not build the image; it is the local-reproduction copy.
  Keep it in step with deploy.env — services/deploy_layout.test.mjs asserts
  they match.
- Dependencies must be pure JavaScript. No install scripts and no platform
  constraints in the lockfile: the build cross-compiles arm64 -> linux/amd64.
- Never put a secret value in deploy.env. Name the secret instead:
  NAME=secret-name:latest

ROUTES AND STATUS
- GET /health returns 200. Never /healthz — Google's edge swallows that exact
  path on *.run.app and returns its own 404.
- POST <verb> handles one record. POST /poll handles a batch and owns the loop,
  because Cloud Scheduler cannot enumerate records. /poll must reuse the same
  internal path as the single-record route, not reimplement it.
- Do no auth check in process code. Cloud Run rejects unauthenticated callers
  before the container sees them.
- 200 = a recorded end state, INCLUDING a failed run. 400 = malformed request.
  500 = nothing could be recorded. Never return 5xx for a business failure —
  Cloud Scheduler will retry forever.

MODEL CALLS
- Use services/lib/gemini_loop.mjs. Plain fetch(), no SDK.
- Push model turns back into the conversation VERBATIM. Gemini validates
  thoughtSignature, and a rebuilt array returns 400. Do not tidy this.
- Dispatch tool calls SEQUENTIALLY. Never Promise.all.
- The service reads prompt text at run time from DIM_LLM_PROMPT in Snowflake.
  Do not hardcode prompts. Model ids ARE pinned in code.
- The model never validates its own output. Check every returned value against
  real data, drop what does not match, and fail loudly if everything was
  invented rather than reporting an empty result.
- Bind model replies to records only when the echoed id AND the position agree.
  Drop an entry when they disagree; never reconcile it. Binding by position
  alone has written data to the wrong record three separate times.
- Model verdicts are enums (strong|partial|weak), never numeric scores. Never
  blend a retrieval score with a model verdict in one column.

OPERATIONS
- Put all judgment in pure functions, testable against fixtures without
  deploying. Keep the server thin.
- GCP cannot send alerts here — every observability create is denied. Coverage
  is the deploy smoke test, the caller reporting a failure, and the freshness of
  the rows we write.
- Cloud Scheduler bodies are static, with no template variables. Send a flag and
  derive per-run ids inside the service so a retry merges instead of appending.
- Run the database migration before deploying code that needs it. The smoke test
  cannot catch that ordering.
- "It worked" means rows landed. Verify by querying the target table, not by
  reading an HTTP response.
```

---

## 9. Where the reasoning lives

Do not re-derive these. Read them when you need the *why*.

| Artifact | What it decides |
|---|---|
| `docs/wayfinder/move-the-agent-fleet-off-pipedream-to.md` | The whole platform: why Cloud Run, why the shared project, why manual deploys, why no public endpoint. |
| `services/deploy.sh` header | The deploy runbook, ~58 lines. Read it before you change anything about deploys. |
| `services/prediction/deploy/scheduler.sh` header | Why verifying a scheduled run works the way it does. |
| `docs/prd/trend-to-product-sourcing.md` | The ecomm agent, as a worked example of an agent's contract. |
| `CONTEXT.md` | The project's binding vocabulary. Honour every `_Avoid_` entry. |

### Documents that are currently wrong

Check these against the code before you trust them.

- **`CLAUDE.md` names only one service** under `services/`. Three exist.
- **`CLAUDE.md` documents `/healthz`.** The code serves `/health`. The code is
  right.
- **`CLAUDE.md` calls the enrichment workflow read-only on Snowflake.** It
  writes.
- **The Cloud Run tier has no architecture decision record.** The platform
  decisions live in the map above and in two PRDs. Nothing in `docs/adr/`
  covers it.

### One path not to copy

`services/prediction/` has its **own** 553-line deploy script, not the shared
one. It is a fork with real reasons behind it: a different authentication mode,
conditionally assembled secrets, a three-probe smoke test, and a different
promotion command. **Start from `services/deploy.sh` and the ecomm agent.** Read
the prediction scripts only when you hit a problem the shared path cannot solve.

---

*Facts on this page were verified against live GCP and the repository on
2026-09-08. Re-run the commands in section 7 rather than trusting the tables.*
