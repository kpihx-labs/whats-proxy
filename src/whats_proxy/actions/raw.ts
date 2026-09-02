/**
 * whats-proxy — Raw Baileys and Store API escape hatch.
 *
 * Exposes the live Baileys runtime and SQLite Store without action wrappers.
 * This is intentionally unrestricted; the central policy requires HITL.
 */

import * as baileys from "@whiskeysockets/baileys";
import { okResult, errResult } from "../helpers.ts";
import { rawSchema } from "./schemas.ts";
import type { ActionDef } from "./types.ts";

/** Decode JSON-safe binary payloads before passing them to Baileys. */
export function decodeRawValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeRawValue);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.$base64 === "string" && Object.keys(record).length === 1) {
    return Buffer.from(record.$base64, "base64");
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeRawValue(item)]));
}

function resolvePath(root: object, path: string): { receiver: object; value: unknown } | null {
  let receiver: object = root;
  let value: unknown = root;
  for (const segment of path.split(".")) {
    if (!segment) return null;
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    receiver = value as object;
    value = (value as Record<string, unknown>)[segment];
  }
  return { receiver, value };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

/** Convert arbitrary Baileys/Store results into envelope-safe JSON values. */
export async function serializeRawValue(value: unknown, seen = new WeakSet<object>()): Promise<unknown> {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $base64: Buffer.from(value).toString("base64") };
  }
  if (isAsyncIterable(value)) {
    const chunks: Buffer[] = [];
    for await (const chunk of value) chunks.push(Buffer.from(chunk as Uint8Array));
    return { $base64: Buffer.concat(chunks).toString("base64") };
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => serializeRawValue(item, seen)));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [key, await serializeRawValue(item, seen)]),
  );
  return Object.fromEntries(entries);
}

const raw: ActionDef[] = [
  {
    meta: {
      action: "raw",
      category: "raw",
      description: "Invoke unrestricted Baileys or local Store operations without action wrappers. Every execution requires HITL approval.",
      arguments: [
        { name: "protocol", description: "Raw surface: baileys or store.", required: true },
        { name: "target", description: "baileys: socket|module; store: method|sql.", required: false },
        { name: "method", description: "Callable method path for socket, module, or store targets.", required: false },
        { name: "args", description: "Positional JSON arguments for callable targets. Use {\"$base64\":\"...\"} for binary values.", required: false },
        { name: "invoke", description: "baileys/module only: call (default) or construct.", required: false },
        { name: "sql", description: "One arbitrary SQLite statement for store/sql.", required: false },
        { name: "params", description: "Positional SQLite parameters for store/sql.", required: false },
      ],
      example: { protocol: "baileys", target: "socket", method: "sendMessage", args: ["33612345678@s.whatsapp.net", { text: "Raw API call" }] },
      returns: "{ protocol, target, method|sql, result } with binary or stream values represented as { $base64 }",
    },
    handler: async ({ protocol, target, method, args, invoke, sql, params }, { sock, store }) => {
      const protocolName = String(protocol);
      const targetName = String(target || (protocolName === "baileys" ? "socket" : "method"));
      const decodedArgs = Array.isArray(args) ? args.map(decodeRawValue) : [];
      try {
        if (protocolName === "baileys") {
          if (targetName !== "socket" && targetName !== "module") {
            return errResult(`Invalid bailey target: ${targetName}. Use socket or module.`, { protocol: protocolName, target: targetName });
          }
          const methodName = String(method || "");
          const root = targetName === "socket" ? sock : baileys;
          const resolved = resolvePath(root, methodName);
          if (!resolved || typeof resolved.value !== "function") {
            return errResult(`Baileys ${targetName} method is unavailable or not callable: ${methodName}.`, { protocol: protocolName, target: targetName, method: methodName });
          }
          const result = invoke === "construct"
            ? Reflect.construct(resolved.value as new (...input: unknown[]) => object, decodedArgs)
            : await (resolved.value as (...input: unknown[]) => unknown).apply(resolved.receiver, decodedArgs);
          return okResult({ protocol: protocolName, target: targetName, method: methodName, result: await serializeRawValue(result) });
        }

        if (protocolName === "store") {
          if (targetName === "sql") {
            if (typeof sql !== "string" || !sql.trim()) {
              return errResult("store/sql requires a non-empty sql statement.", { protocol: protocolName, target: targetName });
            }
            const result = store.rawSql(sql, Array.isArray(params) ? params.map(decodeRawValue) : []);
            return okResult({ protocol: protocolName, target: targetName, sql, result: await serializeRawValue(result) });
          }
          if (targetName !== "method") {
            return errResult(`Invalid store target: ${targetName}. Use method or sql.`, { protocol: protocolName, target: targetName });
          }
          const methodName = String(method || "");
          const resolved = resolvePath(store, methodName);
          if (!resolved || typeof resolved.value !== "function") {
            return errResult(`Store method is unavailable or not callable: ${methodName}.`, { protocol: protocolName, target: targetName, method: methodName });
          }
          const result = await (resolved.value as (...input: unknown[]) => unknown).apply(resolved.receiver, decodedArgs);
          return okResult({ protocol: protocolName, target: targetName, method: methodName, result: await serializeRawValue(result) });
        }

        return errResult(`Unknown raw protocol: ${protocolName}. Use baileys or store.`, { protocol: protocolName });
      } catch (error) {
        return errResult(`Raw ${protocolName} call failed: ${error instanceof Error ? error.message : String(error)}.`, {
          protocol: protocolName,
          target: targetName,
          method: method ? String(method) : null,
          error: await serializeRawValue(error),
        });
      }
    },
    schema: rawSchema,
    docstring: `Invoke one unrestricted atomic Baileys or Store operation without action wrappers.

Every raw call always requires browser HITL approval. The agent composes unlimited successive raw calls and uses its normal shell for files and result transformation. There is no do, filesystem, runtime, or flow protocol.

Parameters:
    - protocol (required): baileys or store.
    - target (optional): baileys → socket (default) or module; store → method (default) or sql.
    - method (conditional): Callable method path for socket/module/store method targets. Dotted paths are supported.
    - args (optional): Positional JSON arguments. Encode binary data as {"$base64":"..."}; it is decoded to a Buffer before the call.
    - invoke (optional): baileys/module → call (default) or construct.
    - sql (conditional): One arbitrary SQLite statement for store/sql.
    - params (optional): Positional parameters for store/sql.

Examples:
    - Send text through any live socket method:
        \`whats-proxy do raw '{"protocol":"baileys","target":"socket","method":"sendMessage","args":["33612345678@s.whatsapp.net",{"text":"Raw API call"}]}'\`
    - Call an arbitrary Baileys module helper:
        \`whats-proxy do raw '{"protocol":"baileys","target":"module","method":"jidDecode","args":["33612345678@s.whatsapp.net"]}'\`
    - Read local messages directly from Store:
        \`whats-proxy do raw '{"protocol":"store","target":"method","method":"getMessages","args":["120363000000000@g.us",50]}'\`
    - Query SQLite directly:
        \`whats-proxy do raw '{"protocol":"store","target":"sql","sql":"SELECT id, timestamp FROM messages WHERE remoteJid = ? ORDER BY timestamp DESC LIMIT ?","params":["120363000000000@g.us",20]}'\`
    → {"protocol":"store","target":"method","method":"getMessages","result":[...]}`,
  },
];

export default raw;
