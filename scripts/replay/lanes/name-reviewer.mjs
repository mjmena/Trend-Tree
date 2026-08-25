// Lane: the enrichment name reviewer (CRMA-737, the largest Anthropic pin).
//
// The three Anthropic pins are claude-sonnet-4-6 on run_name_reviewer and on
// distillation-revisit's subagent, plus claude-haiku-4-5 on
// generate_search_terms. This adapter covers the name reviewer, which is the
// one with a persisted incumbent record — every enrichment PAYLOAD carries a
// `name_reviewer` block, so its historical verdicts are diffable.
//
// NO ANTHROPIC KEY IS NEEDED for the default comparison, which matters
// because there isn't one on this machine. The incumbent side is read from
// the ledger, and only the candidate is fired. `--rerun-incumbent` DOES need
// one and will say so plainly rather than failing obscurely.
//
// The lane is a two-stage blind test, and the stages must not be collapsed:
//   Stage 2 (decoder)  sees ONLY the name and guesses the subject.
//   Stage 3 (verifier) sees the guess AND the real topic, and scores it.
// The decoder's blindness is the whole measurement. A replay that let the
// decoder see the topic would score every name a 10.
//
// Tier-1 is a pure regex blocklist that can skip both calls (entry.js:42-78).
// The harness runs it first, exactly as production does, so a name the
// blocklist rejects is never billed to a model.

import { join } from "node:path";
import { query, sqlStr, variant } from "../lib/snowflake.mjs";
import { loadStep, readPin } from "../lib/entry_module.mjs";
import { loadPrompts, render, provenance } from "../lib/prompts.mjs";
import { REPO_ROOT } from "../lib/runner.mjs";

const ENTRY = join(REPO_ROOT, "enrichment-p_xMC995w", "run_name_reviewer", "entry.js");

export const name = "name-reviewer";
export const summary =
  "Blind decode-then-verify check on enrichment trend names. The one Anthropic pin with a persisted incumbent record.";
export const incumbentModel = "claude-sonnet-4-6";
export const ticket = "CRMA-737";

export async function cases({ limit = 3, caseId = null }) {
  const where = caseId ? `AND e.TREND_ID = ${sqlStr(caseId)}` : "";
  const rows = query(`
    SELECT e.TREND_ID, e.WRITTEN_AT,
           e.PAYLOAD:trend_name::STRING            AS TREND_NAME,
           e.PAYLOAD:category::STRING              AS CATEGORY,
           e.PAYLOAD:subcategory::STRING           AS SUBCATEGORY,
           e.PAYLOAD:name_reviewer                 AS NAME_REVIEWER,
           e.PAYLOAD:decode_pass::BOOLEAN          AS DECODE_PASS,
           e.PAYLOAD:decode_score::FLOAT           AS DECODE_SCORE,
           t.TREND_TOPIC
      FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_ENRICHMENT_LEDGER e
      JOIN MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS t USING (TREND_ID)
     WHERE e.ENRICHMENT_KIND = 'initial'
       AND e.PAYLOAD:trend_name IS NOT NULL
       AND e.PAYLOAD:name_reviewer IS NOT NULL
       ${where}
     QUALIFY ROW_NUMBER() OVER (PARTITION BY e.TREND_ID ORDER BY e.WRITTEN_AT DESC) = 1
     ORDER BY e.WRITTEN_AT DESC
     LIMIT ${Number(limit)}
  `);

  return rows.map((r) => {
    const nr = variant(r.NAME_REVIEWER) || {};
    return {
      id: r.TREND_ID,
      label: `"${r.TREND_NAME}" · reviewed ${String(r.WRITTEN_AT).slice(0, 16)}`,
      incumbentAt: String(r.WRITTEN_AT).slice(0, 10),
      trendName: r.TREND_NAME,
      trendTopic: r.TREND_TOPIC,
      category: r.CATEGORY,
      subcategory: r.SUBCATEGORY,
      incumbent: {
        emission: {
          decoder_guess: nr.decoder_guess ?? null,
          decode_pass: nr.decode_pass ?? r.DECODE_PASS,
          decode_score: nr.decode_score ?? r.DECODE_SCORE,
          alternates: nr.alternates ?? nr.alternate_names ?? null,
          tier1_pass: nr.tier1_pass ?? null,
        },
        telemetry: { model: incumbentModel },
      },
    };
  });
}

