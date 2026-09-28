// Catalog sync — configuration (CRMA-777).
//
// Plain values arrive via `--env-vars-file`, the Snowflake key via
// `--set-secrets`; see deploy.env. The storefront feed needs no credential
// (CRMA-747), so there is no Shopify secret. loadConfig() throws on a missing
// variable before the job touches the feed or Snowflake.

const REQUIRED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PRIVATE_KEY", "SHOPIFY_STORE_URL"];

function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !present(env[name]));
  if (missing.length > 0) {
    throw new Error(`catalog-sync configuration incomplete: missing ${missing.join(", ")}`);
  }

  const privateKey = String(env.SNOWFLAKE_PRIVATE_KEY);
  const snowflake = {
    account: String(env.SNOWFLAKE_ACCOUNT),
    username: String(env.SNOWFLAKE_USER),
    // Same normalization as services/ecomm-agent/config.mjs: an env-var
    // round-trip can turn the PEM's newlines into literal "\n".
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    authenticator: "SNOWFLAKE_JWT",
    role: env.SNOWFLAKE_ROLE || "MARKETING_ENGINEER",
    database: env.SNOWFLAKE_DATABASE || "MCC_PRESENTATION",
    schema: env.SNOWFLAKE_SCHEMA || "TREND_AGENT",
  };
  if (env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) snowflake.privateKeyPass = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  if (env.SNOWFLAKE_WAREHOUSE) snowflake.warehouse = env.SNOWFLAKE_WAREHOUSE;

  return { snowflake, storeUrl: String(env.SHOPIFY_STORE_URL) };
}
