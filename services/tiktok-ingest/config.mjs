// TikTok ingester — configuration (CRMA-1337).
//
// Plain values arrive via `--env-vars-file`, the three secrets via
// `--set-secrets`; see deploy.env. loadConfig() throws on a missing variable
// before the job spends a SerpApi call or touches Snowflake.

const REQUIRED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PRIVATE_KEY", "SERPAPI_API_KEY", "GEMINI_API_KEY"];

function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !present(env[name]));
  if (missing.length > 0) {
    throw new Error(`tiktok-ingest configuration incomplete: missing ${missing.join(", ")}`);
  }

  const privateKey = String(env.SNOWFLAKE_PRIVATE_KEY);
  const snowflake = {
    account: String(env.SNOWFLAKE_ACCOUNT),
    username: String(env.SNOWFLAKE_USER),
    // Same normalization as services/catalog-sync/config.mjs: an env-var
    // round-trip can turn the PEM's newlines into literal "\n".
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    authenticator: "SNOWFLAKE_JWT",
    role: env.SNOWFLAKE_ROLE || "MARKETING_ENGINEER",
    database: env.SNOWFLAKE_DATABASE || "MCC_RAW",
    schema: env.SNOWFLAKE_SCHEMA || "MARKETING_DEV",
  };
  if (env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) snowflake.privateKeyPass = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  if (env.SNOWFLAKE_WAREHOUSE) snowflake.warehouse = env.SNOWFLAKE_WAREHOUSE;

  return { snowflake, serpApiKey: String(env.SERPAPI_API_KEY).trim(), geminiApiKey: String(env.GEMINI_API_KEY).trim() };
}
