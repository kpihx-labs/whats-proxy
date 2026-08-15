/**
 * whats-proxy — Display layer.
 *
 * Tick-proxy-standard output rendering without external dependencies:
 * plain ASCII rendering, no colors, no Rich. stdout carries ONLY the JSON
 * envelope (or the rendered table) — nothing else.
 */

import type { Output } from "./types.ts";

/** Print a JSON value to stdout (pretty, 2-space). */
export function print_json(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Format a scalar for table cells. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Print a dict or list-of-dicts as an aligned ASCII table.
 * Lists of scalars render as a single column; dicts as key/value rows.
 */
export function print_table(data: unknown) {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      process.stdout.write("(empty)\n");
      return;
    }
    // List of dicts → column table
    if (data.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      const rows = data as Record<string, unknown>[];
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const matrix: string[][] = [keys.map((k) => String(k))];
      for (const row of rows) {
        matrix.push(keys.map((k) => cell(row[k])));
      }
      renderMatrix(matrix);
      return;
    }
    // List of scalars → single column
    const matrix: string[][] = [["value"], ...data.map((v) => [cell(v)])];
    renderMatrix(matrix);
    return;
  }
  if (data !== null && typeof data === "object") {
    const rows = Object.entries(data as Record<string, unknown>);
    if (rows.length === 0) {
      process.stdout.write("(empty)\n");
      return;
    }
    const matrix: string[][] = [["key", "value"], ...rows.map(([k, v]) => [k, cell(v)])];
    renderMatrix(matrix);
    return;
  }
  process.stdout.write(cell(data) + "\n");
}

function renderMatrix(matrix: string[][]) {
  const widths = matrix[0]!.map((_, col) =>
    Math.max(...matrix.map((row) => row[col]!.length))
  );
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const line = (row: string[]) =>
    "| " + row.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
  process.stdout.write(sep + "\n");
  matrix.forEach((row, i) => {
    process.stdout.write(line(row) + "\n");
    if (i === 0) process.stdout.write(sep + "\n");
  });
  process.stdout.write(sep + "\n");
}

/** Print the full output envelope in table mode: meta block + data table. */
export function output_result(result: Output, format: "json" | "table" = "json") {
  const { meta, data } = result;
  if (format === "table" && (Array.isArray(data) || (data !== null && typeof data === "object"))) {
    process.stdout.write("Meta:\n");
    print_table(meta as unknown as Record<string, unknown>);
    process.stdout.write("Data:\n");
    print_table(data as unknown);
  } else {
    print_json(result);
  }
}

/** Simple stderr diagnostics (never pollute stdout). */
export function print_error(msg: string) {
  process.stderr.write(`[error] ${msg}\n`);
}