export async function build(c) {
  const { tier1Check } = await loadStep(ENTRY, ["tier1Check"]);
  const pin = readPin(ENTRY);

  // Production's own Tier-1 gate. A name it rejects never reaches a model.
  const tier1 = tier1Check(c.trendName);

  const loaded = loadPrompts(["enrichment.reviewer.decoder", "enrichment.reviewer.verifier"]);
  const decoder = loaded["enrichment.reviewer.decoder"];

  // Stage 2 only. The decoder is the blind half and the half a model swap
  // would actually change; the verifier merely scores the guess it is given.
  // Replaying stage 3 here would score the CANDIDATE's guess against the
  // INCUMBENT's, which is a different question from the one CRMA-737 asks.
  const system = render(decoder.template, { trend_name: c.trendName });

  return {
    mode: "single",
    system,
    contents: [{ role: "user", parts: [{ text: "Decode the trend name. Reply with JSON only." }] }],
    maxOutputTokens: decoder.params.max_tokens || 200,
    temperature: decoder.params.temperature ?? 0.8,
    thinkingLevel: "low",
    parse: (text) => {
      const m = String(text).match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    },
    promptProvenance: provenance(loaded),
    notes: {
      trend_name: c.trendName,
      trend_topic: c.trendTopic,
      tier1_pass: tier1?.pass ?? tier1,
      tier1_note: "production skips BOTH model calls when Tier-1 fails — no spend at all",
      stage_replayed: "decoder only (stage 2); the verifier scores a guess and is not the model-sensitive half",
      deployed_rates: pin.rates,
      anthropic_key:
        "not required for this comparison — the incumbent is read from the ledger. --rerun-incumbent would need one.",
    },
  };
}

/**
 * The two sides are keyed differently ON PURPOSE, and CRMA-760 confirms the
 * asymmetry is correct in principle but was wrong in three names:
 *
 *   left  — the persisted PAYLOAD:name_reviewer record, whose keys come from
 *           run_name_reviewer/entry.js: decoder_guess, score, decode_pass,
 *           alternate (SINGULAR).
 *   right — this lane replays the DECODER ONLY, and the decoder prompt
 *           declares exactly one key: { "guess": "..." }.
 *
 * So score / decode_pass / alternate are incumbent-only by construction — the
 * verifier that produces them is not replayed. They render "—" on the right
 * rather than reading a key the decoder can never emit.
 *
 * Verified against 1035 ledger rows: `decode_score` and `alternates` (plural)
 * appear 0 times; `score` appears 504 times and `alternate` 29 times.
 */
export function compareRows(incumbent, candidate, result) {
  const a = incumbent?.emission ?? {};
  const b = candidate?.emission ?? {};
  const topic = result?.built?.input_notes?.trend_topic;
  const NOT_REPLAYED = "— (verifier not replayed)";
  return [
    {
      field: "decoder_guess",
      left: a.decoder_guess,
      right: b.guess,
      note: `actual topic: ${topic ?? "?"} — judge which guess is closer`,
    },
    { field: "score (incumbent verdict)", left: a.score, right: NOT_REPLAYED },
    { field: "decode_pass (incumbent verdict)", left: a.decode_pass, right: NOT_REPLAYED },
    { field: "alternate offered (incumbent)", left: a.alternate ?? "—", right: NOT_REPLAYED },
  ];
}

export default { name, summary, incumbentModel, ticket, cases, build, compareRows };
