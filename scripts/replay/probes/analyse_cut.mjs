// CRMA-757 — where exactly does the answer get cut?
//
// The matrix showed every 3.7 Flash arm truncating at 20-30%, and the
// surviving text almost always resumes at the SAME structural place: the
// tail of the first object's why_now, right before "vertical". That
// consistency is the finding. Two explanations survive it, and they imply
// completely different fixes:
//
//   FIXED-PREFIX  a constant number of leading bytes never arrives. The cut
//                 lands at a consistent place only because the first object
//                 serialises to a fairly consistent length.
//                 -> a sacrificial preamble absorbs the loss.
//
//   FIRST-ELEMENT the first array element is dropped as a unit.
//                 -> no preamble helps; the first real proposal always dies.
//
// This script measures the clean runs to size the first element, which is
// what tells the two apart and sizes the padding for the next probe.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dirname, "out");
const file =
  process.argv[2] ||
  join(
    outDir,
    readdirSync(outDir).filter((f) => f.startsWith("truncation-matrix")).sort().pop(),
  );
const data = JSON.parse(readFileSync(file, "utf8"));

console.log(`# analysing ${file}\n`);

const good = data.results.filter((r) => r.ok);
const clean = good.filter((r) => r.head_ok);
const trunc = good.filter((r) => !r.head_ok);

// How long is a serialised first element on the clean runs? We only kept the
// first 120 chars of each body, so size it from the recovered/direct item
// counts and total body length instead.
const cleanBy = {};
for (const r of clean) (cleanBy[r.shape] ||= []).push(r);
const truncBy = {};
for (const r of trunc) (truncBy[r.shape] ||= []).push(r);

console.log("shape\tclean_n\tclean_chars_mean\tclean_items_mean\tchars_per_item\ttrunc_n\ttrunc_chars_mean\tdelta_chars");
for (const shape of Object.keys(data.shapes)) {
  const c = cleanBy[shape] || [];
  const t = truncBy[shape] || [];
  const cChars = c.length ? c.reduce((a, r) => a + r.body_chars, 0) / c.length : 0;
  const cItems = c.length ? c.reduce((a, r) => a + (r.direct_items || 0), 0) / c.length : 0;
  const tChars = t.length ? t.reduce((a, r) => a + r.body_chars, 0) / t.length : 0;
  const perItem = cItems ? cChars / cItems : 0;
  console.log(
    [
      shape,
      c.length,
      Math.round(cChars),
      cItems.toFixed(1),
      Math.round(perItem),
      t.length,
      Math.round(tChars),
      c.length && t.length ? Math.round(cChars - tChars) : "-",
    ].join("\t"),
  );
}

// The decisive comparison: on a truncated run, how many items came back
// versus how many a clean run of the same shape produces? If the answer is
// consistently "one fewer", the loss is one ELEMENT, not a byte window.
console.log("\n# items: clean vs truncated (same shape)");
console.log("shape\tclean_items\ttrunc_recovered\tdiff");
for (const shape of Object.keys(data.shapes)) {
  const c = cleanBy[shape] || [];
  const t = truncBy[shape] || [];
  if (!c.length || !t.length) continue;
  const cItems = c.reduce((a, r) => a + (r.direct_items || 0), 0) / c.length;
  const tItems = t.reduce((a, r) => a + (r.recovered_items || 0), 0) / t.length;
  console.log(`${shape}\t${cItems.toFixed(2)}\t${tItems.toFixed(2)}\t${(cItems - tItems).toFixed(2)}`);
}

// Does the cut always land at the same structural token?
console.log("\n# cut signature (what the surviving text starts with)");
const sigs = {};
for (const r of trunc) {
  const sig = r.head_120.slice(0, 30);
  const key = /^\.",\s*\n\s*"vertical"/.test(r.head_120)
    ? "tail-of-why_now, then \"vertical\""
    : "OTHER";
  sigs[key] = (sigs[key] || 0) + 1;
  if (key === "OTHER") console.log(`  OTHER: ${JSON.stringify(sig)}`);
}
console.log(`  ${JSON.stringify(sigs)}`);

console.log(`\n# totals: ${good.length} calls, ${clean.length} clean, ${trunc.length} truncated (${((trunc.length / good.length) * 100).toFixed(1)}%)`);
const flash = good.filter((r) => r.model === "gemini-3.7-flash");
const flashTrunc = flash.filter((r) => !r.head_ok);
console.log(`# gemini-3.7-flash only: ${flash.length} calls, ${flashTrunc.length} truncated (${((flashTrunc.length / flash.length) * 100).toFixed(1)}%)`);
