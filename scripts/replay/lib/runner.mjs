// The replay engine.
//
// A lane adapter says WHAT to replay; this file decides HOW every lane is
// replayed, so nine lane decisions rest on one comparison method rather than
// nine slightly different ones.
//
// The comparison is against WHAT PRODUCTION ACTUALLY PRODUCED — the map's
// standing constraint. The incumbent side is read from the ledger, not
// re-generated, so the candidate is judged against the real artifact. Pass
// `rerunIncumbent` to additionally fire the incumbent model today, which
// separates "the model changed" from "the world changed" when a lane looks
// worse than its ledger record.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCoverage } from "./fieldcheck.mjs";
import {
  compareStatements,
  ensureScratchTable,
  persist,
  formatNeighbors,
  SCRATCH_TABLE,
} from "./descriptor_neighbors.mjs";
import { geminiKey } from "./secrets.mjs";
import { runLoop, callGemini, costBothWays, classifyFinish, terminalEmission, ratesFor } from "./gemini.mjs";
import * as diff from "./diff.mjs";

export const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(dirname(HARNESS_ROOT));
const OUT_DIR = join(HARNESS_ROOT, "out");

/**
 * Run one lane.
 *
 * @param {object} lane          A module from scripts/replay/lanes/.
 * @param {object} opts
 * @param {string} opts.model    Candidate model id.
 * @param {number} opts.limit    How many historical cases.
 * @param {boolean} [opts.rerunIncumbent]
 * @param {string}  [opts.caseId] Replay one specific case.
 * @param {boolean} [opts.dryRun] Assemble inputs, make no model calls.
 */
export async function runLane(lane, opts) {
  const { model, limit, rerunIncumbent = false, caseId = null, dryRun = false } = opts;
  const apiKey = dryRun ? null : geminiKey();
  const startedAt = new Date();
  const runId = `${lane.name}_${startedAt.toISOString().replace(/[:.]/g, "-")}`;

  process.stderr.write(diff.dim(`  selecting cases…\n`));
  const cases = await lane.cases({ limit, caseId });
  if (!cases.length) {
    throw new Error(
      `Lane '${lane.name}' found no historical cases. Widen the window or pick another lane.`,
    );
  }

  const results = [];
  for (const [i, c] of cases.entries()) {
    process.stderr.write(diff.dim(`  [${i + 1}/${cases.length}] ${c.label} — assembling input…\n`));
    const built = await lane.build(c);

    if (dryRun) {
      results.push({ case: c, built: describeBuild(built), skipped: "dry-run" });
      continue;
    }

    process.stderr.write(diff.dim(`  [${i + 1}/${cases.length}] ${c.label} — calling ${model}…\n`));
    let candidate;
    try {
      candidate = await invoke(lane, built, model, apiKey);
    } catch (e) {
      candidate = { error: e.message, model };
      process.stderr.write(diff.bad(`  [${i + 1}/${cases.length}] ${c.label} — FAILED: ${e.message.split("\n")[0]}\n`));
    }

    let incumbentRerun = null;
    if (rerunIncumbent) {
      process.stderr.write(diff.dim(`  [${i + 1}/${cases.length}] ${c.label} — re-running ${lane.incumbentModel}…\n`));
      try {
        incumbentRerun = await invoke(lane, built, lane.incumbentModel, apiKey);
      } catch (e) {
        incumbentRerun = { error: e.message, model: lane.incumbentModel };
      }
    }

    const schema = built.terminalSchema || null;
    const fields =
      schema && candidate?.emission
        ? compareCoverage(schema, c.incumbent?.emission ?? c.incumbent ?? {}, candidate.emission)
        : null;

    let descriptor = null;
    if (opts.descriptorNeighbors && lane.descriptorStatements) {
      try {
        descriptor = await runDescriptorAxis(lane, c, candidate, opts, runId);
      } catch (e) {
        descriptor = { error: e.message };
        process.stderr.write(diff.warn(`  descriptor axis failed: ${e.message.split("\n")[0]}\n`));
      }
    }

    results.push({ case: c, built: describeBuild(built), candidate, incumbentRerun, fields, descriptor });
  }

  const artifact = writeArtifact(lane, opts, results, startedAt);
  return { lane, opts, results, artifact };
}

/**
 * The CRMA-728 descriptor axis, for lanes that expose a statement pair.
 * Writes to a scratch table only — never a production ledger.
 */
async function runDescriptorAxis(lane, c, candidate, opts, runId) {
  const { incumbent: incStmt, candidate: candStmt } = lane.descriptorStatements(c.incumbent, candidate);
  if (!candStmt) return { skipped: "candidate produced no descriptor.statement" };

  ensureScratchTable();
  const result = compareStatements({
    trendId: c.id,
    incumbentStatement: incStmt,
    candidateStatement: candStmt,
    k: opts.neighborK ?? 3,
  });
  const written = persist({
    runId,
    lane: lane.name,
    candidateModel: opts.model,
    trendId: c.id,
    incumbentStatement: incStmt,
    candidateStatement: candStmt,
    result,
  });
  return { ...result, rows_written: written, scratch_table: SCRATCH_TABLE };
}

