// Plain values arrive via `--env-vars-file`, the two secrets via
// `--set-secrets`; see deploy.env. loadConfig() throws before the tick starts.

const REQUIRED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PRIVATE_KEY", "GEMINI_API_KEY"];

const present = (v) => v !== undefined && v !== null && String(v).trim() !== "";

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !present(env[name]));
  if (missing.length > 0) {
    throw new Error(`lifecycle configuration incomplete: missing ${missing.join(", ")}`);
  }
  const cap = Number(env.LIFECYCLE_BATCH_CAP ?? 200);
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`LIFECYCLE_BATCH_CAP must be a whole number, got ${env.LIFECYCLE_BATCH_CAP}`);
  }

  const privateKey = String(env.SNOWFLAKE_PRIVATE_KEY);
  const snowflake = {
    account: String(env.SNOWFLAKE_ACCOUNT),
    username: String(env.SNOWFLAKE_USER),
    // An env-var round-trip can turn the PEM's newlines into literal "\n".
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    authenticator: "SNOWFLAKE_JWT",
    role: env.SNOWFLAKE_ROLE || "MARKETING_ENGINEER",
    database: env.SNOWFLAKE_DATABASE || "MCC_RAW",
    schema: env.SNOWFLAKE_SCHEMA || "MARKETING_DEV",
  };
  if (env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) snowflake.privateKeyPass = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  if (env.SNOWFLAKE_WAREHOUSE) snowflake.warehouse = env.SNOWFLAKE_WAREHOUSE;

  return { snowflake, geminiApiKey: String(env.GEMINI_API_KEY).trim(), cap };
}
