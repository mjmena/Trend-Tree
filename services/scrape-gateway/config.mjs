// Configuration for trend-tree-scrape-gateway (CRMA-986).
//
// Everything here comes from the environment that services/deploy.sh builds
// out of deploy.env: plain values via --env-vars-file, the API key via Secret
// Manager. Nothing is read from disk and nothing has a baked-in default that
// could silently mask a missing deploy variable.

export class ConfigError extends Error {}

// Fail at startup, not at first request. A Cloud Run revision that boots with
// a missing dataset id would pass its health check and then fail every real
// pull — the dark-deploy smoke test would promote it, and the breakage would
// surface later as an ingester that quietly stopped producing signals.
function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${name} is not set — check deploy.env and the Secret Manager binding`);
  }
  return value.trim();
}

export function loadConfig(env = process.env) {
  const enabled = new Set(
    required(env, "SOURCES_ENABLED")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (enabled.size === 0) {
    throw new ConfigError("SOURCES_ENABLED is set but lists no sources");
  }

  return {
    port: Number(env.PORT ?? 8080),
    brightDataApiKey: required(env, "BRIGHTDATA_API_KEY"),

    // Dataset ids are config, not code (CRMA-985): Bright Data retires and
    // replaces datasets, and baking an id into a normalizer would turn that
    // into a rebuild and a redeploy.
    datasets: {
      tiktok: required(env, "BD_DATASET_TIKTOK_POSTS"),
      reddit: required(env, "BD_DATASET_REDDIT_POSTS"),
    },

    // Kickstarter does not go through a dataset — CRMA-984's route is Web
    // Unlocker against Kickstarter's own discover/advanced JSON surface, so it
    // needs a zone name rather than a dataset id. Optional, because a deploy
    // with Kickstarter switched off should not require it.
    webUnlockerZone: env.BD_WEB_UNLOCKER_ZONE?.trim() || null,

    // The per-source kill switch. This is the lever for the TikTok precedent:
    // a scraped surface that vanishes while the scraper keeps "succeeding".
    isEnabled: (source) => enabled.has(source),
    enabledSources: [...enabled],
  };
}