/** Dispatch a built input at a model — loop or single-shot, per the lane. */
async function invoke(lane, built, model, apiKey) {
  if (built.mode === "single") {
    const resp = await callGemini({
      apiKey,
      model,
      system: built.system,
      contents: built.contents,
      responseSchema: built.responseSchema,
      // hasOwn, not ??, so a lane can say null and mean "omit the key".
      thinkingLevel: Object.hasOwn(built, "thinkingLevel") ? built.thinkingLevel : "medium",
      maxOutputTokens: Object.hasOwn(built, "maxOutputTokens") ? built.maxOutputTokens : 8192,
      temperature: built.temperature,
      tools: built.tools,
      functionCallingMode: Object.hasOwn(built, "functionCallingMode") ? built.functionCallingMode : "AUTO",
    });
    const text = resp.parts.filter((p) => typeof p.text === "string" && p.thought !== true).map((p) => p.text).join("");
    // A lane's parse may be async — the verticals lane resolves grounding
    // redirects through the deployed URL verifier before it can judge output.
    const emission = built.parse ? await built.parse(text, resp) : text;
    const accounting = costBothWays(resp.usage, model);
    return {
      model,
      mode: "single",
      finish: classifyFinish(resp.finishReason, emission != null),
      duration_ms: resp.duration_ms,
      emission,
      text,
      accounting,
    };
  }

  const result = await runLoop({
    apiKey,
    model,
    system: built.system,
    userMessage: built.userMessage,
    tools: built.tools,
    dispatchTool: built.dispatchTool,
    context: built.context,
    maxIterations: built.maxIterations,
    budgetUsd: built.budgetUsd,
    perCallMaxTokens: built.perCallMaxTokens,
    thinkingLevel: built.thinkingLevel ?? "medium",
    temperature: built.temperature,
  });
  const emission = terminalEmission(result, built.terminalTool);
  return {
    model,
    mode: "loop",
    finish: classifyFinish(result.stop_reason, emission != null),
    turns: result.turns,
    tool_sequence: result.tool_calls.map((t) => t.name),
    tool_calls: result.tool_calls,
    emission,
    final_text: result.final_text,
    accounting: result.accounting,
  };
}

function describeBuild(built) {
  return {
    mode: built.mode,
    terminal_tool: built.terminalTool ?? null,
    tool_names: built.toolNames ?? null,
    prompt_provenance: built.promptProvenance ?? null,
    system_chars: (built.system || "").length,
    user_chars:
      typeof built.userMessage === "string"
        ? built.userMessage.length
        : JSON.stringify(built.userMessage ?? built.contents ?? "").length,
    input_notes: built.notes ?? null,
  };
}

