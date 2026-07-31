/**
 * whats-proxy — On-demand history fetch support.
 *
 * Faithful TypeScript port of whats-mcp `history-support.js`.
 * Requests older messages from WhatsApp via `sock.fetchMessageHistory`,
 * anchored on the oldest cached message, then waits for the store to grow.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import type { Store, AnyMsg } from "../store.ts";

export interface HistorySyncResult {
  enabled: boolean;
  requested: boolean;
  received: boolean;
  reason: string | null;
  before_count: number;
  after_count: number;
  anchor_id: string | null;
  requested_count: number;
  wait_ms: number;
}

interface FetchOptions {
  sock: WASocket;
  store: Store;
  jid: string;
  beforeId?: string;
  limit?: number;
  historyCount?: number;
  waitMs?: number;
  enabled?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getMessageTimestampSeconds(message: AnyMsg | null | undefined): number {
  const ts = message?.messageTimestamp;
  if (!ts) return 0;
  return typeof ts === "number" ? ts : Number(ts);
}

function getMessageTimestampMs(message: AnyMsg): number {
  return getMessageTimestampSeconds(message) * 1000;
}

export async function fetchAdditionalHistory({
  sock,
  store,
  jid,
  beforeId,
  limit = 50,
  historyCount,
  waitMs = 3500,
  enabled = true,
}: FetchOptions): Promise<HistorySyncResult> {
  const beforeCount = store.countMessages(jid);

  const result: HistorySyncResult = {
    enabled: enabled !== false,
    requested: false,
    received: false,
    reason: null,
    before_count: beforeCount,
    after_count: beforeCount,
    anchor_id: null,
    requested_count: 0,
    wait_ms: Math.max(250, Math.min(waitMs || 3500, 15000)),
  };

  if (enabled === false) {
    result.reason = "disabled";
    return result;
  }

  if (!sock || typeof (sock as any).fetchMessageHistory !== "function") {
    result.reason = "unsupported";
    return result;
  }

  let anchor = beforeId ? store.getMessage(beforeId) : null;
  if (!anchor) {
    anchor = store.getOldestMessage(jid);
  }

  if (!anchor?.key?.id || !anchor?.key?.remoteJid) {
    result.reason = "no_anchor";
    return result;
  }

  const anchorTimestampSeconds = getMessageTimestampSeconds(anchor);
  if (!anchorTimestampSeconds) {
    result.reason = "missing_anchor_timestamp";
    return result;
  }

  const initialOldest = store.getOldestMessage(jid) || anchor;
  const initialOldestId = initialOldest?.key?.id || null;
  const initialOldestTs = getMessageTimestampSeconds(initialOldest) || anchorTimestampSeconds;
  const requestedCount = Math.max(1, Math.min(historyCount || Math.max(limit, 50), 200));

  await (sock as any).fetchMessageHistory(requestedCount, anchor.key, getMessageTimestampMs(anchor));
  result.requested = true;
  result.anchor_id = anchor.key.id;
  result.requested_count = requestedCount;

  const deadline = Date.now() + result.wait_ms;
  while (Date.now() < deadline) {
    await sleep(250);

    const afterCount = store.countMessages(jid);
    const oldest = store.getOldestMessage(jid);
    const oldestId = oldest?.key?.id || null;
    const oldestTs = getMessageTimestampSeconds(oldest);

    if (
      afterCount > beforeCount ||
      (oldestId && oldestId !== initialOldestId) ||
      (oldestTs && oldestTs < initialOldestTs)
    ) {
      result.received = true;
      break;
    }
  }

  result.after_count = store.countMessages(jid);
  result.reason = result.received ? "history_updated" : "timeout";
  return result;
}
