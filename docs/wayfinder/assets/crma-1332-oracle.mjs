// CRMA-1332: re-run CRMA-1222's Request B (the ET oracle) with a searchable
// keyword instead of the trend_topic sentence.
//
// Only the 104 needs_corroboration cases whose candidate_query is null get a
// new keyword. The 12 with a candidate_query keep their CRMA-1222 record
// unchanged, so each arm's output file is a drop-in ORACLE_FILE for
// crma-1222-score.mjs. Request A is never re-run.
//
// Two keyword arms, both drawing on the same code-proposed phrases (1-3 word
// n-grams from trend_topic + every signal_text):
//   signal_frequency -- code only: the phrases that recur across the most
//                       texts. No model call.
//   jev_selected     -- one Jev request per candidate, one Noul per phrase,
//                       asking whether the phrase names the candidate itself.
//                       Jev does not generate text, so it ranks what code
//                       proposes; it cannot invent a term that is not there.
// Each arm sends at most KEYWORDS_PER_ARM keywords. Survivors of the 1000
// volume floor across all of an arm's keywords (deduped by ET path) go to
// oracle_match exactly as in CRMA-1222: one Score per result, carrying only
// the ET keyword. Any same_concept -> PROMOTE_NEW / CONFIRM_NEW.
//
// ET responses are cached on disk by keyword (crma-1332-et-cache.json): the
// harness key is production's key (CRMA-1255), so no keyword is fetched
// twice across arms, duplicate audit rows, or re-runs.
//
//   hand_written_ceiling -- only the multi-AI-agent candidates, keywords from
//                       crma-1332-hand-keywords.json; everything else reuses
//                       its jev_selected record. A ceiling, not a source.
//
// Run: node crma-1332-oracle.mjs [--arm=signal_frequency|jev_selected|hand_written_ceiling] [--limit=N]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { systemOne, scoreQuestion, noulQuestion, costUsd } from "./crma-1222-jev-client.mjs";
import questionDefs from "./crma-1221-jev-questions.json" with { type: "json" };
import { buildEtSearchRequest, normalizeEtResponse, ET_MIN_ABSOLUTE_VOLUME } from "../../../agents/lib/exploding_topics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(HERE, "crma-1222-cases.json"), "utf8"));
const requestA = readFileSync(join(HERE, "crma-1222-results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const baseline = new Map(
  readFileSync(join(HERE, "crma-1222-oracle-results.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map((o) => [o.audit_id, o]),
);
const ET_CACHE_FILE = join(HERE, "crma-1332-et-cache.json");
const JEV_CACHE_FILE = join(HERE, "crma-1332-jev-select-cache.json");
const etCache = existsSync(ET_CACHE_FILE) ? JSON.parse(readFileSync(ET_CACHE_FILE, "utf8")) : {};
const jevSelectCache = existsSync(JEV_CACHE_FILE) ? JSON.parse(readFileSync(JEV_CACHE_FILE, "utf8")) : {};

export const KEYWORDS_PER_ARM = 2;
const MAX_PHRASES_FOR_JEV = 30;
const ARMS = ["signal_frequency", "jev_selected"];
const handKeywords = JSON.parse(readFileSync(join(HERE, "crma-1332-hand-keywords.json"), "utf8"));

const STOP = new Set(`a an the and or of for to in on at by with from into via as is are be being been
its it this that these those their them they people consumers shoppers users adults teens kids
using use used adopting adopt buying buy choosing choose making make trying try seeking seek
new more most rise rising growing growth trend trends trending popular daily everyday
own your our my his her than then over under up down out about across beyond toward towards
not no non vs versus like such other based driven led`.split(/\s+/));

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‐-―\-_/]/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/'s\b/g, "")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Every 1-3 word n-gram that neither starts nor ends on a stopword; a unigram
// must be at least 4 characters. Scored by how many of the candidate's texts
// (topic + signals) contain it -- the "most frequent signal keywords" option.
export function proposePhrases(candidate) {
  const texts = [candidate.trend_topic, ...(candidate.signals || []).map((s) => s.signal_text)].filter(Boolean);
  const stats = new Map();
  texts.forEach((text, ti) => {
    const w = tokens(text);
    const seen = new Set();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n);
        if (STOP.has(g[0]) || STOP.has(g[n - 1])) continue;
        if (n === 1 && g[0].length < 4) continue;
        if (/^\d+$/.test(g.join(""))) continue;
        const p = g.join(" ");
        if (seen.has(p)) continue;
        seen.add(p);
        const s = stats.get(p) || { phrase: p, n, df: 0, first: ti * 100 + i };
        s.df++;
        stats.set(p, s);
      }
    }
  });
  // Two-word terms hit ET best (probed live 2026-09-28: "cooling towel",
  // "sparkling protein" hit; sentences and rare coinages miss).
  const lengthRank = { 2: 0, 3: 1, 1: 2 };
  return [...stats.values()].sort(
    (a, b) => b.df - a.df || lengthRank[a.n] - lengthRank[b.n] || a.first - b.first,
  );
}

