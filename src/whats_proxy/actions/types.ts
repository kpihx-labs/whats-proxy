/**
 * whats-proxy — Action system types.
 *
 * Every `do` action is a plain handler `(args, ctx) => data` plus a meta
 * object used for dynamic `--help` (doc.ts). The daemon owns the Baileys
 * socket + Store and dispatches actions; the CLI is a thin JSON-RPC client.
 */

import { z } from "zod";
import type { WASocket } from "@whiskeysockets/baileys";
import type { Store } from "../store.ts";
import type { AppConfig } from "../config.ts";
import type { ConnectionInfo, Output } from "../types.ts";

/** Declarative schema for one argument (used for help + validation). */
export interface ActionArg {
  name: string;
  description: string;
  required: boolean;
  type?: string;
}

/** One concrete action-owned help scenario, rendered as an executable command. */
export interface ActionExample {
  /** What the scenario proves or changes. */
  description: string;
  /** Valid JSON payload for this exact scenario. */
  payload: Record<string, unknown>;
}

/** Static metadata describing an action — powers `--help`. */
export interface ActionMeta {
  action: string;
  category: string;
  description: string;
  arguments: ActionArg[];
  example?: Record<string, unknown>;
  /** Extra semantic scenarios for complex action families. */
  examples?: ActionExample[];
  returns?: string;
}

/** Runtime context handed to every action handler (owned by the daemon). */
export interface ActionContext {
  sock: WASocket;
  store: Store;
  config: AppConfig;
  connectionInfo: () => ConnectionInfo;
  /** Full action registry (used by `guide`). */
  registry: ActionRegistry;
}

/** Action handler: raw args in (already JSON-decoded), full Output envelope out. */
export type ActionHandler = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => Output | Promise<Output>;

export interface ActionDef {
  meta: ActionMeta;
  handler: ActionHandler;
  /** Optional Zod schema for payload validation (safety net, never breaks existing functionality). */
  schema?: z.ZodObject<Record<string, z.ZodTypeAny>>;
  /**
   * Full docstring (replaces meta.description, meta.arguments, meta.examples for help rendering).
   * Format: description + optional Parameters/Examples sections with → output lines.
   */
  docstring?: string;
}

/** Registry: kebab-case action name → definition. */
export type ActionRegistry = Record<string, ActionDef>;

/**
 * Validate universally declared required arguments before an action can review or execute.
 *
 * Args:
 *   definition: Registered action whose declarative argument schema is checked.
 *   args: Decoded JSON payload supplied by the CLI client.
 *
 * Returns:
 *   A readable validation error, or null when every required argument is present.
 *
 * Examples:
 *   validateRequiredArguments(definition, { jid: "33600000000", text: "Hello" })
 *   // => null
 *   validateRequiredArguments(definition, { jid: "33600000000" })
 *   // => "Missing required argument(s) for send-text: text."
 */
export function validateRequiredArguments(definition: ActionDef, args: Record<string, unknown>): string | null {
  const missing = definition.meta.arguments
    .filter((argument) => argument.required && (args[argument.name] === undefined || args[argument.name] === null || args[argument.name] === ""))
    .map((argument) => argument.name);
  return missing.length === 0 ? null : `Missing required argument(s) for ${definition.meta.action}: ${missing.join(", ")}.`;
}
