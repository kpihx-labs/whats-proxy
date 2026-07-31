/**
 * whats-proxy — Action system types.
 *
 * Every `do` action is a plain handler `(args, ctx) => data` plus a meta
 * object used for dynamic `--help` (doc.ts). The daemon owns the Baileys
 * socket + Store and dispatches actions; the CLI is a thin JSON-RPC client.
 */

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

/** Static metadata describing an action — powers `--help`. */
export interface ActionMeta {
  action: string;
  category: string;
  description: string;
  arguments: ActionArg[];
  example?: Record<string, unknown>;
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
}

/** Registry: kebab-case action name → definition. */
export type ActionRegistry = Record<string, ActionDef>;
