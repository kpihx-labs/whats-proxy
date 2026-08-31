/**
 * whats-proxy — Docstring-based help rendering.
 *
 * Reads a `docstring` field from ActionDef and renders it into compact
 * (catalog overview) and full (per-action --help) help text.
 * The `→` output example lines are auto-wrapped in the meta+data envelope.
 *
 * Port of tick-proxy's `doc.py` — same 3 functions, same regex, same logic.
 */

import type { ActionDef, ActionRegistry } from "./actions/types.ts";

/**
 * Compact help for catalog: everything before the "Examples:" line.
 *
 * Args:
 *   def: Registered action carrying a structured docstring.
 *
 * Returns:
 *   The docstring up to (but not including) the Examples section.
 *
 * Examples:
 *   getCompactHelp({ docstring: "Send a text.\\n\\nParameters:\\n    - jid\\n\\nExamples:\\n    - x" })
 *   // => "Send a text."
 */
export function getCompactHelp(def: ActionDef): string {
  const doc = def.docstring || "";
  const parts = doc.split(/\n\s*Examples:\s*\n/i);
  return parts[0]!.trim();
}

/**
 * Wrap a `→ {json}` example line in the meta+data envelope.
 *
 * Non-JSON example lines are returned untouched.
 *
 * Args:
 *   line: A single docstring line.
 *
 * Returns:
 *   The same line, or the JSON re-rendered inside the envelope.
 *
 * Examples:
 *   wrapOutput('    → {"id": "68f1"}')
 *   // => '    → {"meta":{"status":"ok","comment":"","edited":false},"data":{"id":"68f1"}}'
 *   wrapOutput('    - just prose')
 *   // => '    - just prose'
 */
function wrapOutput(line: string): string {
  const m = line.match(/^( *→\s*)(.*)/);
  if (!m) return line;
  const arrow = m[1]!;
  const content = m[2]!.trim();
  try {
    const data = JSON.parse(content);
    const wrapped = JSON.stringify(
      {
        meta: { status: "ok", comment: "", edited: false },
        data,
      },
      null,
      2,
    );
    return `${arrow}${wrapped}`;
  } catch {
    return line;
  }
}

/**
 * Full help for per-action --help: full docstring with → lines wrapped in envelope.
 *
 * Args:
 *   def: Registered action carrying a structured docstring.
 *
 * Returns:
 *   The docstring, with every JSON example expanded to the real envelope the CLI prints.
 *
 * Examples:
 *   getFullHelp({ docstring: "T.\\n\\nExamples:\\n    → {\\"ok\\": true}" })
 *   // => includes "meta" in the output
 */
export function getFullHelp(def: ActionDef): string {
  const doc = def.docstring || "";
  const wrapped = doc.split("\n").map(wrapOutput).join("\n");
  // Prepend usage line like tick-proxy's Typer does automatically.
  const hasArgs = def.meta.arguments.length > 0;
  const usage = hasArgs
    ? `Usage:\n  whats-proxy do ${def.meta.action} [payload|file] [-o file] [-f json|table] [-a phone]\n`
    : `Usage:\n  whats-proxy do ${def.meta.action} [-f json|table] [-a phone]\n`;
  return usage + "\n" + wrapped;
}

/**
 * Compact catalog help: one line per action grouped by category.
 *
 * Args:
 *   registry: Complete action registry used for lookup.
 *
 * Returns:
 *   Formatted catalog listing.
 *
 * Examples:
 *   getCatalogHelp(REGISTRY).includes("send-text")
 *   // => true
 */
export function getCatalogHelp(registry: ActionRegistry): string {
  const lines: string[] = [];
  const byCategory = new Map<string, string[]>();
  for (const [name, def] of Object.entries(registry)) {
    const cat = def.meta.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(name);
  }
  for (const [cat, names] of [...byCategory.entries()].sort()) {
    lines.push(`\x1b[1;35m── ${cat} ──\x1b[0m`);
    for (const name of names.sort()) {
      const def = registry[name]!;
      lines.push(`\x1b[1;36m${name}\x1b[0m`);
      const compact = getCompactHelp(def);
      if (compact) {
        // Show the FULL compact help (description + parameters), not just the first line.
        // Matches tick-proxy: everything before "Examples:" is visible in the catalog.
        for (const l of compact.split("\n")) {
          lines.push(l);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
