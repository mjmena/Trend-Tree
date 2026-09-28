// CRMA-1222 orchestrator: fires the fanned-out pairwise check against every
// case in crma-1222-cases.json, applies the composition rules from
// crma-1221-jev-questions.json, and checkpoints raw + composed results to
// crma-1222-results.jsonl (resumable -- re-run skips AUDIT_IDs already
// present in the file).
//
// Runs BOTH Noul-criteria arms per neighbour (CRMA-1222's ticket requires
// the comparison) inside one request per candidate, so "one Jev request per
// candidate" (the map's standing constraint) still holds for request A.
// Request B (oracle_match) is NOT fired live: no EXPLODING_TOPICS_API_KEY is
// reachable in this environment (checked keychain, env, GCP Secret Manager --
// none exist here either, same gap CRMA-1216/1229 already documented for the
// harness on wayfinder/gemini-3-7-flash-model-allocation). Any case whose
// evidence_quality rounds to needs_corroboration is marked unscored with
// reason "et_unavailable" rather than silently guessed.

import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { systemOne, scoreQuestion, noulQuestion, costUsd } from "./crma-1222-jev-client.mjs";
import questionDefs from "./crma-1221-jev-questions.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_FILE = join(HERE, "crma-1222-cases.json");
const RESULTS_FILE = join(HERE, "crma-1222-results.jsonl");

const cases = JSON.parse(readFileSync(CASES_FILE, "utf8"));

const already = new Set();
if (existsSync(RESULTS_FILE)) {
  for (const line of readFileSync(RESULTS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { already.add(JSON.parse(line).audit_id); } catch {}
  }
}

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
const limit = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || Infinity);
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || 6);

let todo = Object.values(cases).filter((c) => !already.has(c.audit_id));
if (only) todo = todo.filter((c) => only.includes(c.audit_id) || only.includes(c.candidate_id));
todo = todo.slice(0, limit);
console.error(`${Object.keys(cases).length} total cases, ${already.size} already done, ${todo.length} to run (concurrency ${concurrency})`);

function neighborPayload(n) {
  return { trend_topic: n.trend_topic, summary: n.summary, sample_signals: n.sample_signals };
}

function buildQuestions(c) {
  const q = {};
  const eq = questionDefs.questions.evidence_quality;
  q.evidence_quality = scoreQuestion(eq.instructions, eq.criteria);

  const ps = questionDefs.questions.pair_sameness;
  const recur = questionDefs.questions.is_same_recurring_topic;
  const row = questionDefs.questions.recurrence_deserves_own_row;
  const narrow = questionDefs.questions.is_narrower_instance;

  c.neighbors.forEach((n, i) => {
    const neighbor = neighborPayload(n);
    q[`pair_sameness__n${i}`] = scoreQuestion({ neighbor, question: ps.instructions.question }, ps.criteria);

    q[`is_same_recurring_topic__n${i}`] = noulQuestion({ neighbor, question: recur.instructions.question }, recur.criteria);
    q[`is_same_recurring_topic__n${i}__bare`] = noulQuestion({ neighbor, question: recur.instructions.question });

    q[`recurrence_deserves_own_row__n${i}`] = noulQuestion({ neighbor, question: row.instructions.question }, row.criteria);
    q[`recurrence_deserves_own_row__n${i}__bare`] = noulQuestion({ neighbor, question: row.instructions.question });

    q[`is_narrower_instance__n${i}`] = noulQuestion({ neighbor, question: narrow.instructions.question }, narrow.criteria);
    q[`is_narrower_instance__n${i}__bare`] = noulQuestion({ neighbor, question: narrow.instructions.question });
  });

  return q;
}

function roundScore(score, labels) {
  const idx = Math.max(0, Math.min(labels.length - 1, Math.round(score)));
  return labels[idx];
}

const EQ_LABELS = ["not_a_topic", "needs_corroboration", "stands_alone"];
const PS_LABELS = ["different_thing", "unsettled", "same_thing"];

// Provisional cut points (CRMA-1217's measured starting bands) -- NOT final.
// The real cut points are CRMA-1223's job; this run reports the measured
// distributions so that ticket has fresh, widened-set data to fit against.
const RECUR_HIGH = 0.84, ROW_HIGH = 0.80;

