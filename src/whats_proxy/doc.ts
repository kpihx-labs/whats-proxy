/**
 * whats-proxy — Documentation / help rendering.
 *
 * Generates `--help` output dynamically from the action registry
 * (JSDoc-style metadata + zod schemas), mirroring tg-proxy's doc.py.
 * No hand-maintained help text: every action declares its own doc.
 */

import type { ActionDef, ActionRegistry } from "./actions/types.ts";

/** Compact help: one line per action (used by `whats-proxy do --help`). */
export function getCompactHelp(registry: ActionRegistry): string {
  const lines: string[] = [];
  const byCategory = new Map<string, string[]>();
  for (const [name, def] of Object.entries(registry)) {
    const cat = def.meta.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(name);
  }
  for (const [cat, names] of [...byCategory.entries()].sort()) {
    lines.push(`${cat}:`);
    for (const name of names.sort()) {
      lines.push(`  ${name}`);
    }
  }
  return lines.join("\n");
}

/** Full help for one action: description, arguments, example, schema. */
export function getActionHelp(name: string, registry: ActionRegistry): string {
  const def: ActionDef | undefined = registry[name];
  if (!def) return `Unknown action: ${name}`;
  const meta = def.meta;

  const lines: string[] = [];
  lines.push(`Action: ${name}`);
  if (meta.description) lines.push(`  ${meta.description}`);
  lines.push("");
  lines.push(`Usage:`);
  lines.push(`  whats-proxy do ${name} '<json-payload>'`);
  lines.push(`  whats-proxy do ${name} <payload-file.json>`);
  lines.push("");

  if (meta.arguments && meta.arguments.length > 0) {
    lines.push("Arguments:");
    for (const arg of meta.arguments) {
      const required = arg.required ? " (required)" : "";
      lines.push(`  ${arg.name}${required}: ${arg.description}`);
    }
    lines.push("");
  }

  if (meta.example) {
    lines.push("Example:");
    lines.push(`  whats-proxy do ${name} '${JSON.stringify(meta.example)}'`);
    lines.push("");
  }

  if (meta.returns) {
    lines.push("Returns:");
    lines.push(`  ${meta.returns}`);
  }

  return lines.join("\n");
}
