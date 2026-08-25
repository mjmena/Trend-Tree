// Ecomm Agent — configuration (CRMA-776, epic CRMA-772).
//
// Cloud Run's configuration contract is the process environment: plain values
// arrive via `--env-vars-file`, secrets via `--set-secrets` (Secret Manager
// mounts them as env vars — crm-runtime@ already holds project-level
// roles/secretmanager.secretAccessor, so no per-secret binding is needed).
// See services/ecomm-agent/deploy.env for the names and their sources.
//
// Nothing here has a secret default and nothing is read lazily mid-request:
// loadConfig() runs once at boot and throws on a missing required variable, so
// a misconfigured revision dies during the Cloud Run health probe instead of
// failing the first real /source call halfway through a run.

// Defaults mirror the Pipedream connected account this service replaces
// (apn_yghdQYJ = CRMBOT_SERVICE_USER, role MARKETING_ENGINEER) and the
// database/schema every sourcing table lives in. They are overridable so a
// future non-prod revision needs no code change.
const SNOWFLAKE_DEFAULTS = {
  role: "MARKETING_ENGINEER",
  database: "MCC_PRESENTATION",
  schema: "TREND_AGENT",
};

const REQUIRED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PRIVATE_KEY", "GEMINI_API_KEY"];

function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

export function loadConfig(env = process.env) {
  // Collect every missing name before throwing — a fresh deploy that forgot
  // three variables should say so once, not three deploys in a row.
  const missing = REQUIRED.filter((name) => !present(env[name]));

  if (missing.length > 0) {
    throw new Error(`ecomm-agent configuration incomplete: missing ${missing.join(", ")}`);
  }

  const privateKey = String(env.SNOWFLAKE_PRIVATE_KEY);
  const snowflake = {
    account: String(env.SNOWFLAKE_ACCOUNT),
    username: String(env.SNOWFLAKE_USER),
    // Secret Manager hands back the PEM verbatim; an env-var round-trip through
    // a shell or a YAML file can turn the newlines into literal "\n", which the
    // node driver rejects with an opaque parse error. Normalize both forms.
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    authenticator: "SNOWFLAKE_JWT",
    role: env.SNOWFLAKE_ROLE || SNOWFLAKE_DEFAULTS.role,
    database: env.SNOWFLAKE_DATABASE || SNOWFLAKE_DEFAULTS.database,
    schema: env.SNOWFLAKE_SCHEMA || SNOWFLAKE_DEFAULTS.schema,
  };
  if (env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) {
    snowflake.privateKeyPass = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  }
  // Optional: the service user has a default warehouse, so this is only set
  // when a revision needs to override it.
  if (env.SNOWFLAKE_WAREHOUSE) snowflake.warehouse = env.SNOWFLAKE_WAREHOUSE;

  return {
    // Cloud Run's contract: the platform picks the port and injects PORT.
    port: Number(env.PORT || 8080),
    snowflake,
    geminiApiKey: String(env.GEMINI_API_KEY),
  };
}