function compose(c, answers, arm) {
  const suffix = arm === "bare" ? "__bare" : "";
  const eq = answers.evidence_quality;
  const eqVerdict = roundScore(eq.score, EQ_LABELS);

  if (eqVerdict === "not_a_topic") {
    return { decision: "REJECT", decision_category: "LOW_QUALITY", decision_rule: "not_a_topic_reject", target_trend_id: null, eq_verdict: eqVerdict, eq_confidence: eq.confidence };
  }

  const neighborResults = c.neighbors.map((n, i) => {
    const ps = answers[`pair_sameness__n${i}`];
    const psVerdict = roundScore(ps.score, PS_LABELS);
    return {
      trend_id: n.trend_id,
      trend_topic: n.trend_topic,
      psVerdict, psScore: ps.score, psConfidence: ps.confidence,
      recurring: answers[`is_same_recurring_topic__n${i}${suffix}`]?.noul ?? null,
      deservesOwnRow: answers[`recurrence_deserves_own_row__n${i}${suffix}`]?.noul ?? null,
      narrower: answers[`is_narrower_instance__n${i}${suffix}`]?.noul ?? null,
    };
  });

  const sameThing = neighborResults.filter((r) => r.psVerdict === "same_thing");
  if (sameThing.length) {
    sameThing.sort((a, b) => b.psConfidence - a.psConfidence);
    const top = sameThing[0];
    const recurHigh = (top.recurring ?? 0) >= RECUR_HIGH;
    const rowHigh = (top.deservesOwnRow ?? 0) >= ROW_HIGH;
    if (recurHigh && rowHigh) {
      return {
        decision: "PROMOTE_NEW", decision_category: "CONFIRM_NEW", decision_rule: "recurrence_blocked_merge",
        target_trend_id: null, blocked_neighbor: top.trend_id, eq_verdict: eqVerdict,
        neighbor_results: neighborResults,
      };
    }
    return {
      decision: "MERGE_INTO_EXISTING", decision_category: "MISSED_DUPLICATE", decision_rule: "neighbour_merge",
      target_trend_id: top.trend_id, eq_verdict: eqVerdict,
      multiple_same_thing: sameThing.length > 1 ? sameThing.map((s) => s.trend_id) : null,
      neighbor_results: neighborResults,
    };
  }

  if (eqVerdict === "stands_alone") {
    return { decision: "PROMOTE_NEW", decision_category: "CONFIRM_NEW", decision_rule: "stands_alone_promote", target_trend_id: null, eq_verdict: eqVerdict, neighbor_results: neighborResults };
  }

  // needs_corroboration
  return { decision: null, decision_category: null, decision_rule: "oracle_decided", target_trend_id: null, eq_verdict: eqVerdict, unscored_reason: "et_unavailable", neighbor_results: neighborResults };
}

let cursor = 0, done = 0;
async function worker(id) {
  while (cursor < todo.length) {
    const c = todo[cursor++];
    const started = Date.now();
    try {
      const questions = buildQuestions(c);
      const nQ = Object.keys(questions).length;
      const resp = await systemOne({ state: { candidate: c.candidate }, questions });
      const composedCriteria = compose(c, resp.answers, "criteria");
      const composedBare = compose(c, resp.answers, "bare");
      const record = {
        audit_id: c.audit_id,
        candidate_id: c.candidate_id,
        stratum: c.stratum,
        n_neighbors: c.neighbors.length,
        n_questions: nQ,
        source_data_empty: c.candidate.sources.length === 0 && c.candidate.signals.length === 0,
        request_id: resp.request_id,
        usage: resp.usage,
        cost_usd: costUsd(resp.usage),
        duration_ms: resp.duration_ms,
        answers: resp.answers,
        composed_criteria: composedCriteria,
        composed_bare: composedBare,
      };
      appendFileSync(RESULTS_FILE, JSON.stringify(record) + "\n");
      done++;
      console.error(`[w${id}] ${done}/${todo.length} ${c.audit_id.slice(0,8)} ${c.stratum} n=${c.neighbors.length} q=${nQ} -> ${composedCriteria.decision}/${composedCriteria.decision_rule} ($${record.cost_usd.toFixed(6)}, ${record.duration_ms}ms)`);
    } catch (e) {
      const record = { audit_id: c.audit_id, candidate_id: c.candidate_id, stratum: c.stratum, error: e.message, status: e.status ?? null, classified: e.classified ?? null };
      appendFileSync(RESULTS_FILE, JSON.stringify(record) + "\n");
      done++;
      console.error(`[w${id}] ${done}/${todo.length} ${c.audit_id.slice(0,8)} FAILED: ${e.message.split("\n")[0]}`);
    }
  }
}

const workers = Array.from({ length: Math.min(concurrency, todo.length) }, (_, i) => worker(i));
await Promise.all(workers);
console.error("done.");
