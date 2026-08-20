#!/usr/bin/env node
// Offline replay harness — per-lane model comparison (CRMA-729).
//
// One command per lane, one side-by-side diff:
//
//   node scripts/replay/replay.mjs enrichment --model gemini-3.7-flash --limit 3
//
// This is an INSTRUMENT, not a deliverable. It exists so the nine lane
// decisions under CRMA-726 rest on evidence instead of on Google's marketing
// copy, and it deliberately does NOT score a lane or recommend a switch —
// it shows the diff and leaves the verdict to the lane ticket.

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLane, report } from "./lib/runner.mjs";
import * as diff from "./lib/diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANES_DIR = join(HERE, "lanes");

const DEFAULT_CANDIDATE = "gemini-3.7-flash";

function availableLanes() {
  return readdirSync(LANES_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
}

function parseArgs(argv) {
  const [laneName, ...rest] = argv;
  const opts = {
    model: DEFAULT_CANDIDATE,
    limit: 3,
    rerunIncumbent: false,
    caseId: null,
    dryRun: false,
    json: false,
    descriptorNeighbors: false,
    neighborK: 3,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    switch (a) {
      case "--model": opts.model = next(); break;
      case "--limit": opts.limit = Number(next()); break;
      case "--case": opts.caseId = next(); break;
      case "--rerun-incumbent": opts.rerunIncumbent = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--descriptor-neighbors": opts.descriptorNeighbors = true; break;
      case "--neighbor-k": opts.neighborK = Number(next()); break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }
  return { laneName, opts };
}

function usage() {
  const lanes = availableLanes();
  return `
${diff.colors.bold}Offline replay harness — per-lane model comparison${diff.colors.reset}

  node scripts/replay/replay.mjs <lane> [options]

${diff.dim("Lanes")}
${lanes.map((l) => `  ${l}`).join("\n")}

${diff.dim("Options")}
  --model <id>          Candidate model (default: ${DEFAULT_CANDIDATE})
  --limit <n>           Historical cases to replay (default: 3)
  --case <id>           Replay one specific case id
  --rerun-incumbent     Also fire the incumbent model today, to separate
                        a model change from a world change
  --dry-run             Assemble inputs and print them; make no model calls
  --descriptor-neighbors
                        Embed the candidate's descriptor.statement, compare its
                        nearest trends against the incumbent's, and write the
                        comparison to a SCRATCH table (never a ledger).
                        Enrichment only. This is the CRMA-728 axis.
  --neighbor-k <n>      Neighbours per side for the axis above (default: 3)
  --json                Print the raw artifact path only

${diff.dim("Examples")}
  node scripts/replay/replay.mjs enrichment --model gemini-3.7-flash --limit 3
  node scripts/replay/replay.mjs enrichment --dry-run --limit 1
  node scripts/replay/replay.mjs audit --model gemini-3.7-flash --rerun-incumbent
  node scripts/replay/replay.mjs enrichment --descriptor-neighbors --limit 2

${diff.dim("Requires")}
  snow CLI on connection '${process.env.SNOW_CONNECTION || "claude"}' (read-only here)
  A Gemini key in the macOS keychain as 'gemini-api', or GEMINI_API_KEY
`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    process.exit(0);
  }

  let laneName, opts;
  try {
    ({ laneName, opts } = parseArgs(argv));
  } catch (e) {
    console.error(diff.bad(e.message));
    console.log(usage());
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    process.exit(0);
  }

  const lanes = availableLanes();
  if (!lanes.includes(laneName)) {
    console.error(diff.bad(`Unknown lane '${laneName}'.`));
    console.error(`Available: ${lanes.join(", ")}`);
    process.exit(2);
  }

  const mod = await import(pathToFileURL(join(LANES_DIR, `${laneName}.mjs`)).href);
  const lane = mod.default ?? mod;

  process.stderr.write(
    diff.dim(
      `\n  lane=${lane.name}  incumbent=${lane.incumbentModel}  candidate=${opts.model}  ` +
        `cases=${opts.limit}${opts.dryRun ? "  (dry run)" : ""}\n`,
    ),
  );

  const run = await runLane(lane, opts);
  if (opts.json) {
    console.log(run.artifact);
    return;
  }
  console.log(report(run));
}

main().catch((e) => {
  console.error(`\n${diff.bad("replay failed:")} ${e.message}\n`);
  if (process.env.REPLAY_DEBUG) console.error(e.stack);
  process.exit(1);
});
