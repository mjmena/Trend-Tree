// Credential lookup for the replay harness.
//
// The harness runs on a laptop, not in Pipedream, so it cannot read the
// `google_gemini` / `anthropic` app props the workflows use. It reads the
// same keys from the macOS keychain instead. Nothing here writes a key to
// disk — the run artifacts under scripts/replay/out/ must stay shareable.

import { execFileSync } from "node:child_process";

const CACHE = new Map();

/**
 * Read a generic password from the macOS keychain.
 *
 * @param {string} service  Keychain service name, e.g. "gemini-api".
 * @returns {string}
 */
export function keychain(service) {
  if (CACHE.has(service)) return CACHE.get(service);
  let out;
  try {
    out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `No keychain entry for service '${service}'. Add one with:\n` +
        `  security add-generic-password -s ${service} -a "$USER" -w '<key>'`,
    );
  }
  if (!out) throw new Error(`Keychain entry '${service}' is empty.`);
  CACHE.set(service, out);
  return out;
}

/** Gemini API key. Env var wins so CI can inject one. */
export function geminiKey() {
  return process.env.GEMINI_API_KEY || keychain("gemini-api");
}

/** Anthropic API key, for the three Anthropic pins (CRMA-737). */
export function anthropicKey() {
  return process.env.ANTHROPIC_API_KEY || keychain("anthropic-api");
}

/**
 * Shape a key the way the deployed loops expect it. The workflows receive a
 * Pipedream app prop, not a bare string, and the inlined loop bodies read
 * `google_gemini.$auth.api_key`. Wrapping here lets the harness hand the
 * real loop code an object it already knows how to read.
 */
export function asAppProp(key) {
  return { $auth: { api_key: key } };
}