function overlaps(a, b) {
  return a.includes(b) || b.includes(a);
}
function pickDistinct(ordered, k) {
  const out = [];
  for (const p of ordered) {
    if (out.length >= k) break;
    if (out.some((q) => overlaps(q, p))) continue;
    out.push(p);
  }
  return out;
}

export function signalFrequencyKeywords(candidate) {
  return pickDistinct(proposePhrases(candidate).map((s) => s.phrase), KEYWORDS_PER_ARM);
}

const SELECT_QUESTION =
  "Is `phrase` a name for `candidate.trend_topic` itself -- the short term a person would type into a search box to find this exact thing?";
const SELECT_CRITERIA = {
  true: "The phrase names the candidate's own concept -- the product, practice, ingredient, format or coined name that the topic is about -- specifically enough that a search for it would land on this topic.",
  false: "The phrase is a generic word, the broad category the topic sits inside, a fragment naming only one part of it, or words that describe the topic without naming it.",
};

async function jevSelectKeywords(c) {
  const cid = c.candidate_id;
  if (jevSelectCache[cid]) return jevSelectCache[cid];
  const phrases = proposePhrases(c.candidate).slice(0, MAX_PHRASES_FOR_JEV).map((s) => s.phrase);
  const questions = {};
  phrases.forEach((p, i) => {
    questions[`names_candidate__p${i}`] = noulQuestion({ phrase: p, question: SELECT_QUESTION }, SELECT_CRITERIA);
  });
  const resp = await systemOne({ state: { candidate: c.candidate }, questions });
  const ranked = phrases
    .map((p, i) => ({ phrase: p, p: resp.answers[`names_candidate__p${i}`].noul }))
    .sort((a, b) => b.p - a.p);
  const above = ranked.filter((r) => r.p >= 0.5).map((r) => r.phrase);
  const keywords = pickDistinct(above.length ? above : [ranked[0].phrase], KEYWORDS_PER_ARM);
  const out = {
    keywords, ranked, fell_back_below_half: above.length === 0,
    request_id: resp.request_id, usage: resp.usage, cost_usd: costUsd(resp.usage), duration_ms: resp.duration_ms,
  };
  jevSelectCache[cid] = out;
  writeFileSync(JEV_CACHE_FILE, JSON.stringify(jevSelectCache, null, 1));
  return out;
}

