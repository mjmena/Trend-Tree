# CRMA-1428: How the ATLAS backend can authenticate to a Cloud Run service

Research date: 2026-10-06. Ticket [CRMA-1428](https://mcclatchy.atlassian.net/browse/CRMA-1428),
map [CRMA-1424](https://mcclatchy.atlassian.net/browse/CRMA-1424).

This file holds facts with their sources. It makes no design decision and recommends nothing.

**The `insights-agent` repo is not on this machine.** Nothing below was read from ATLAS code. Every
statement about ATLAS comes from a ticket, a Confluence page or a Slack message, and says so.

Confidence levels:

- **[verified]** — measured on 2026-10-06 with a read-only command, or read in this repo's code.
- **[reported]** — a named source states it. Not measured here.
- **[inferred]** — reasoning from the sources. Not stated by any of them.

## Short answers

1. **Where ATLAS runs.** On Google Cloud Run, in its own GCP projects: dev
   `insights-agent-dev-504817` and prod `insights-agent-504817` (both `us-east4`), plus a DR project
   `insights-agent-dr` (`us-east1`). The backend service is `insights-agent-backend`. There is no
   stage environment. **[reported]** The email of the runtime service account is in no source.
2. **What ATLAS can present.** Today ATLAS authenticates both of its outbound service calls with a
   static API key in a request header (`X-API-Key` to CSA, `X-Api-Key` to Harbor). **[reported]**
   A Cloud Run service can also get a Google ID token for its own service account from the metadata
   server, with no key file. No source shows ATLAS doing that. **[inferred]**
3. **How ATLAS reaches Trend Tree today.** Only through Snowflake. It reads
   `MCC_PRESENTATION.TREND_AGENT` as user `TH_APIUSER` with role `TH_APIROLE`, by key pair.
   **[reported]** No ATLAS → Trend Tree HTTP call exists in this repo. **[verified]**
4. **How the ATLAS → CSA push authenticates.** A shared static key in the `X-API-Key` header. CSA
   holds it as Secret Manager secret `atlas-push-api-key`. DevOps copied the value into ATLAS's
   project as `csa-import-api-key`. A second check, an HMAC header `X-Atlas-Signature`, exists but
   is dormant. **[reported]**
5. **Pipedream as an alternative host.** The existing HTTP triggers (dispatcher, enrichment and the
   rest) are open URLs. No step checks a caller credential, and the internal callers send none.
   **[verified in repo code]** Pipedream offers a trigger-level bearer token, which this project
   does not use. **[reported + inferred]**

## 1. Where ATLAS runs

| Fact | Source | Date | Confidence |
|---|---|---|---|
| "Atlas is the branded name for the insights-agent application". Bitbucket repo `mcclatchyco/insights-agent`. Stack: "FastAPI backend + React frontend + PostgreSQL 17". "Deploy method: Bitbucket pipeline only — no Terraform". | Confluence, DevOps space, [Atlas (insights-agent) — Deployment Runbook](https://mcclatchy.atlassian.net/wiki/spaces/DevOps/pages/2325315603/Atlas+insights-agent+Deployment+Runbook), page id `2325315603` | 2026-09-15 | reported |
| Environments: Dev = project `insights-agent-dev-504817`, `https://atlas-dev.mcclatchy.com`, API `https://api.atlas-dev.mcclatchy.com`, `us-east4`. Prod = project `insights-agent-504817`, `https://atlas.mcclatchy.com`, API `https://api.atlas.mcclatchy.com`, `us-east4`. DR = project `insights-agent-dr`, `us-east1`. | Same runbook, "Environments" table | 2026-09-15 | reported |
| "Two services per environment": `insights-agent-backend` (FastAPI, port 8001) and `insights-agent-frontend` (React via nginx). | Same runbook, "Cloud Run Services" | 2026-09-15 | reported |
| The backend is a Cloud Run service in `insights-agent-dev-504817`: "Redeployed Cloud Run service `insights-agent-backend` (revision `insights-agent-backend-00020-7k4`)". | [KD-36](https://mcclatchy.atlassian.net/browse/KD-36) | 2026-09-03 | reported |
| The backend runs as a Cloud Run service account that reads Secret Manager: "Granted `insights-agent-backend` Cloud Run SA `secretmanager.secretAccessor` on the new secret". The ticket does not give the account's email. | [KD-28](https://mcclatchy.atlassian.net/browse/KD-28) | 2026-08-25 | reported |
| No stage environment exists: "there is no Atlas staging environment — `atlas-stage` / `atlas-staging` do not resolve". The runbook lists Dev, Prod and DR only. | QA comment on [PGS-828](https://mcclatchy.atlassian.net/browse/PGS-828); the runbook | 2026-09-03; 2026-09-15 | reported |
| ATLAS moved hosts on 2026-08-07. The old host `staging-insights-agent.trendhunteragents.ai` was replaced by `atlas.mcclatchy.com` and `atlas-dev.mcclatchy.com`. | Slack `#mmc-thb2c-team`, [permalink](https://mcclatchy.enterprise.slack.com/archives/C0B14D7GWAG/p1786138003331509) | 2026-08-07 | reported |
| `insights-agent` does not run in `mcc-crm-automations`. That project's 12 Cloud Run services are listed in the appendix, and none is `insights-agent`. | `gcloud run services list --project mcc-crm-automations` | 2026-10-06 | verified |
| Owners named by the sources: "Product owner: Marcelo (ATLAS team)". "DevOps contact: sgilbert@mcclatchy.com". "Oliver Felix ... owns their infrastructure and ran the 2026-08-07 hosting migration." | The runbook, "Key Facts"; [CRMA-522](https://mcclatchy.atlassian.net/browse/CRMA-522) resolution comment | 2026-09-15; 2026-08-16 | reported |

**Not found: the runtime identity.** No ticket, page or message gives the email of the service
account that `insights-agent-backend` runs as, in any environment. Dev and prod are different
projects, so they have different service accounts. **[inferred]** One read-only command answers
this for a person who has access to those projects (this session's account lists only
`mcc-crm-automations`):

```sh
gcloud run services describe insights-agent-backend --region us-east4 \
  --project insights-agent-504817 --format 'value(spec.template.spec.serviceAccountName)'
```

This research did not run `gcloud` against the ATLAS projects. The ticket limits `gcloud` to
`mcc-crm-automations`.

**One conflict between sources.** [CRMA-522](https://mcclatchy.atlassian.net/browse/CRMA-522)
(2026-08-16) names the ATLAS codebase as `bitbucket.org/mcclatchyco/trendhunter-web`. The DevOps
runbook (2026-09-15), [PGS-1182](https://mcclatchy.atlassian.net/browse/PGS-1182) and the ATLAS-space
page `2320039937` all name `insights-agent`. The later sources agree with each other.

## 2. What ATLAS can present

**What it presents today: an API key in a header.** Both outbound service calls that the sources
describe use this form.

| Call | Credential | Source | Date | Confidence |
|---|---|---|---|---|
| ATLAS → CSA `POST /api/v1/atlas/push` | `X-API-Key` header. See section 4. | PGS-780, PGS-828, KD-28 | 2026-08-25 | reported |
| ATLAS → Harbor (`https://harbor-api-tu6gxkvema-uc.a.run.app`, a Cloud Run service in `mcc-crm-automations`, `us-central1`) | `X-Api-Key: hbr_…` header. Harbor stores a SHA-256 digest and resolves the caller as `key:atlas`. | Confluence [PRD: Harbor's HTTP API as a contract for calling services (CRMA-508)](https://mcclatchy.atlassian.net/wiki/spaces/CRMA/pages/2279899137), page id `2279899137`, §3; [CRMA-1020](https://mcclatchy.atlassian.net/browse/CRMA-1020) | 2026-09-08 | reported |
| ATLAS holds the Harbor key as a Secret Manager secret: `harbor-api-key` is in the runbook's list of app secrets. | The runbook, "Secrets (Secret Manager)" | 2026-09-15 | reported |
| ATLAS uses the Harbor key from its dev and prod environments: "auth is working (no key gives a clean 401)"; "Is broken in the Prod too". | Slack DM, [2026-09-17](https://mcclatchy.enterprise.slack.com/archives/D0AMKGYQLLV/p1789655247423839) and [2026-09-18](https://mcclatchy.enterprise.slack.com/archives/D0AMKGYQLLV/p1789742011096349) | 2026-09-17/18 | reported |

**How ATLAS stores a credential.** "All app secrets are stored in Secret Manager on the respective
GCP project. The pipeline injects them at deploy time via `--set-secrets`." The list is:
`database-url`, `anthropic-api-key`, `google-client-id`, `google-client-secret`, `jwt-secret-key`,
`maia-api-key`, `snowflake-*`, `auth-enabled`, `frontend-url`, `backend-url`, `allowed-origins`,
`harbor-api-key`. (The runbook, 2026-09-15.) **[reported]** KD-28 adds `csa-import-api-key` in the
dev project. **[reported]**

**A Google ID token: possible on the platform, not shown in use.**

- A Cloud Run service gets a Google-signed ID token for its attached service account from the
  metadata server: `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=[AUDIENCE]`.
  The audience is "the URL of the service you are invoking or a configured custom audience". The
  caller sends it as `Authorization: Bearer ID_TOKEN`. The receiving side must "Grant that service
  account the Cloud Run Invoker (`roles/run.invoker`) role."
  Source: Google, [Authenticating service-to-service](https://docs.cloud.google.com/run/docs/authenticating/service-to-service),
  read 2026-10-06. **[reported]**
- ATLAS runs on Cloud Run (section 1), so its backend can get such a token without a key file and
  without workload identity federation. **[inferred]** That page does not discuss a caller in a
  different project from the receiver.
- No source shows ATLAS minting a Google ID token for any call. When Harbor was still behind a
  Google service-account JWT, the question "do you have a google service account that you are using
  for Atlas?" was answered with "google service account for login or the deploy?"
  ([Slack DM, 2026-09-02](https://mcclatchy.enterprise.slack.com/archives/D0AMKGYQLLV/p1788354255593589)).
  No message in that DM names a runtime service account. Two days later the ATLAS owner wrote
  "lets go with the API key route"
  ([Slack DM, 2026-09-04](https://mcclatchy.enterprise.slack.com/archives/D0AMKGYQLLV/p1788543470994839)).
  Harbor's key door went live on 2026-09-08 (CRMA-1020). **[reported]**
- **Workload identity federation** is for a caller outside Google Cloud. ATLAS is on Google Cloud.
  [CRMA-533](https://mcclatchy.atlassian.net/browse/CRMA-533) closed as moot on 2026-08-16 for
  that reason. **[reported]**
- **A stored service-account key** exists for deploys only. The Bitbucket pipeline holds
  `GCP_SA_KEY_JSON`, `GCP_SA_KEY_JSON_TEST` and `GCP_SA_KEY_JSON_DR` ("Base64 SA key for prod
  project", and so on). (The runbook, "Pipeline Variables".) **[reported]** No source says the
  running backend holds a key file.

**Other identities ATLAS holds, for completeness.** Users sign in with Google OAuth, limited to
`mcclatchy.com` and `mcclatchyservices.com`, and the browser carries a cookie
([PGS-257](https://mcclatchy.atlassian.net/browse/PGS-257), 2026-05-06; PGS-828 QA comment,
2026-09-03). That is a user session, not a service credential. **[reported]**

## 3. How ATLAS reaches Trend Tree today

**The path is a Snowflake read. No HTTP call exists.**

| Fact | Source | Date | Confidence |
|---|---|---|---|
| ATLAS serves `GET /api/v1/trends?search=` "reading DT_TREND_DASHBOARD". | [PGS-1182](https://mcclatchy.atlassian.net/browse/PGS-1182) | 2026-09-22 | reported |
| The ATLAS backend holds Snowflake settings as Cloud Run env vars: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE`, `SNOWFLAKE_PRIVATE_KEY`. "Correlation services query Snowflake directly". | [PGS-263](https://mcclatchy.atlassian.net/browse/PGS-263) | 2026-05-06 | reported |
| Snowflake identity: service user `TH_APIUSER`, role `TH_APIROLE`. The role carries `MCC_PRESENTATION_TREND_AGENT_SFULL`, which is more than read-only. Last login seen 2026-08-20 05:12 EDT. | [CRMA-749](https://mcclatchy.atlassian.net/browse/CRMA-749) findings comment (measured in Snowflake that day) | 2026-08-20 | reported; not measured again today |
| Authentication to Snowflake is a key pair: "Just an RSA key, not a service account. We connect with keypair JWT auth". | [Slack DM](https://mcclatchy.enterprise.slack.com/archives/D0AMKGYQLLV/p1788354461855919) | 2026-09-02 | reported |
| This repo documents the Insights Agent backend as a reader of Snowflake tables: "Engineers consuming the Trend Tree Snowflake tables — the Insights Agent backend and the Trend Hunter B2C feed." | `docs/dashboard/data-contract.md:4` | file read 2026-10-06 | verified (that the doc says so) |
| "Snowflake is the sole shared substrate — the two systems run in different GCP projects and cannot share Secret Manager." | `docs/prd/trend-to-product-sourcing.md:107-109` | file read 2026-10-06 | verified (that the doc says so) |
| No workflow, service or script in this repo names ATLAS or `insights-agent` as an inbound caller. A grep of all `*.js`, `*.mjs`, `*.yaml`, `*.py`, `*.sh` and `*.env` files outside `docs/` finds only the daily digest's links to `atlas.mcclatchy.com` and one comment in `services/prediction/deploy/scheduler.sh:86`. | Repo grep for `insights-agent`, `Insights Agent`, `atlas` | 2026-10-06 | verified |
| The only callers of `trend-tree-ecomm-agent` are a Cloud Scheduler job (`trend-tree-ecomm-poll`, every 15 minutes, OIDC as `crm-runtime@`) and a person's `curl`. | `services/deploy.sh:25-27`; `gcloud scheduler jobs list --location us-east4` | 2026-10-06 | verified |
| Strategist decisions do not travel to Trend Tree by HTTP either. They "persist to the Insights Agent's own Postgres `prediction_decisions` table — *not* back to this repo's ledger". | `docs/prediction-flow.md:182` | file read 2026-10-06 | verified (that the doc says so) |

Not known: whether ATLAS dev and ATLAS prod use the same Snowflake user. CRMA-749 measured one
user and did not split it by environment.

## 4. How the ATLAS → CSA push authenticates

| Question | Answer | Source | Date | Confidence |
|---|---|---|---|---|
| Mechanism | "`X-API-Key` machine auth." One static key, compared by CSA. A feature flag `atlas_integration` gates the route after the key check. | [PGS-780](https://mcclatchy.atlassian.net/browse/PGS-780) description; ATLAS-space page [Metadata Field Reference: ATLAS → CSA → CMS → Snowflake (Technical Spec)](https://mcclatchy.atlassian.net/wiki/spaces/ATLAS/pages/2320039937), page id `2320039937`, §1 | 2026-07-30; 2026-09-16 | reported |
| Responses | `401` for a wrong or missing key. `503` when no key is configured, so the route fails closed. `403` when the flag is off. `422` comes back before the key check. | PGS-780 QA comments; PGS-828 QA comment | 2026-08-19; 2026-09-08 | reported |
| Second factor | "Dormant HMAC hook (`X-Atlas-Signature`) that activates when a secret is set." Not active. | PGS-780; [PGS-828](https://mcclatchy.atlassian.net/browse/PGS-828) | 2026-07-30 | reported |
| Where CSA stores it | Secret Manager secret `atlas-push-api-key` in project `content-scaling-agent-dev`, mounted as env `ATLAS_PUSH_API_KEY` on Cloud Run service `content-scaling-backend`. Per environment, the value enters through a secured Bitbucket variable (`TF_VAR_atlas_push_api_key_stage` for stage) and Terraform. | [KD-28](https://mcclatchy.atlassian.net/browse/KD-28); PGS-780 QA comment | 2026-08-25; 2026-08-19 | reported |
| Where ATLAS stores it | Secret Manager secret `csa-import-api-key` in `insights-agent-dev-504817`, mounted as env `CSA_IMPORT_API_KEY`. Two more env vars: `CSA_IMPORT_BASE_URL`, `CSA_HANDOFF_MOCK`. "All three Atlas vars must be present or the client silently falls back to mock mode". | KD-28 | 2026-08-25 | reported |
| Who issued it | The CSA side owns the key. DevOps created the ATLAS copy: "value copied from `atlas-push-api-key` in content-scaling-agent-dev". The ticket says "Requested by Marcelo Freitas (2026-08-24); launched 2026-08-25". No source says who generated the original value. | KD-28 | 2026-08-25 | reported |
| How the key was passed to testers | "The API key was handled out of band". An earlier comment asks: "please don't paste it into a Jira comment." | PGS-780 QA comments | 2026-09-16; 2026-08-19 | reported |
| Call shape | The browser calls ATLAS `POST /api/v1/handoff/insights-agent` with a cookie. The ATLAS backend then calls CSA "backend-to-backend". | PGS-828 QA comments | 2026-08-31; 2026-09-03 | reported |
| Where it is live | From ATLAS, end to end: ATLAS dev to CSA dev only. ATLAS has no stage environment. CSA stage accepted a direct push with a real key on 2026-09-16 ("the csa-stage API key is now set"). CSA prod returned `404` for the route on 2026-09-11, and no later reading was found. PGS-780 is Done (2026-09-16). PGS-828 is in Product Review (2026-10-01). Epic [PGS-836](https://mcclatchy.atlassian.net/browse/PGS-836) has no comments. | PGS-780 QA comment; PGS-828 QA comment; ticket statuses | 2026-09-16; 2026-09-11; 2026-10-06 | reported |

**The same pattern elsewhere in the Product Growth Squad's services.** A static service key in an
`X-Api-Key` header is the common form. **[reported]**

- CSA `POST /api/v1/maia/push` accepts an external push "with API key auth". PGS-780 was written
  as a clone of it. ([PGS-255](https://mcclatchy.atlassian.net/browse/PGS-255), 2026-05-06.)
- Trend Hunter B2C content API, internal routes: "Authenticates with the `cms` service key +
  `content:write` scope" ([PGS-503](https://mcclatchy.atlassian.net/browse/PGS-503)). The key is an
  `X-Api-Key`; its hash sits in `INTERNAL_API_KEY_HASHES` and the raw key reaches WordPress "via
  Secret Manager" ([PGS-500](https://mcclatchy.atlassian.net/browse/PGS-500), 2026-07-02).
- [PGS-908](https://mcclatchy.atlassian.net/browse/PGS-908) comment, 2026-08-27: "The new endpoint
  is called service to service"; driving it "needs a CMS service key for that environment"; "the
  anchors endpoint answers 401 with no key."
- PGS-828 notes that "Reusing the existing Trend Hunter B2C backend-to-backend auth approach was
  raised as an option for securing this call."
- CSA has no other inbound service credential: "All CSA endpoints authenticate with an end-user
  Google-OAuth JWT ... there is no inbound service-to-service credential for another team's backend
  to call." ([PGS-886](https://mcclatchy.atlassian.net/browse/PGS-886), 2026-08-17.)

No ticket read for this research shows ATLAS, CSA or the Trend Hunter B2C API using a Google ID
token between services.

## 5. Pipedream as an alternative host

**How a caller authenticates to a Pipedream HTTP trigger in this repo today: it does not.**

| Fact | Source | Date | Confidence |
|---|---|---|---|
| No workflow step checks an inbound credential. A grep of all workflow code for `authorization`, `x-api-key`, `secret`, `bearer`, `401`, `403`, `hmac` finds only outbound calls to vendors. | Repo grep over every `entry.js`, `*.mjs` and `workflow.yaml` | 2026-10-06 | verified |
| The first step of the dispatcher reads only the body and requires only `trend_id`. The first step of enrichment does the same. | `dispatcher-p_8rCBgnl/normalize_event/entry.js:7-26`; `enrichment-p_xMC995w/normalize_event/entry.js:10-20` | 2026-10-06 | verified |
| Internal callers send no credential, only `Content-Type`. The dispatcher calls sources, enrichment and write this way. Promotion calls the dispatcher this way. The watchdog calls distillation this way. | `dispatcher-p_8rCBgnl/orchestrate/entry.js:48-50`; `promotion-p_xMC99jg/fire_enrichment_chain/entry.mjs:92-94`; `distillation-watchdog-p_dDCWWPg/decide_and_fire/entry.js:65-67` | 2026-10-06 | verified |
| The documented manual fire has no credential: `curl -sS -X POST https://eoxadsat1xxgqa4.m.pipedream.net -H 'Content-Type: application/json' -d '{"trend_id":"<uuid>"}'`, and the same for the dispatcher URL. | `CLAUDE.md:158-167` | 2026-10-06 | verified |
| "Pipedream trigger URLs, which are currently unauthenticated." | [CRMA-528](https://mcclatchy.atlassian.net/browse/CRMA-528) description | 2026-08-09 | reported |
| A trigger appears in `workflow.yaml` as an id only (`hi_KNH6klV` for the dispatcher, `hi_4EHDY9m` for enrichment). Trigger settings live in Pipedream, not in git. | `dispatcher-p_8rCBgnl/workflow.yaml:7-8`; `enrichment-p_xMC995w/workflow.yaml:7-8` | 2026-10-06 | verified |
| Pipedream's default: "By default, HTTP triggers are public and require no authorization to invoke. Anyone with the endpoint URL can trigger your workflow." Options: a custom token or an OAuth token, each sent "as a `Bearer` token in the `Authorization` header". | Pipedream docs, [Triggers](https://pipedream.com/docs/workflows/building-workflows/triggers) | read 2026-10-06 | reported |

So the dispatcher and enrichment triggers are open URLs. The repo evidence is direct: their callers
send no token and the chain runs. That no trigger-level token is set in the Pipedream UI is
**[inferred]** from that evidence. This research did not call the Pipedream API to read the
trigger settings, because the ticket forbids it.

Other facts about Pipedream as a host, from this repo:

- 21 workflows declare a built-in HTTP trigger (`hi_*`). (`grep -A3 '^triggers:'` over every
  `workflow.yaml`, 2026-10-06.) **[verified]**
- A synchronous HTTP response has a cap of about 5.5 minutes (`CLAUDE.md:39`). **[verified in doc]**
- A JSON response needs the trigger's `custom_response` toggle, which is set in the Pipedream UI
  (`CLAUDE.md:170`). **[verified in doc]**
- "A commit to `production` **is** the deploy" (`CLAUDE.md:174`). **[verified in doc]**
- Secrets in the Pipedream project environment are readable by every workflow in the project:
  "The key lives in Pipedream project env, so any Trend Tree workflow can read it"
  ([CRMA-441](https://mcclatchy.atlassian.net/browse/CRMA-441) resolution, 2026-08-09). **[reported]**
- The agent fleet is moving off Pipedream. `CLAUDE.md:16` names "the Cloud Run tier (CRMA-429 fleet
  migration)". A CRMA-528 comment (2026-08-09) says "CRMA-429 now targets **no Pipedream at all**".
  **[reported]**
- `CLAUDE.md` imports `~/.claude/snippets/pipedream.md`. That file is not on this machine, so it
  was not read.

## What a decision-maker should know

Facts only. Each line gives its source.

**About the Trend Tree side (`mcc-crm-automations`)**

- **`services/deploy.sh` always deploys with `--no-allow-unauthenticated`.** The flag is fixed in
  `deploy_step` (`services/deploy.sh:278`). No `deploy.env` setting changes it. **[verified]**
- **A caller then needs two things:** a `roles/run.invoker` binding on the service, and a Google ID
  token whose `aud` is the base service URL. "Cloud Run validates `aud` against the service, not
  against the hostname dialled" (`services/deploy.sh:347-351`). **[verified in code comment]**
- **The invoker binding is self-service for members of `crm@mcclatchy.com`.** The group holds
  `Custom_Role_webServices`, which contains `run.services.setIamPolicy` and
  `iap.webServices.setIamPolicy` (`gcloud iam roles describe`, 2026-10-06;
  `services/deploy.sh:29-38`). **[verified]**
- **No cross-project `roles/run.invoker` grant exists in the project today.** All 12 services and
  the project policy were read on 2026-10-06. Every invoker member is `allUsers`, a service account
  of this project, the project's IAP service agent, or a user. **[verified]**
- **A service account from another project already holds roles on this project,** but not
  `run.invoker`: `cloudsql-gp@bootstrap-seed-nuj3.iam.gserviceaccount.com` holds `roles/viewer`,
  `roles/iam.serviceAccountTokenCreator` and two tag roles (`gcloud projects get-iam-policy`,
  2026-10-06). **[verified]**
- **No org policy limits who can be bound.** The effective policy for
  `constraints/iam.allowedPolicyMemberDomains` is `allValues: ALLOW`
  (`gcloud resource-manager org-policies describe ... --effective`, 2026-10-06). That permits both a
  service account from another project and `allUsers`. **[verified]**
- **Who administers IAM on the project.** `roles/owner`: `vpoojari@mcclatchyservices.com`, the only
  owner. `roles/iam.serviceAccountAdmin`: `agautam@mcclatchyservices.com`. `roles/iap.admin`:
  `group:infosys-gcp-admins@mcclatchy.com`. The `crm@` group holds no role that can change the
  project-level policy. (`gcloud projects get-iam-policy`, 2026-10-06.) **[verified; the last
  sentence is inferred from the roles' contents]**
- **`crm-runtime@` holds `roles/run.invoker` at project level,** so it can invoke every Cloud Run
  service in the project. `trend-tree-ecomm-agent` also has a service-level binding for
  `crm-automations@`. (Same commands, 2026-10-06.) **[verified]**
- **`trend-tree-ecomm-agent` and `trend-tree-scrape-gateway` do not read the caller's token.**
  "This code therefore does no token parsing of its own" (`services/ecomm-agent/server.mjs:29-36`;
  `services/scrape-gateway/server.mjs:38-43`). Any principal with the binding passes, and the
  service does not learn which one called. A verifier for Google ID tokens exists in Python at
  `services/lib/tt_services_lib/auth.py`. **[verified]**
- **A standing ingress rule exists on the CRMA-429 map.** "A service that a Pipedream workflow calls
  is public (`allUsers` invoker) and requires an API key in a request header. A service that Cloud
  Scheduler or another Cloud Run service calls stays `--no-allow-unauthenticated` with OIDC."
  ([CRMA-528](https://mcclatchy.atlassian.net/browse/CRMA-528) decision comment, 2026-09-28.) The
  rule does not mention a caller in another GCP project. **[reported]**
- **No Trend Tree service implements a header key today.** A grep of `services/` for `x-api-key`,
  `ingress-key` and `allUsers` returns nothing (2026-10-06). The key layout that CRMA-528 names,
  one secret `trend-tree-<name>-ingress-key` per service, is a decision and not yet code.
  **[verified]**
- **A public service with a header key already runs in the project, and ATLAS is its caller.**
  `harbor-api` (`us-central1`) binds `allUsers` to `roles/run.invoker` and mounts secret
  `harbor-api-keys` as `AB_API_KEYS` (`gcloud run services get-iam-policy` and `describe`,
  2026-10-06). **[verified]** It belongs to the Harbor repo, not to Trend Tree. ATLAS calls it from
  dev and prod (section 2). **[reported]**
- **All `trend-tree-*` services have ingress `all`.** No network allowlist is involved; IAM is the
  only gate. (`gcloud run services list`, 2026-10-06.) **[verified]**
- **Trend Tree has one environment.** The project holds `trend-tree-ecomm-agent`,
  `trend-tree-prediction` and `trend-tree-scrape-gateway`, with no dev or stage copy (same command).
  ATLAS has dev and prod. **[verified / reported]**

**About the ATLAS side**

- **Trend Tree does not know the ATLAS service account.** An invoker binding needs its email, for
  each ATLAS environment that calls. The sources name who can supply it: the DevOps contact in the
  runbook, and the infrastructure owner in CRMA-522 (section 1). **[reported]**
- **A new ATLAS secret goes through DevOps.** KD-28 shows the steps for the CSA key: create the
  secret in the ATLAS project, grant the backend's service account `secretAccessor` on it, redeploy
  with `--set-secrets`. It was requested on 2026-08-24 and launched on 2026-08-25. **[reported]**
- **Key handling so far has been informal.** The Harbor key for ATLAS was sent in a Slack DM on
  2026-09-08. CRMA-1020 lists as still owed: "Rotate `key:atlas` — the secret was pasted into a
  session transcript." This file does not repeat any key value. **[reported]**
- **The ATLAS owner has already chosen between the two forms once.** For Harbor, offered a Google
  service-account JWT or an API key, the reply was "lets go with the API key route" (Slack DM,
  2026-09-04). CRMA-1020 records the reason on the Harbor side: "the google auth is too cumbersome
  for integrations into a lot of our tools." **[reported]**

## What stays unverified

Because the `insights-agent` repo and the ATLAS GCP projects are not readable from here:

1. The email of the service account that `insights-agent-backend` runs as, in dev and in prod.
2. Whether the ATLAS code has any Google auth library call that mints an ID token. No source shows
   one.
3. The exact header ATLAS sends to Harbor and to CSA. The receiving sides document `X-Api-Key` and
   `X-API-Key`; the sending code was not read.
4. Whether `csa-import-api-key` exists in the ATLAS prod project, and whether the CSA push route is
   deployed in CSA prod today. The last prod reading (2026-09-11) was `404`.
5. Whether ATLAS dev and prod share the Snowflake user `TH_APIUSER`. The user and role were
   measured on 2026-08-20 (CRMA-749) and not measured again today.
6. Whether the ATLAS backend has a fixed egress IP or a VPC connector. No source mentions either.

For other reasons:

7. Whether any Pipedream trigger in this project has a trigger-level token set. The repo evidence
   says none of the chained triggers does. The Pipedream API was not called.
8. Whether a cross-project `run.invoker` binding works end to end against a `trend-tree-*` service.
   The org policy allows it and Google's IAM model supports it, but nobody has done it here.
9. Which repo name is right for ATLAS (`insights-agent` or `trendhunter-web`). See section 1.

## Appendix: commands run on 2026-10-06

All read-only, all against project `mcc-crm-automations`, as `mmena@mcclatchy.com`.

```
gcloud run services list --project mcc-crm-automations
gcloud run services get-iam-policy <service> --region <region> --project mcc-crm-automations   # all 12 services
gcloud run services describe harbor-api --region us-central1 --project mcc-crm-automations
gcloud run services describe trend-tree-ecomm-agent --region us-east4 --project mcc-crm-automations
gcloud projects get-iam-policy mcc-crm-automations
gcloud iam roles describe Custom_Role_webServices --project mcc-crm-automations
gcloud scheduler jobs list --location us-east4 --project mcc-crm-automations
gcloud resource-manager org-policies describe iam.allowedPolicyMemberDomains --project mcc-crm-automations --effective
```

Invoker members per Cloud Run service (service-level policy):

| Service | Region | Runs as | `roles/run.invoker` members |
|---|---|---|---|
| `trend-tree-ecomm-agent` | us-east4 | `crm-runtime@` | `crm-automations@` |
| `trend-tree-prediction` | us-east4 | `crm-runtime@` | `crm-automations@`, `crm-runtime@`, `user:mmena@mcclatchy.com` |
| `trend-tree-scrape-gateway` | us-east4 | `crm-runtime@` | none at service level |
| `harbor-api` | us-central1 | default compute SA | `allUsers` |
| `dispatch-api-dev` | us-east4 | `crm-runtime@` | IAP service agent |
| `braze-dev` | us-east4 | `crm-automations@` | none |
| `helm` | us-east4 | `crm-automations@` | default compute SA |
| `helm` | us-central1 | default compute SA | IAP service agent |
| `helm-publish` | us-east4 | `crm-automations@` | default compute SA |
| `audience-dashboard` | us-central1 | default compute SA | IAP service agent |
| `audience-dashboard-staging` | us-east4 | `crm-runtime@` | none |
| `newsletter-dashboard` | us-central1 | default compute SA | IAP service agent |

Project-level `roles/run.invoker`: `crm-runtime@mcc-crm-automations.iam.gserviceaccount.com`,
`user:vpoojari@mcclatchyservices.com`.

Jira tickets read in full, with comments: CRMA-1428, CRMA-441, CRMA-522, CRMA-528, CRMA-533,
CRMA-749, CRMA-1020, PGS-780, PGS-828 (all 14 comments), PGS-836, PGS-908, PGS-1182, PGS-1184.
Descriptions only: KD-28, KD-36, PGS-255, PGS-256, PGS-257, PGS-261, PGS-263, PGS-435, PGS-500,
PGS-503, PGS-886. Jira searches: `text ~ "insights-agent"` (39 issues, in CRMA, PGS and KD only),
`text ~ "atlas-dev"`, project `DEVOPS` for "atlas" or "insights agent" (one unrelated CSA ticket),
project `KD` for "atlas". Confluence pages read: `2325315603`, `2320039937`, and §3-4 and §13-14 of
`2279899137`. No page in the ATLAS space names a Cloud Run project or a service account.
