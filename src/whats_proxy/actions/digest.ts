/**
 * whats-proxy — Digest actions (2).
 *
 * messages-multi (get_messages_multi), daily-digest.
 *
 * Faithful port of whats-mcp `digest.js`.
 */

import type { ActionDef } from "./types.ts";
import { messagesMultiSchema, dailyDigestSchema } from "./schemas.ts";
import { phoneToJid, isGroupJid, okResult, errResult, formatMessage } from "../helpers.ts";
import type { FormattedMessage } from "../helpers.ts";

const isMsg = (m: FormattedMessage | null): m is FormattedMessage => Boolean(m);

/** Resolve JIDs from explicit list or named watchlist; returns error text on failure. */
function _resolveJids(
  jids: unknown,
  watchlist: unknown,
  store: any,
  config: any,
): { jids?: string[]; error?: string } {
  if (Array.isArray(jids) && jids.length > 0) {
    return { jids: jids.map((j) => phoneToJid(String(j))) };
  }
  if (watchlist) {
    const wlJids = store.resolveWatchlist(String(watchlist), config?.watchlists);
    if (wlJids) {
      return { jids: wlJids.map((j: unknown) => phoneToJid(String(j))) };
    }
    const all = [...new Set([
      ...Object.keys(store.listWatchlists()),
      ...Object.keys(config?.watchlists || {}),
    ])];
    return { error: `Watchlist '${watchlist}' not found. Available: ${all.join(", ") || "none"}` };
  }
  return { error: "Provide either 'jids' array or a 'watchlist' name." };
}

function _chatName(store: any, jid: string): string {
  const chat = store.getChat(jid);
  const contact = store.getContact(jid);
  return chat?.name || chat?.subject || contact?.name || contact?.notify || jid;
}

export default [
  {
    meta: {
      action: "messages-multi",
      category: "overview",
      description:
        "Get messages from multiple chats in one call. Specify JIDs directly or use a named watchlist from config. Supports time range and message type filters.",
      arguments: [
        { name: "jids", description: "Array of chat JIDs or phone numbers to fetch messages from.", required: false },
        { name: "watchlist", description: "Name of a watchlist defined in the local Store or .env-backed defaults (e.g. 'groups', 'family'). Used if jids is empty.", required: false },
        { name: "limit_per_chat", description: "Max messages per chat (default 50, max 200).", required: false },
        { name: "since", description: "Unix timestamp: only include messages at or after this time.", required: false },
        { name: "until", description: "Unix timestamp: only include messages at or before this time.", required: false },
        { name: "include_types", description: "Only include messages of these types.", required: false },
        { name: "exclude_types", description: "Exclude messages of these types.", required: false },
      ],
      example: { jids: ["33612345678", "120363000000000@g.us"], limit_per_chat: 50 },
      returns: "{ total_chats, total_messages, filters, chats }",
    },
    handler: async (
      { jids, watchlist, limit_per_chat, since, until, include_types, exclude_types },
      { store, config },
    ) => {
      const resolved = _resolveJids(jids, watchlist, store, config);
      if (resolved.error) return errResult(resolved.error);
      const resolvedJids = resolved.jids!;

      const lim = Math.min(Number(limit_per_chat) || 50, 200);
      const filterOpts = {
        since: since !== undefined ? Number(since) : undefined,
        until: until !== undefined ? Number(until) : undefined,
        types: Array.isArray(include_types) ? include_types.map(String) : undefined,
        excludeTypes: Array.isArray(exclude_types) ? exclude_types.map(String) : undefined,
      };

      const chats: any[] = [];
      let totalMessages = 0;

      for (const jid of resolvedJids) {
        const messages = store.getMessages(jid, lim, undefined, filterOpts);
        const formatted = messages.map(formatMessage).filter(isMsg);

        chats.push({
          jid,
          name: _chatName(store, jid),
          is_group: isGroupJid(jid),
          count: formatted.length,
          messages: formatted,
        });
        totalMessages += formatted.length;
      }

      return okResult({
        total_chats: chats.length,
        total_messages: totalMessages,
        filters: { since, until, include_types, exclude_types, limit_per_chat: lim },
        chats,
      });
    },
    schema: messagesMultiSchema,
  },
  {
    meta: {
      action: "daily-digest",
      category: "overview",
      description:
        "Generate a structured daily digest of messages across specified chats. Defaults to the last 24 hours if no time range is given. Perfect for evening summaries: shows per-chat message counts, active participants, and messages. Chats with zero messages in the period are excluded.",
      arguments: [
        { name: "jids", description: "Array of chat JIDs or phone numbers.", required: false },
        { name: "watchlist", description: "Name of a watchlist from config. Used if jids is empty.", required: false },
        { name: "since", description: "Unix timestamp for period start. Default: 24 hours ago.", required: false },
        { name: "until", description: "Unix timestamp for period end. Default: now.", required: false },
        { name: "limit_per_chat", description: "Max messages per chat (default 100, max 500).", required: false },
        { name: "exclude_types", description: "Exclude these message types from the digest (e.g. reaction, protocol).", required: false },
      ],
      example: { watchlist: "evening_digest" },
      returns: "{ period, summary, chats }",
    },
    handler: async (
      { jids, watchlist, since, until, limit_per_chat, exclude_types },
      { store, config },
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const effectiveSince = since || (now - 86400);
      const effectiveUntil = until || now;

      let resolvedJids: string[];
      if (Array.isArray(jids) && jids.length > 0) {
        resolvedJids = jids.map((j) => phoneToJid(String(j)));
      } else if (watchlist) {
        const resolved = _resolveJids(jids, watchlist, store, config);
        if (resolved.error) return errResult(resolved.error);
        resolvedJids = resolved.jids!;
      } else {
        resolvedJids = Array.from(store.messages.keys());
      }

      const lim = Math.min(Number(limit_per_chat) || 100, 500);
      const filterOpts = {
        since: Number(effectiveSince),
        until: Number(effectiveUntil),
        excludeTypes: Array.isArray(exclude_types) ? exclude_types.map(String) : undefined,
      };

      const chatDigests: any[] = [];
      let totalMessages = 0;
      let totalFromMe = 0;
      let totalFromOthers = 0;

      for (const jid of resolvedJids) {
        const messages = store.getMessages(jid, lim, undefined, filterOpts);
        const formatted = messages.map(formatMessage).filter(isMsg);
        if (formatted.length === 0) continue;

        const fromMe = formatted.filter((m) => m.from_me).length;

        const participants = new Set<string>();
        for (const m of formatted) {
          if (m.sender) participants.add(m.sender);
        }

        chatDigests.push({
          jid,
          name: _chatName(store, jid),
          is_group: isGroupJid(jid),
          message_count: formatted.length,
          from_me: fromMe,
          from_others: formatted.length - fromMe,
          active_participants: participants.size,
          messages: formatted,
        });

        totalMessages += formatted.length;
        totalFromMe += fromMe;
        totalFromOthers += formatted.length - fromMe;
      }

      chatDigests.sort((a, b) => b.message_count - a.message_count);

      return okResult({
        period: {
          since: effectiveSince,
          until: effectiveUntil,
          since_iso: new Date(Number(effectiveSince) * 1000).toISOString(),
          until_iso: new Date(Number(effectiveUntil) * 1000).toISOString(),
        },
        summary: {
          total_chats: chatDigests.length,
          total_messages: totalMessages,
          total_from_me: totalFromMe,
          total_from_others: totalFromOthers,
        },
        chats: chatDigests,
      });
    },
    schema: dailyDigestSchema,
  },
] satisfies ActionDef[];
