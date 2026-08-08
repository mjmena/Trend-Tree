#!/usr/bin/env node
// PROTOTYPE (CRMA-438) — local enrichment loop CLI. Mirrors the Pipedream
// workflow order (normalize → prefetch → agent loop → name reviewer) minus
// the write-side steps (tag_signals, respond) — production stays untouched.
//
//   node src/run.mjs <trend_id> [--capture|--fixture] [--dry-run]
//                    [--skip-reviewer] [--budget <usd>] [--max-iter <n>]

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prefetchLive, saveFixture, loadFixture } from "./prefetch.mjs";
import { normalizeSourceMetricsPool, normalizeNeighborPool, buildPrompts } from "./lib/context.mjs";
import { runAgentLoop, LOOP_DEFAULTS } from "./lib/gemini_loop.mjs";
import { EAGER_TOOL_NAMES } from "./lib/tool_catalog.mjs";
import { runNameReviewer } from "./lib/reviewer.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Same shared tool-workflow endpoints prod uses (enrichment-p_xMC995w/workflow.yaml).
const ENDPOINTS = {
  ingest_search_bluesky: process.env.BLUESKY_TOOL_URL || "https://eoydyalz1dslfre.m.pipedream.net",
  ingest_search_gdelt: process.env.GDELT_TOOL_URL || "https://eoovhehfk229jrg.m.pipedream.net",
  ingest_search_google_trends: process.env.GTRENDS_TOOL_URL || "https://eov9u8rngcgi2z6.m.pipedream.net",
  ingest_grok_live_search: process.env.GROK_TOOL_URL || "https://eovzc5ljf76h3h6.m.pipedream.net",
};

const log = (msg) => process.stderr.write(msg + "\n");

function parseArgs(argv) {
  const args = { flags: new Set(), opts: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budget" || a === "--max-iter") args.opts[a.slice(2)] = Number(argv[++i]);
    else if (a.startsWith("--")) args.flags.add(a.slice(2));
    else rest.push(a);
  }
  args.trend_id = rest[0];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.trend_id) {
    log("usage: node src/run.mjs <trend_id> [--capture|--fixture] [--dry-run] [--skip-reviewer] [--budget <usd>] [--max-iter <n>]");
    process.exit(2);
  }
  const t0 = Date.now();
  const phase = (name, ms) => log(`⏱  ${name}: ${(ms / 1000).toFixed(1)}s`);

  // ── normalize_event equivalent ─────────────────────────────────────
  const trend_id = args.trend_id;
  const agent_session_id = "proto-sess-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const chain_id = "proto-chain-" + Math.random().toString(36).slice(2, 10);
  log(`local enrichment: trend=${trend_id} session=${agent_session_id} mode=${args.flags.has("fixture") ? "fixture" : "live"}`);

  // ── prefetch (q_metrics … q_prompts) ───────────────────────────────
  const tPre = Date.now();
  let pre;
  if (args.flags.has("fixture")) {
    pre = await loadFixture(trend_id);
    log(`  fixture loaded (${Object.keys(pre).join(", ")})`);
  } else {
    pre = await prefetchLive(trend_id, { log });
    if (args.flags.has("capture")) {
      const p = await saveFixture(trend_id, pre);
      log(`  fixture captured → ${p}`);
    }
  }
  phase("prefetch", Date.now() - tPre);

  const metricsRow = (pre.q_metrics || [])[0];
  if (!metricsRow) throw new Error(`no FCT_TRENDS row for trend_id ${trend_id}`);

  const source_metrics_pool = normalizeSourceMetricsPool(pre.q_source_metrics);
  const trend_neighbor_pool = normalizeNeighborPool(pre.q_neighbors);

  const { renderedSystem, renderedUser, systemPrompt, namingGuidance } = buildPrompts({
    prompts_rows: pre.q_prompts,
    metricsRow,
    trend_id,
    signal_rows: pre.q_signals,
    source_metrics_pool,
    trend_neighbor_pool,
  });
  log(`prompts: enrichment.agent.system v${systemPrompt.version} + naming_guidance v${namingGuidance.version}`);

  if (args.flags.has("dry-run")) {
    log("dry-run: prompts built, skipping LLM");
    console.log(JSON.stringify({ trend_id, dry_run: true, system_chars: renderedSystem.length, user_chars: renderedUser.length }, null, 2));
    phase("total", Date.now() - t0);
    return;
  }

  // ── agent loop (Gemini 3.1 Pro) ────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const context = {
    source_metrics_pool,
    trend_neighbor_pool,
    proposed_enrichment: null,
    agent_session_id,
    chain_id,
    iteration: 1,
    endpoints: ENDPOINTS,
  };

  const tLoop = Date.now();
  const result = await runAgentLoop({
    api_key: process.env.GEMINI_API_KEY,
    tool_names: EAGER_TOOL_NAMES,
    system: renderedSystem,
    user_message: renderedUser,
    context,
    max_iterations: args.opts["max-iter"] || systemPrompt.params.max_iterations || LOOP_DEFAULTS.max_iterations,
    budget_usd: args.opts.budget || systemPrompt.params.budget_usd || LOOP_DEFAULTS.budget_usd,
    per_call_max_tokens: systemPrompt.params.per_call_max_tokens || LOOP_DEFAULTS.per_call_max_tokens,
    thinking_level: systemPrompt.params.thinking_level || LOOP_DEFAULTS.thinking_level,
    log,
  });
  phase("agent_loop", Date.now() - tLoop);
  log(`agent: turns=${result.turns} cost=$${result.cost_usd.toFixed(4)} stop=${result.stop_reason} emitted=${!!context.proposed_enrichment}`);

  const agent_output = {
    gated: false,
    enrichment_output: context.proposed_enrichment,
    trend_id,
    chain_id,
    agent_session_id,
    tokens: result.tokens,
    cost_usd: result.cost_usd,
    turns: result.turns,
    stop_reason: result.stop_reason,
  };

  // ── name reviewer (Sonnet 4.6) ─────────────────────────────────────
  let reviewer_output = { skipped: true, reason: "skip_reviewer_flag" };
  if (!args.flags.has("skip-reviewer")) {
    const tRev = Date.now();
    reviewer_output = await runNameReviewer({
      api_key: process.env.ANTHROPIC_API_KEY,
      agent_output,
      metrics_rows: pre.q_metrics,
      prompts_rows: pre.q_prompts,
      log,
    });
    phase("name_reviewer", Date.now() - tRev);
  }

  // ── emit (stdout + out/, no $.respond, no ledger) ──────────────────
  const final = {
    trend_id,
    enrichment_output: agent_output.enrichment_output,
    name_reviewer: reviewer_output,
    agent_telemetry: {
      turns: result.turns,
      stop_reason: result.stop_reason,
      tool_call_count: result.tool_calls.length,
      model: result.model,
    },
    llm_token_usage: { agent: result.tokens, reviewer: reviewer_output.tokens || null },
    llm_cost_estimate: {
      agent_usd: result.cost_usd,
      reviewer_usd: reviewer_output.cost_usd || 0,
      total_usd: Math.round((result.cost_usd + (reviewer_output.cost_usd || 0)) * 10000) / 10000,
    },
  };

  await mkdir(join(ROOT, "out"), { recursive: true });
  const outPath = join(ROOT, "out", `${trend_id}.json`);
  await writeFile(outPath, JSON.stringify({ ...final, tool_calls: result.tool_calls, reasoning_trace: result.reasoning_trace }, null, 2));
  log(`full trace → ${outPath}`);

  console.log(JSON.stringify(final, null, 2));
  phase("total", Date.now() - t0);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
