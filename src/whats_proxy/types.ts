/**
 * whats-proxy — Shared types.
 *
 * The Output envelope is the single contract of every `do` and `admin`
 * command: `{ meta, data }`. Mirrors tg-proxy's OutputMeta/Output model.
 */

export type OutputStatus = "ok" | "approved" | "rejected" | "error";

export interface OutputMeta {
  status: OutputStatus;
  comment: string;
  edited: boolean;
}

export interface Output {
  meta: OutputMeta;
  data: Record<string, unknown>;
}

/** Connection states of the Baileys socket (mirrors whats-mcp connection.js). */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "open"
  | "closing";

export interface ConnectionInfo {
  state: ConnectionState;
  user: {
    id: string;
    name?: string;
    phone?: string;
  } | null;
  store_stats: {
    chats: number;
    contacts: number;
    messages: number;
    groups: number;
  } | null;
  reconnect_attempts: number;
}
