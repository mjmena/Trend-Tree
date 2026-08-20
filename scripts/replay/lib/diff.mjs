// Side-by-side rendering for the terminal.
//
// The ticket's bar is "a human can run one command per lane and read a
// side-by-side diff". This file is that bar. It renders incumbent on the
// left, candidate on the right, field by field, and never truncates a
// difference silently — a clipped cell is marked with an ellipsis so nobody
// reads a truncation as agreement.

const C = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
};

const noColor = process.env.NO_COLOR || !process.stdout.isTTY;
const paint = (s, c) => (noColor ? s : `${c}${s}${C.reset}`);

export function termWidth() {
  return Math.max(80, Math.min(process.stdout.columns || 120, 200));
}

export function rule(title = "") {
  const w = termWidth();
  if (!title) return paint("─".repeat(w), C.dim);
  const head = `── ${title} `;
  return paint(head + "─".repeat(Math.max(0, w - head.length)), C.dim);
}

export function heading(text) {
  return `\n${paint(text, C.bold + C.cyan)}\n`;
}

function wrap(text, width) {
  const lines = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para.length <= width) {
      lines.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
      while (line.length > width) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line.length) lines.push(line);
  }
  return lines.length ? lines : [""];
}

const stringify = (v) =>
  v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v, null, 2);

/**
 * Render a two-column comparison.
 *
 * @param {object} a
 * @param {string} a.leftLabel
 * @param {string} a.rightLabel
 * @param {Array<{field: string, left: any, right: any, note?: string}>} a.rows
 * @param {number} [a.maxCellLines]  Clip very long cells; the clip is marked.
 */
export function sideBySide({ leftLabel, rightLabel, rows, maxCellLines = 14 }) {
  const w = termWidth();
  const gutter = 3;
  const col = Math.floor((w - gutter) / 2);
  const out = [];

  out.push(
    paint(leftLabel.padEnd(col).slice(0, col), C.bold) +
      paint(" │ ", C.dim) +
      paint(rightLabel.padEnd(col).slice(0, col), C.bold),
  );
  out.push(paint("─".repeat(col) + "─┼─" + "─".repeat(col), C.dim));

  for (const row of rows) {
    const same = stringify(row.left) === stringify(row.right);
    const label = same ? paint(`  ${row.field}`, C.dim) : paint(`▶ ${row.field}`, C.yellow + C.bold);
    out.push(label + (row.note ? paint(`  ${row.note}`, C.dim) : ""));

    let l = wrap(stringify(row.left), col);
    let r = wrap(stringify(row.right), col);
    let clipped = false;
    if (l.length > maxCellLines) {
      l = l.slice(0, maxCellLines);
      clipped = true;
    }
    if (r.length > maxCellLines) {
      r = r.slice(0, maxCellLines);
      clipped = true;
    }
    const h = Math.max(l.length, r.length);
    for (let i = 0; i < h; i++) {
      const lc = (l[i] ?? "").padEnd(col).slice(0, col);
      const rc = (r[i] ?? "").padEnd(col).slice(0, col);
      const tint = same ? C.dim : C.reset;
      out.push(paint(lc, tint) + paint(" │ ", C.dim) + paint(rc, tint));
    }
    if (clipped) out.push(paint(`  … cell clipped at ${maxCellLines} lines — full text in the run artifact`, C.dim));
    out.push("");
  }
  return out.join("\n");
}

/** A compact key/value block, for accounting and provenance. */
export function kv(pairs, indent = "  ") {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs
    .map(([k, v, tint]) => `${indent}${paint(k.padEnd(width), C.dim)}  ${tint ? paint(String(v), tint) : v}`)
    .join("\n");
}

export const colors = C;
export const ok = (s) => paint(s, C.green);
export const bad = (s) => paint(s, C.red);
export const warn = (s) => paint(s, C.yellow);
export const dim = (s) => paint(s, C.dim);

/** Cost/latency comparison line, shared by every lane. */
export function accountingRows(incumbent, candidate) {
  const rows = [];
  const push = (label, a, b, fmt = (x) => x) => rows.push([label, `${fmt(a)}  →  ${fmt(b)}`]);
  push("input tokens", incumbent?.input_tokens ?? "—", candidate?.input_tokens ?? "—");
  push("output tokens", incumbent?.candidates_tokens ?? "—", candidate?.candidates_tokens ?? "—");
  push("thinking tokens", incumbent?.thoughts_tokens ?? "—", candidate?.thoughts_tokens ?? "—");
  push("cost (truthful)", incumbent?.cost_with_thinking ?? "—", candidate?.cost_with_thinking ?? "—", (x) =>
    typeof x === "number" ? `$${x.toFixed(4)}` : x,
  );
  return rows;
}
