// CRMA-1222 Request B: the Exploding Topics oracle path.
//
// For every Request-A case whose composed_criteria.decision_rule ===
// "oracle_decided" (evidence_quality rounded to needs_corroboration), fires
// the real ET /database-search for the oracle keyword (candidate_query if
// present, else trend_topic -- CRMA-1220/1224's established fallback,
// recording which one was sent), filters results at
// ET_MIN_ABSOLUTE_VOLUME (code does the arithmetic, never Jev), and asks one
// oracle_match Score per surviving result in a single Jev request sharing
// Request A's state.candidate. Any same_concept -> PROMOTE_NEW / CONFIRM_NEW.
// Otherwise -> REJECT / INSUFFICIENT_EVIDENCE. Zero surviving results needs
// no Jev call at all.
//
// Resumable: re-run skips audit_ids already in crma-1222-oracle-results.jsonl.
// Run: node crma-1222-oracle.mjs [--limit=N] [--concurrency=N]

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { systemOne, scoreQuestion, costUsd } from "./crma-1222-jev-client.mjs";
import questionDefs from "./crma-1221-jev-questions.json" with { type: "json" };
import { buildEtSearchRequest, normalizeEtResponse, ET_MIN_ABSOLUTE_VOLUME } from "../../../agents/lib/exploding_topics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_FILE = join(HERE, "crma-1222-cases.json");
const REQUEST_A_FILE = join(HERE, "crma-1222-results.jsonl");
const OUT_FILE = join(HERE, "crma-1222-oracle-results.jsonl");

const cases = JSON.parse(readFileSync(CASES_FILE, "utf8"));
const requestA = readFileSync(REQUEST_A_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

let _etKey;
function etKey() {
  if (_etKey) return _etKey;
  _etKey = execFileSync(
    "security",
    ["find-generic-password", "-s", "exploding-topics-trend-tree-scoping", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!_etKey) throw new Error("empty exploding-topics-trend-tree-scoping keychain entry");
  return _etKey;
}

const needsOracle = requestA.filter(
  (r) => !r.error && r.composed_criteria?.decision_rule === "oracle_decided",
);

const already = new Set();
if (existsSync(OUT_FILE)) {
  for (const line of readFileSync(OUT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { already.add(JSON.parse(line).audit_id); } catch {}
  }
}

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || Infinity);
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || 3);

let todo = needsOracle.filter((r) => !already.has(r.audit_id)).slice(0, limit);
console.error(`${needsOracle.length} cases need the oracle, ${already.size} already done, ${todo.length} to run (concurrency ${concurrency})`);

async function fetchEt(keyword) {
  const { url, headers, log_target } = buildEtSearchRequest({ keyword, apiKey: etKey() });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let resp, body = null;
  try {
    resp = await fetch(url, { headers, signal: ctrl.signal });
    const text = await resp.text();
    try { body = JSON.parse(text); } catch { body = null; }
  } finally {
    clearTimeout(timer);
  }
  const normalized = normalizeEtResponse({ status: resp.status, body });
  return { normalized, log_target };
}

const ORACLE_LABELS = ["different_concept", "adjacent_not_same", "same_concept"];
function roundScore(score, labels) {
  const idx = Math.max(0, Math.min(labels.length - 1, Math.round(score)));
  return labels[idx];
}

let cursor = 0, done = 0;
async function worker(id) {
  while (cursor < todo.length) {
    const r = todo[cursor++];
    const c = cases[r.audit_id];
    const keyword = c.candidate.candidate_query || c.candidate.trend_topic;
    const keywordSource = c.candidate.candidate_query ? "candidate_query" : "trend_topic";
    try {
      const { normalized, log_target } = await fetchEt(keyword);
      const survivors = (normalized.candidates || []).filter(
        (cand) => cand.absolute_volume != null && cand.absolute_volume >= ET_MIN_ABSOLUTE_VOLUME,
      );

      let record;
      if (!survivors.length) {
        record = {
          audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum,
          oracle_keyword: keyword, oracle_keyword_source: keywordSource,
          et_log_target: log_target, et_matched: normalized.matched, et_total: normalized.total,
          et_miss_message: normalized.miss_message ?? null, et_error: normalized.error ?? null,
          survivors: [], jev_called: false,
          decision: "REJECT", decision_category: "INSUFFICIENT_EVIDENCE", decision_rule: "oracle_decided",
        };
      } else {
        const questions = {};
        survivors.forEach((s, j) => {
          const oq = questionDefs.questions.oracle_match;
          questions[`oracle_match__r${j}`] = scoreQuestion(
            { oracle_result: { keyword: s.keyword }, question: oq.instructions.question },
            oq.criteria,
          );
        });
        const resp = await systemOne({ state: { candidate: c.candidate }, questions });
        const answers = survivors.map((s, j) => {
          const a = resp.answers[`oracle_match__r${j}`];
          return { keyword: s.keyword, absolute_volume: s.absolute_volume, path: s.path, score: a.score, confidence: a.confidence, verdict: roundScore(a.score, ORACLE_LABELS) };
        });
        const anySame = answers.some((a) => a.verdict === "same_concept");
        record = {
          audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum,
          oracle_keyword: keyword, oracle_keyword_source: keywordSource,
          et_log_target: log_target, et_matched: normalized.matched, et_total: normalized.total,
          survivors: survivors.map((s) => ({ keyword: s.keyword, absolute_volume: s.absolute_volume, path: s.path })),
          jev_called: true, oracle_answers: answers,
          request_id: resp.request_id, usage: resp.usage, cost_usd: costUsd(resp.usage), duration_ms: resp.duration_ms,
          decision: anySame ? "PROMOTE_NEW" : "REJECT",
          decision_category: anySame ? "CONFIRM_NEW" : "INSUFFICIENT_EVIDENCE",
          decision_rule: "oracle_decided",
        };
      }
      appendFileSync(OUT_FILE, JSON.stringify(record) + "\n");
      done++;
      console.error(`[w${id}] ${done}/${todo.length} ${r.audit_id.slice(0,8)} kw="${keyword}"(${keywordSource}) survivors=${survivors.length} -> ${record.decision}`);
    } catch (e) {
      const record = { audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, oracle_keyword: keyword, oracle_keyword_source: keywordSource, error: e.message, status: e.status ?? null };
      appendFileSync(OUT_FILE, JSON.stringify(record) + "\n");
      done++;
      console.error(`[w${id}] ${done}/${todo.length} ${r.audit_id.slice(0,8)} FAILED: ${e.message.split("\n")[0]}`);
    }
  }
}

const workers = Array.from({ length: Math.min(concurrency, todo.length) }, (_, i) => worker(i));
await Promise.all(workers);
console.error("done.");