function writeArtifact(lane, opts, results, startedAt) {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `${lane.name}__${opts.model}__${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        lane: lane.name,
        summary: lane.summary,
        incumbent_model: lane.incumbentModel,
        candidate_model: opts.model,
        candidate_rates: safeRates(opts.model),
        incumbent_rates: safeRates(lane.incumbentModel),
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        options: opts,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

function safeRates(model) {
  try {
    return ratesFor(model);
  } catch {
    return null;
  }
}

/** Print the human-readable report. This is the ticket's Done bar. */
export function report(run) {
  const { lane, opts, results, artifact } = run;
  const out = [];
  out.push(diff.heading(`${lane.name} — ${lane.incumbentModel}  vs  ${opts.model}`));
  out.push(diff.dim(`  ${lane.summary}`));
  out.push("");

  for (const r of results) {
    out.push(diff.rule(r.case.label));

    if (r.skipped === "dry-run") {
      out.push(diff.kv(Object.entries(r.built).map(([k, v]) => [k, JSON.stringify(v)])));
      out.push("");
      continue;
    }

    if (r.built.prompt_provenance) {
      const p = Object.entries(r.built.prompt_provenance).map(([k, v]) => [k, `v${v.version} (${v.chars} chars)`]);
      out.push(diff.dim("  prompts (live from DIM_LLM_PROMPT):"));
      out.push(diff.kv(p, "    "));
      out.push("");
    }

    if (r.candidate?.error) {
      out.push(diff.bad(`  candidate call FAILED: ${r.candidate.error}`));
      out.push("");
      continue;
    }

    // A lane that declares requiresRerun has no usable stored incumbent —
    // it is grounded, so the ledger row was produced against a different
    // day's web. Its left column must be the re-run, or the diff compares
    // the candidate against nothing. CRMA-730 hit this and worked around it
    // by reading artifacts by hand.
    const left =
      lane.requiresRerun && r.incumbentRerun && !r.incumbentRerun.error
        ? r.incumbentRerun
        : r.case.incumbent;
    const rows = lane.compareRows(left, r.candidate, r);
    out.push(
      diff.sideBySide({
        leftLabel: `INCUMBENT — ${lane.incumbentModel}${r.case.incumbentAt ? ` (${r.case.incumbentAt})` : ""}`,
        rightLabel: `CANDIDATE — ${opts.model} (now)`,
        rows,
      }),
    );

    if (r.fields) {
      const f = r.fields;
      out.push(diff.dim("  schema coverage (CRMA-727 H8 — measured, not assumed):"));
      out.push(
        diff.kv(
          [
            ["declared leaf paths", f.candidate.declared_count],
            ["incumbent populated", `${f.incumbent.present_count} (${f.incumbent.coverage_pct}%)`],
            ["candidate populated", `${f.candidate.present_count} (${f.candidate.coverage_pct}%)`],
            [
              "fields lost",
              f.fields_lost.length ? diff.bad(f.fields_lost.join(", ")) : diff.ok("none"),
            ],
            ["fields gained", f.fields_gained.length ? f.fields_gained.join(", ") : "none"],
            [
              "missing required",
              f.candidate.missing_required.length
                ? diff.bad(f.candidate.missing_required.join(", "))
                : diff.ok("none"),
            ],
            [
              "undeclared survived",
              f.candidate.undeclared_survived.length
                ? f.candidate.undeclared_survived.join(", ")
                : "none",
            ],
          ],
          "    ",
        ),
      );
      out.push("");
    }

    if (r.descriptor && !r.descriptor.skipped) {
      out.push(diff.dim("  descriptor neighbours (ADR-0003 method, CRMA-728 axis):"));
      if (r.descriptor.error) {
        out.push(diff.bad(`    ${r.descriptor.error}`));
      } else {
        out.push(
          diff.sideBySide({
            leftLabel: "incumbent statement → nearest trends",
            rightLabel: "candidate statement → nearest trends",
            rows: [
              {
                field: `top-${r.descriptor.incumbent.length || r.descriptor.candidate.length} neighbours`,
                left: formatNeighbors(r.descriptor.incumbent),
                right: formatNeighbors(r.descriptor.candidate),
              },
            ],
          }),
        );
        const m = r.descriptor.metrics || {};
        out.push(
          diff.kv(
            [
              ["identical #1", m.identical_top_1 === true ? diff.ok("yes") : diff.warn("no")],
              ["neighbour overlap", m.overlap_pct != null ? `${m.overlap_count} of ${r.descriptor.incumbent.length} (${m.overlap_pct}%)` : "—"],
              ["mean cosine", `${m.mean_top_k_cosine_incumbent ?? "—"}  →  ${m.mean_top_k_cosine_candidate ?? "—"}`],
              ["scratch rows", `${r.descriptor.rows_written} → ${r.descriptor.scratch_table}`],
            ],
            "    ",
          ),
        );
        out.push(
          diff.dim(
            "    ADR-0003 caution: a LOWER mean cosine is not automatically a regression — the legacy\n" +
              "    multi-field doc inflated similarity via shared boilerplate. Judge overlap and identical-#1.",
          ),
        );
      }
      out.push("");
    }

    const acc = r.candidate?.accounting;
    if (acc) {
      out.push(diff.dim("  accounting:"));
      const pairs = [
        ["turns", r.candidate.turns ?? "—"],
        ["stop", r.candidate.finish?.ok ? diff.ok(r.candidate.finish.reason) : diff.bad(`${r.candidate.finish?.reason} (no emission)`)],
        ["input tokens", acc.input_tokens],
        ["output tokens", acc.candidates_tokens],
        ["thinking tokens", acc.thoughts_tokens],
        ["cost as deployed", `$${Number(acc.cost_as_deployed).toFixed(4)}`],
        ["cost with thinking", `$${Number(acc.cost_with_thinking).toFixed(4)}`],
        ["understated by", diff.warn(`$${Number(acc.understated_by).toFixed(4)}`)],
      ];
      if (acc.reconciles) pairs.push(["token reconciliation", [].concat(acc.reconciles).join(", ")]);
      if (r.candidate.tool_sequence) pairs.push(["tool sequence", r.candidate.tool_sequence.join(" → ") || "—"]);
      out.push(diff.kv(pairs, "    "));
      out.push("");
    }

    if (r.incumbentRerun && !r.incumbentRerun.error) {
      out.push(
        diff.dim(
          `  incumbent re-run today: stop=${r.incumbentRerun.finish?.reason} ` +
            `cost=$${Number(r.incumbentRerun.accounting?.cost_with_thinking ?? 0).toFixed(4)} ` +
            `— use this to separate a model change from a world change.`,
        ),
      );
      out.push("");
    }
  }

  out.push(diff.rule("verdict is yours"));
  out.push(diff.dim(`  This harness does not score a lane. It shows the diff; the lane ticket decides.`));
  out.push(diff.dim(`  Full run artifact: ${artifact}`));
  return out.join("\n");
}
