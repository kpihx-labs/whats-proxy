/**
 * whats-proxy — Documentation / help rendering.
 *
 * Generates `--help` output dynamically from the action registry
 * (JSDoc-style metadata + declared action arguments), following tick-proxy.
 * No hand-maintained help text: every action declares its own doc.
 */

import { policyFor } from "./actions/policies.ts";
import type { ActionDef, ActionExample, ActionRegistry } from "./actions/types.ts";
import type { Output } from "./types.ts";

/**
 * Parse a `returns` string and build a placeholder data object.
 *
 * Handles shapes like:
 *   "{ status, jid, message_id, timestamp }"
 *   "{ status, jid } | { count, blocked }"
 *   "{ jid, subject, description, participants, announce, restrict, ... }"
 *
 * For union types (`|`), uses the first shape. Trailing `...` is dropped.
 * Field names become keys with placeholder values: strings → "...", numbers → 0, booleans → false.
 */
function buildReturnData(returns?: string): Record<string, unknown> | null {
  if (!returns) return null;
  // Take the first shape in union types
  const firstShape = returns.split("|")[0]!.trim();
  // Extract content between { and }
  const match = firstShape.match(/\{([^}]+)\}/);
  if (!match) return null;
  const fields = match[1]!
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f && f !== "...");
  if (fields.length === 0) return null;
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    // Infer placeholder type from field name
    if (field.endsWith("_id") || field.endsWith("_count") || field === "count" || field === "total" || field === "offset" || field === "timestamp" || field === "file_length" || field === "bytes_freed") {
      data[field] = 0;
    } else if (field === "edited" || field === "announce" || field === "restrict" || field === "on_whatsapp" || field.endsWith("_sync")) {
      data[field] = false;
    } else {
      data[field] = "...";
    }
  }
  return data;
}

/**
 * Build a wrapped output envelope example line.
 *
 * Returns a line like:
 *   → {"meta":{"status":"ok","comment":"","edited":false},"data":{...}}
 */
function buildEnvelopeLine(returns?: string): string {
  const data = buildReturnData(returns);
  if (!data) return "";
  const envelope: Output = {
    meta: { status: "ok", comment: "", edited: false },
    data,
  };
  return `→ ${JSON.stringify(envelope)}`;
}

/**
 * Build the canonical executable examples for one action help page.
 *
 * Each action can declare semantic scenarios in `meta.examples`. When it has
 * none, its safe canonical payload expands into three transport forms. This
 * keeps all 65 pages executable without duplicating payloads outside registry
 * metadata, while complex actions document meaningful branches themselves.
 *
 * Args:
 *   definition: Registered action whose declarative metadata is rendered.
 *
 * Returns:
 *   At least three executable command/documentation lines.
 *
 * Examples:
 *   getActionExamples(REGISTRY["send-text"]).length >= 3
 *   // => true
 *   getActionExamples(REGISTRY["chat-list"])[0].includes("chat-list")
 *   // => true
 */
export function getActionExamples(definition: ActionDef): string[] {
  const { action, example = {} } = definition.meta;
  const semanticExamples: ActionExample[] = definition.meta.examples?.length
    ? definition.meta.examples
    : [
      { description: "Inline JSON", payload: example },
      { description: "Payload file", payload: example },
      { description: "Capture JSON", payload: example },
    ];
  const file = `/tmp/${action}.json`;
  const result = `/tmp/${action}-result.json`;
  const canonicalPayload = JSON.stringify(example);
  const examples = semanticExamples.map(({ description, payload }, index) => {
    const encoded = JSON.stringify(payload);
    let command: string;
    if (index === 1 && !definition.meta.examples?.length) {
      command = `${description}: save ${encoded} as ${file}, then run: whats-proxy do ${action} ${file}`;
    } else if (index === 2 && !definition.meta.examples?.length) {
      command = `${description}: whats-proxy do ${action} '${encoded}' -o ${result}`;
    } else {
      command = `${description}: whats-proxy do ${action} '${encoded}'`;
    }
    // Append envelope output line showing what the CLI returns
    const envelope = buildEnvelopeLine(definition.meta.returns);
    return envelope ? `${command}\n   ${envelope}` : command;
  });
  const policy = policyFor(action);
  if (policy) {
    examples.push(`Review path: whats-proxy do ${action} '${canonicalPayload}'  # local HITL opens; rejection or timeout is fail-closed`);
  }
  if (policy?.preflight) {
    examples.push(`Preflight path: use the same target only after it exists in the local Store or remote WhatsApp resource; an unknown destructive target is rejected before HITL.`);
  }
  const required = definition.meta.arguments.filter((argument) => argument.required);
  if (required.length > 0) {
    examples.push(`Validation path: whats-proxy do ${action} '{}'  # rejected before daemon execution: missing ${required.map((argument) => argument.name).join(", ")}`);
  }
  if (!definition.meta.arguments.length) {
    examples.push(`Table display: whats-proxy do ${action} '{}' -f table`);
  }
  return examples;
}

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

/**
 * Render full help for one action: description, arguments, and executable examples.
 *
 * Args:
 *   name: Kebab-case action name selected by the CLI.
 *   registry: Complete action registry used for lookup.
 *
 * Returns:
 *   Formatted help text, or a readable unknown-action error.
 *
 * Examples:
 *   getActionHelp("chat-list", REGISTRY).includes("Examples:")
 *   // => true
 *   getActionHelp("missing", REGISTRY)
 *   // => "Unknown action: missing"
 */
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

  const examples = getActionExamples(def);
  if (examples.length > 0) {
    lines.push("Examples:");
    for (const [index, example] of examples.entries()) {
      lines.push(`  ${index + 1}. ${example}`);
    }
    lines.push("");
  }

  if (meta.returns) {
    lines.push("Returns:");
    lines.push(`  ${meta.returns}`);
    lines.push("");
  }

  // Output envelope format — shows agents what the CLI actually returns
  const envelopeLine = buildEnvelopeLine(meta.returns);
  if (envelopeLine) {
    lines.push("Output envelope (every do action):");
    lines.push(`  ${envelopeLine}`);
    lines.push("");
  }

  return lines.join("\n");
}
