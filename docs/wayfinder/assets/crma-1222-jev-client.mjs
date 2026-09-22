// Hand-rolled TypeSafe Jev client for CRMA-1222's prototype.
//
// Raw fetch against the documented HTTP contract (docs.typesafe.ai/api)
// rather than the @typesafe-ai/sdk npm package: this repo's root must stay
// free of a package.json (Pipedream's GitHub sync watches it -- CLAUDE.md),
// and the reference Gemini replay client (scripts/replay/lib/gemini.mjs, on
// wayfinder/gemini-3-7-flash-model-allocation) hand-rolls fetch the same way
// for the same reason. No TypeSafe/Jev client existed anywhere in this
// repo's history before this file (verified 2026-09-21).

import { execFileSync } from "node:child_process";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// jev-latest and jev-preview both resolve to jev-1.13.0 today, but a vendor
// bump would move the rubric underneath a governed DIM_LLM_PROMPT row with
// nothing to flag it (CRMA-1215). Name the explicit version.
export const MODEL = "jev-1.13.0";

let _key;
export function jevKey() {
  if (_key) return _key;
  if (process.env.TYPESAFE_API_KEY) return (_key = process.env.TYPESAFE_API_KEY);
  _key = execFileSync(
    "security",
    ["find-generic-password", "-s", "typesafe-trend-tree-scoping", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!_key) throw new Error("empty typesafe-trend-tree-scoping keychain entry");
  return _key;
}

// Keep the SDK's retry defaults (map established fact, CRMA-1218/1215):
// {408, 429, *range(500,600)}. 529 (overload) is covered by the 500-599
// sweep -- do not pin a narrower httpStatuses list, that's the documented
// Python-SDK-example trap that silently drops 529.
const RETRYABLE = new Set([408, 429]);
for (let s = 500; s < 600; s++) RETRYABLE.add(s);

// Error shape is polymorphic (CRMA-1218 measured live): 401 -> object with
// error_type; 400 -> object with error_type (capacity) or a bare string
// (semantic); 422 -> a list of Pydantic records (schema). Type-check
// `detail` before reading `error_type` -- it is absent on two of the four.
function classifyError(status, bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  if (status === 422 && Array.isArray(parsed)) return { kind: "schema", detail: parsed };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { kind: parsed.error_type ? "typed" : "object", detail: parsed, error_type: parsed.error_type ?? null };
  }
  if (typeof parsed === "string") return { kind: "semantic_or_capacity", detail: parsed };
  return { kind: "unknown", detail: bodyText.slice(0, 800) };
}

function backoff(attempt) {
  const ms = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One systemOne call.
 * @param {object} a
 * @param {string|object|array} a.state
 * @param {object} a.questions  map<key, {type:"score"|"noul", instructions, criteria?}>
 * @param {string} [a.model]
 */
export async function systemOne({ state, questions, model = MODEL, timeoutMs = 60_000, maxRetries = 4 }) {
  const apiKey = jevKey();
  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model, questions }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = new Error(`Jev fetch failed: ${e.message}`);
      if (attempt > maxRetries) throw lastErr;
      await backoff(attempt);
      continue;
    }
    clearTimeout(timer);
    const text = await resp.text();
    const requestId = resp.headers.get("x-typesafe-request-id") || null;
    if (!resp.ok) {
      const classified = classifyError(resp.status, text);
      const err = new Error(`Jev HTTP ${resp.status}: ${text.slice(0, 400)}`);
      err.status = resp.status;
      err.classified = classified;
      err.requestId = requestId;
      if (RETRYABLE.has(resp.status) && attempt <= maxRetries) {
        lastErr = err;
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    const data = JSON.parse(text);
    return { ...data, duration_ms: Date.now() - started, request_id: requestId, attempt };
  }
  throw lastErr;
}

// Question builders matching docs.typesafe.ai/primitives/{score,noul}.md.
export function scoreQuestion(instructions, criteria) {
  return { type: "score", instructions, criteria };
}
export function noulQuestion(instructions, criteria) {
  const q = { type: "noul", instructions };
  if (criteria) q.criteria = criteria;
  return q;
}

// $42 per BILLION input tokens, output free (CRMA-1215 live measurement,
// map established fact: "904 input tokens ... $0.000038 per candidate" only
// reconciles at $42/Btok, i.e. $0.042/Mtok -- NOT $42/Mtok).
export const RATE_PER_B_INPUT = 42;
export function costUsd(usage) {
  return ((usage?.input_tokens || 0) / 1e9) * RATE_PER_B_INPUT;
}