let _etKey;
function etKey() {
  if (_etKey) return _etKey;
  _etKey = execFileSync("security", ["find-generic-password", "-s", "exploding-topics-trend-tree-scoping", "-w"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return _etKey;
}

let etCalls = 0, lastEtAt = 0;
async function fetchEt(keyword) {
  const k = keyword.toLowerCase();
  if (etCache[k]) return etCache[k];
  // 60 requests/minute (x-ratelimit-limit); stay well under it.
  const wait = lastEtAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEtAt = Date.now();
  const { url, headers, log_target } = buildEtSearchRequest({ keyword: k, apiKey: etKey() });
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await resp.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  etCalls++;
  const normalized = normalizeEtResponse({ status: resp.status, body });
  if (normalized.error) throw new Error(`ET ${normalized.error} for "${k}"`);
  etCache[k] = { log_target, normalized, fetched_at: new Date().toISOString() };
  writeFileSync(ET_CACHE_FILE, JSON.stringify(etCache, null, 1));
  return etCache[k];
}

let _jevRecords;
function jevRecords() {
  _jevRecords ??= new Map(
    readFileSync(join(HERE, "crma-1332-oracle-jev_selected.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map((o) => [o.audit_id, o]),
  );
  return _jevRecords;
}

const ORACLE_LABELS = ["different_concept", "adjacent_not_same", "same_concept"];
const roundScore = (score) => ORACLE_LABELS[Math.max(0, Math.min(2, Math.round(score)))];

async function runCase(arm, r) {
  const c = cases[r.audit_id];
  const base = baseline.get(r.audit_id);
  if (c.candidate.candidate_query) return { ...base, arm, keyword_from_crma_1222: true };

  let select = null, keywords;
  if (arm === "hand_written_ceiling") {
    keywords = handKeywords[c.candidate_id];
    if (!keywords) return { ...jevRecords().get(r.audit_id), arm, keyword_from_jev_selected: true };
  } else if (arm === "signal_frequency") keywords = signalFrequencyKeywords(c.candidate);
  else { select = await jevSelectKeywords(c); keywords = select.keywords; }

  const perKeyword = [];
  const survivorsByPath = new Map();
  for (const kw of keywords) {
    const { normalized } = await fetchEt(kw);
    const surv = (normalized.candidates || []).filter(
      (x) => x.absolute_volume != null && x.absolute_volume >= ET_MIN_ABSOLUTE_VOLUME,
    );
    perKeyword.push({ keyword: kw, source: arm, et_total: normalized.total, et_matched: normalized.matched, survivors: surv.length });
    for (const s of surv) if (!survivorsByPath.has(s.path)) survivorsByPath.set(s.path, { ...s, from_keyword: kw });
  }
  const survivors = [...survivorsByPath.values()];

  const record = {
    audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, arm,
    oracle_keyword: keywords.join(" | "), oracle_keyword_source: arm,
    keywords: perKeyword,
    et_matched: perKeyword.some((k) => k.et_matched), et_total: perKeyword.reduce((s, k) => s + (k.et_total || 0), 0),
    survivors: survivors.map((s) => ({ keyword: s.keyword, absolute_volume: s.absolute_volume, path: s.path, from_keyword: s.from_keyword })),
    select: select && { ranked: select.ranked.slice(0, 8), fell_back_below_half: select.fell_back_below_half, cost_usd: select.cost_usd },
    jev_called: survivors.length > 0,
    decision_rule: "oracle_decided",
  };
  if (!survivors.length) return { ...record, decision: "REJECT", decision_category: "INSUFFICIENT_EVIDENCE" };

  const oq = questionDefs.questions.oracle_match;
  const questions = {};
  survivors.forEach((s, j) => {
    questions[`oracle_match__r${j}`] = scoreQuestion({ oracle_result: { keyword: s.keyword }, question: oq.instructions.question }, oq.criteria);
  });
  const resp = await systemOne({ state: { candidate: c.candidate }, questions });
  const answers = survivors.map((s, j) => {
    const a = resp.answers[`oracle_match__r${j}`];
    return { keyword: s.keyword, absolute_volume: s.absolute_volume, from_keyword: s.from_keyword, score: a.score, confidence: a.confidence, verdict: roundScore(a.score) };
  });
  const anySame = answers.some((a) => a.verdict === "same_concept");
  return {
    ...record, oracle_answers: answers,
    request_id: resp.request_id, cost_usd: costUsd(resp.usage) + (select?.cost_usd || 0),
    decision: anySame ? "PROMOTE_NEW" : "REJECT",
    decision_category: anySame ? "CONFIRM_NEW" : "INSUFFICIENT_EVIDENCE",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const onlyArm = args.find((a) => a.startsWith("--arm="))?.split("=")[1];
  const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || Infinity);
  const needsOracle = requestA.filter((r) => !r.error && r.composed_criteria?.decision_rule === "oracle_decided").slice(0, limit);
  for (const arm of onlyArm ? [onlyArm] : ARMS) {
    const out = [];
    for (const r of needsOracle) {
      try {
        const rec = await runCase(arm, r);
        out.push(rec);
        console.error(`[${arm}] ${out.length}/${needsOracle.length} ${r.candidate_id} kw="${rec.oracle_keyword}" survivors=${rec.survivors?.length ?? "-"} -> ${rec.decision}`);
      } catch (e) {
        out.push({ audit_id: r.audit_id, candidate_id: r.candidate_id, stratum: r.stratum, arm, error: e.message });
        console.error(`[${arm}] ${r.candidate_id} FAILED: ${e.message}`);
      }
    }
    writeFileSync(join(HERE, `crma-1332-oracle-${arm}.jsonl`), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
    console.error(`[${arm}] done. ET calls this process so far: ${etCalls}`);
  }
}
