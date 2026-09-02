/**
 * whats-proxy — Chat actions (7).
 *
 * chat-list, chat-read, chat-manage, chat-star, chat-disappearing, message-status, chat-read-batch.
 *
 * Faithful port of whats-mcp `chats.js`.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { chatListSchema, chatReadSchema, chatManageSchema, chatStarSchema, chatDisappearingSchema, messageStatusSchema, chatReadBatchSchema } from "./schemas.ts";
import { phoneToJid, isGroupJid, okResult, errResult, formatChat, formatMessage } from "../helpers.ts";
import { fetchAdditionalHistory, type HistorySyncResult } from "./history.ts";

export default [
  {
    meta: {
      action: "chat-list",
      category: "chats",
      description:
        "List recent chats from the in-memory store. Returns chat JIDs, names, timestamps, unread counts, and other metadata. Results are sorted by most recent activity.",
      arguments: [
        { name: "limit", description: "Max number of chats to return (default 50, max 500).", required: false },
        { name: "offset", description: "Offset for pagination (default 0).", required: false },
        { name: "filter", description: "Filter chats: all (default), groups, contacts, unread.", required: false },
      ],
      example: { limit: 50, filter: "groups" },
      returns: "{ total, offset, count, chats }",
    },
    handler: async ({ limit, offset, filter }, { store }) => {
      let chats = store.listChats(10000);
      const f = String(filter || "all");
      if (f === "groups") chats = chats.filter((c) => isGroupJid(c.id));
      if (f === "contacts") chats = chats.filter((c) => !isGroupJid(c.id));
      if (f === "unread") chats = chats.filter((c) => Number(c.unreadCount || 0) > 0);

      const total = chats.length;
      const off = Number(offset || 0);
      const lim = Math.min(Number(limit) || 50, 500);
      const page = chats.slice(off, off + lim);

      return okResult({
        total,
        offset: off,
        count: page.length,
        chats: page.map(formatChat),
      });
    },
    schema: chatListSchema,
    docstring: `List recent chats from the in-memory store. Returns chat JIDs, names, timestamps, unread counts, and other metadata.

Parameters:
    - limit (optional): Max number of chats to return (default 50, max 500).
    - offset (optional): Offset for pagination (default 0).
    - filter (optional): Filter chats: all (default), groups, contacts, unread.

Examples:
    - List all recent chats:
        \`whats-proxy do chat-list '{}'\`
        → {"total":120,"offset":0,"count":50,"chats":[{"jid":"33612345678@s.whatsapp.net","name":"Alice","unread":2,"last_message":"Hello!"},{"jid":"120363000000000@g.us","name":"X24 Project","unread":0,"last_message":"Sprint done"}]}
    - List only groups:
        \`whats-proxy do chat-list '{"filter":"groups","limit":20}'\`
        → {"total":15,"offset":0,"count":15,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project","unread":0},{"jid":"120363000000001@g.us","name":"Family","unread":5}]}
    - List unread chats:
        \`whats-proxy do chat-list '{"filter":"unread"}'\`
        → {"total":8,"offset":0,"count":8,"chats":[{"jid":"33612345678@s.whatsapp.net","name":"Alice","unread":2},{"jid":"120363000000001@g.us","name":"Family","unread":5}]}`,
  },
  {
    meta: {
      action: "chat-read",
      category: "chats",
      description:
        "Get recent messages from a specific chat. Outgoing messages include delivered_to/read_by when receipts are available; direct-chat read_by requires the recipient's read receipts privacy to be enabled. Messages come from the local store and can trigger an on-demand history fetch for older messages. Use before_id for pagination toward older messages.",
      arguments: [
        { name: "jid", description: "Chat JID or phone number.", required: true },
        { name: "limit", description: "Max number of messages to return (default 50, max 200).", required: false },
        { name: "before_id", description: "Message ID cursor: return messages older than this. For pagination.", required: false },
        { name: "fetch_history", description: "If true (default), request additional older history from WhatsApp when the local cache is insufficient.", required: false },
        { name: "history_count", description: "How many older messages to request during on-demand history sync (default: max(limit, 50), max 200).", required: false },
        { name: "history_wait_ms", description: "How long to wait for history sync events (default 3500ms, max 15000ms).", required: false },
        { name: "since", description: "Unix timestamp: only include messages sent at or after this time.", required: false },
        { name: "until", description: "Unix timestamp: only include messages sent at or before this time.", required: false },
        { name: "include_types", description: "If set, only include messages of these types (e.g. text, image, video).", required: false },
        { name: "exclude_types", description: "Exclude messages of these types (e.g. reaction, protocol).", required: false },
      ],
      example: { jid: "33612345678", limit: 50 },
      returns: "{ jid, count, messages, history_sync }",
    },
    handler: async ({ jid, limit, before_id, fetch_history, history_count, history_wait_ms, since, until, include_types, exclude_types }, { sock, store }) => {
      const chatJid = phoneToJid(String(jid));
      const lim = Math.min(Number(limit) || 50, 200);
      const filterOpts = {
        since: since || undefined,
        until: until || undefined,
        types: include_types || undefined,
        excludeTypes: exclude_types || undefined,
      } as any;

      let historySync: HistorySyncResult = {
        enabled: fetch_history !== false,
        requested: false,
        received: false,
        reason: "cache_sufficient",
        before_count: store.countMessages(chatJid),
        after_count: store.countMessages(chatJid),
        anchor_id: null,
        requested_count: 0,
        wait_ms: 0,
      };

      let messages = store.getMessages(chatJid, lim, before_id as string | undefined, filterOpts);
      const shouldFetchHistory = fetch_history !== false && (before_id || messages.length < lim);
      if (shouldFetchHistory) {
        historySync = await fetchAdditionalHistory({
          sock,
          store,
          jid: chatJid,
          beforeId: before_id as string | undefined,
          limit: lim,
          historyCount: history_count as number | undefined,
          waitMs: history_wait_ms as number | undefined,
          enabled: fetch_history !== false,
        });
        messages = store.getMessages(chatJid, lim, before_id as string | undefined, filterOpts);
      }

      const formatted = messages.map(formatMessage).filter(Boolean);
      const receiptsMap = store.getChatReceipts(chatJid);
      const enriched = formatted.map((m: any) => {
        const receipts = receiptsMap.get(m.id) || [];
        if (m.from_me) {
          return {
            ...m,
            read_by: receipts
              .filter((r: any) => r.receipt_type === "read")
              .map((r: any) => r.reader_jid),
            delivered_to: receipts
              .filter((r: any) => r.receipt_type === "delivered")
              .map((r: any) => r.reader_jid),
          };
        }
        return { ...m, read_by: [], delivered_to: [] };
      });

      return okResult({
        jid: chatJid,
        count: enriched.length,
        messages: enriched,
        history_sync: historySync,
      });
    },
    schema: chatReadSchema,
    docstring: `Get recent messages from a specific chat. Outgoing messages include delivered_to/read_by when receipts are available; direct-chat read_by requires the recipient's WhatsApp read receipts privacy to be enabled.

Receipt visibility: in one-to-one chats, read_by is populated only when the recipient has read receipts enabled (profile-privacy read_receipts=all). Group read receipts are not controlled by that privacy setting.

Parameters:
    - jid (required): Chat JID or phone number.
    - limit (optional): Max number of messages to return (default 50, max 200).
    - before_id (optional): Message ID cursor: return messages older than this.
    - fetch_history (optional): If true (default), request additional older history from WhatsApp.
    - history_count (optional): How many older messages to request during history sync.
    - history_wait_ms (optional): How long to wait for history sync events (default 3500ms).
    - since (optional): Unix timestamp: only include messages at or after this time.
    - until (optional): Unix timestamp: only include messages at or before this time.
    - include_types (optional): Only include messages of these types.
    - exclude_types (optional): Exclude messages of these types.

Examples:
    - Read recent messages from a contact:
        \`whats-proxy do chat-read '{"jid":"33612345678","limit":20}'\`
        → {"jid":"33612345678@s.whatsapp.net","count":20,"messages":[{"id":"MSG001","text":"Hello!","from_me":false,"timestamp":1756614000},{"id":"MSG002","text":"Hi there","from_me":true,"timestamp":1756613900}],"history_sync":{"enabled":true,"requested":false,"received":false,"reason":"cache_sufficient","before_count":45,"after_count":45}}
    - Read messages with time filter:
        \`whats-proxy do chat-read '{"jid":"120363000000000@g.us","since":1756600000,"until":1756620000}'\`
        → {"jid":"120363000000000@g.us","count":12,"messages":[{"id":"MSG003","text":"Sprint update","from_me":false,"timestamp":1756610000}],"history_sync":{"enabled":true,"requested":false,"received":false,"reason":"cache_sufficient","before_count":30,"after_count":30}}
    - Paginate older messages:
        \`whats-proxy do chat-read '{"jid":"33612345678","limit":50,"before_id":"MSG050"}'\`
        → {"jid":"33612345678@s.whatsapp.net","count":50,"messages":[{"id":"MSG049","text":"Older message","from_me":false,"timestamp":1756600000}],"history_sync":{"enabled":true,"requested":true,"received":true,"reason":"cache_insufficient","before_count":50,"after_count":100,"anchor_id":"MSG050","requested_count":50,"wait_ms":3500}}`,
  },
  {
    meta: {
      action: "chat-manage",
      category: "chats",
      description:
        "Perform a chat management action: archive, unarchive, pin, unpin, mute, unmute, mark_read, mark_unread, delete, or clear.",
      arguments: [
        { name: "jid", description: "Chat JID or phone number.", required: true },
        { name: "action", description: "archive|unarchive|pin|unpin|mute|unmute|mark_read|mark_unread|delete|clear", required: true },
        { name: "mute_duration", description: "For 'mute' action: duration in seconds. 0 = 8 hours, -1 = forever. Default 8 hours.", required: false },
      ],
      example: { jid: "33612345678", action: "archive" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ jid, action, mute_duration }, { sock, store }) => {
      const chatJid = phoneToJid(String(jid));
      const now = Date.now();

      let lastMessages: Array<{ key: { id: string; remoteJid: string; fromMe: boolean; participant?: string }; messageTimestamp: number }> | undefined;
      if (action === "mark_read" || action === "mark_unread") {
        const msgs = store.getMessages(chatJid, 1);
        if (msgs.length > 0) {
          const latest = msgs[0]!;
          lastMessages = [{
            key: {
              id: latest.key.id,
              remoteJid: latest.key.remoteJid || chatJid,
              fromMe: latest.key.fromMe,
              ...(latest.key.participant ? { participant: latest.key.participant } : {}),
            },
            messageTimestamp: Number(latest.messageTimestamp),
          }];
        }
      }

      const modMap: Record<string, Record<string, unknown>> = {
        archive: { archive: true, lastMessages: undefined },
        unarchive: { archive: false, lastMessages: undefined },
        pin: { pin: true },
        unpin: { pin: false },
        mute: {
          mute: mute_duration === -1
            ? undefined
            : (Number(mute_duration) || 8 * 3600) * 1000 + now,
        },
        unmute: { mute: null },
        mark_read: { markRead: true, lastMessages },
        mark_unread: { markRead: false, lastMessages },
        delete: { delete: true, lastMessages },
        clear: { clear: { messages: [] } },
      };

      if (action === "mute" && mute_duration === -1) {
        modMap.mute!.mute = 0;
      }

      const mod = modMap[String(action)];
      if (!mod) return errResult(`Unknown action: ${action}`);

      await sock.chatModify(mod as any, chatJid);
      return okResult({ status: action, jid: chatJid });
    }),
    schema: chatManageSchema,
    docstring: `Perform a chat management action: archive, unarchive, pin, unpin, mute, unmute, mark_read, mark_unread, delete, or clear.

Parameters:
    - jid (required): Chat JID or phone number.
    - action (required): archive|unarchive|pin|unpin|mute|unmute|mark_read|mark_unread|delete|clear.
    - mute_duration (optional): For 'mute' action: duration in seconds. 0 = 8 hours, -1 = forever.

Examples:
    - Archive a chat:
        \`whats-proxy do chat-manage '{"jid":"33612345678","action":"archive"}'\`
        → {"status":"archive","jid":"33612345678@s.whatsapp.net"}
    - Mute a group for 8 hours:
        \`whats-proxy do chat-manage '{"jid":"120363000000000@g.us","action":"mute","mute_duration":0}'\`
        → {"status":"mute","jid":"120363000000000@g.us"}
    - Mark a chat as unread:
        \`whats-proxy do chat-manage '{"jid":"33612345678","action":"mark_unread"}'\`
        → {"status":"mark_unread","jid":"33612345678@s.whatsapp.net"}`,
  },
  {
    meta: {
      action: "chat-star",
      category: "chats",
      description: "Star or unstar a message.",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_id", description: "Message ID to star/unstar.", required: true },
        { name: "star", description: "true to star, false to unstar. Default true.", required: false },
        { name: "from_me", description: "Whether the message was sent by you. Default false.", required: false },
      ],
      example: { jid: "33612345678", message_id: "ABC123", star: true },
      returns: "{ status, jid, message_id }",
    },
    handler: requireApproval("default")(async ({ jid, message_id, star, from_me }, { sock, store }) => {
      const chatJid = phoneToJid(String(jid));
      const shouldStar = star !== false;
      // Auto-detect fromMe from the store when not explicitly provided —
      // WhatsApp's star target is keyed by {id, fromMe}, so guessing wrong
      // (defaulting to false) silently stars nothing when the message is yours.
      let resolvedFromMe: boolean;
      if (from_me !== undefined) {
        resolvedFromMe = Boolean(from_me);
      } else {
        const msg = store.getMessage(String(message_id));
        resolvedFromMe = msg?.key?.fromMe ?? false;
      }
      await sock.chatModify(
        {
          star: {
            messages: [{ id: String(message_id), fromMe: resolvedFromMe }],
            star: shouldStar,
          },
        } as any,
        chatJid,
      );
      return okResult({
        status: shouldStar ? "starred" : "unstarred",
        jid: chatJid,
        message_id,
      });
    }),
    schema: chatStarSchema,
    docstring: `Star or unstar a message.

Parameters:
    - jid (required): Chat JID.
    - message_id (required): Message ID to star/unstar.
    - star (optional): true to star, false to unstar. Default true.
    - from_me (optional): Whether the message was sent by you. Default false.

Examples:
    - Star a message:
        \`whats-proxy do chat-star '{"jid":"33612345678","message_id":"ABC123","star":true}'\`
        → {"status":"starred","jid":"33612345678@s.whatsapp.net","message_id":"ABC123"}
    - Unstar a message:
        \`whats-proxy do chat-star '{"jid":"33612345678","message_id":"ABC123","star":false}'\`
        → {"status":"unstarred","jid":"33612345678@s.whatsapp.net","message_id":"ABC123"}
    - Star your own message in a group:
        \`whats-proxy do chat-star '{"jid":"120363000000000@g.us","message_id":"MSG456","star":true,"from_me":true}'\`
        → {"status":"starred","jid":"120363000000000@g.us","message_id":"MSG456"}`,
  },
  {
    meta: {
      action: "chat-disappearing",
      category: "chats",
      description:
        "Set disappearing messages timer for a chat. Available durations: 0 (off), 86400 (24h), 604800 (7 days), 7776000 (90 days).",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "duration", description: "Disappearing timer in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.", required: true },
      ],
      example: { jid: "33612345678", duration: 86400 },
      returns: "{ status, jid, disappearing }",
    },
    handler: requireApproval("default")(async ({ jid, duration }, { sock }) => {
      const chatJid = phoneToJid(String(jid));
      await sock.sendMessage(chatJid, { disappearingMessagesInChat: Number(duration) } as any);
      const labels: Record<number, string> = { 0: "off", 86400: "24 hours", 604800: "7 days", 7776000: "90 days" };
      return okResult({
        status: "set",
        jid: chatJid,
        disappearing: labels[Number(duration)] || `${duration}s`,
      });
    }),
    schema: chatDisappearingSchema,
    docstring: `Set disappearing messages timer for a chat. Available durations: 0 (off), 86400 (24h), 604800 (7 days), 7776000 (90 days).

Parameters:
    - jid (required): Chat JID.
    - duration (required): Disappearing timer in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.

Examples:
    - Enable 24h disappearing messages:
        \`whats-proxy do chat-disappearing '{"jid":"33612345678","duration":86400}'\`
        → {"status":"set","jid":"33612345678@s.whatsapp.net","disappearing":"24 hours"}
    - Enable 7-day disappearing messages:
        \`whats-proxy do chat-disappearing '{"jid":"120363000000000@g.us","duration":604800}'\`
        → {"status":"set","jid":"120363000000000@g.us","disappearing":"7 days"}
    - Disable disappearing messages:
        \`whats-proxy do chat-disappearing '{"jid":"33612345678","duration":0}'\`
        → {"status":"set","jid":"33612345678@s.whatsapp.net","disappearing":"off"}`,
  },
  {
    meta: {
      action: "message-status",
      category: "chats",
        description: "Check delivery/read receipts for a specific message or recent sent messages. Direct-chat read counts require the recipient's read receipts privacy to be enabled.",
      arguments: [
        { name: "action", description: "'get' for one message's receipts, 'sent' for recent messages in a chat.", required: true },
        { name: "message_id", description: "Message JID (required for 'get').", required: false },
        { name: "chat_jid", description: "Chat JID (required for 'sent').", required: false },
        { name: "limit", description: "Max messages for 'sent' (default 50).", required: false },
      ],
      example: { action: "get", message_id: "3EB0..." },
      returns: "{ receipts } | { messages }",
    },
    handler: async ({ action, message_id, chat_jid, limit }, { store }) => {
      if (action === "get") {
        if (!message_id) return errResult("'message_id' is required for 'get'.");
        const receipts = store.getReceipts(String(message_id));
        return okResult({ message_id, receipts });
      }
      if (action === "sent") {
        if (!chat_jid) return errResult("'chat_jid' is required for 'sent'.");
        const lim = Math.min(Number(limit) || 50, 200);
        const allMessages = store.getMessages(String(chat_jid), lim);
        const messages = allMessages.filter((m: any) => m.key?.fromMe === true);
        const formatted = messages.map(formatMessage).filter(Boolean);
        const receiptsMap = store.getChatReceipts(String(chat_jid));
        const result = formatted.map((m: any) => ({
          ...m,
          receipts: (receiptsMap.get(m.id) || []).map((r: any) => ({
            reader: r.reader_jid,
            type: r.receipt_type,
            at: r.timestamp,
          })),
          read_count: (receiptsMap.get(m.id) || []).filter((r: any) => r.receipt_type === "read").length,
        }));
        return okResult({ chat_jid, total: result.length, messages: result });
      }
      return errResult(`Unknown action: ${action}. Use 'get' or 'sent'.`);
    },
    schema: messageStatusSchema,
    docstring: `Check delivery/read receipts for messages.

Receipt visibility: in one-to-one chats, read receipts and read_count are populated only when the recipient has WhatsApp read receipts enabled (profile-privacy read_receipts=all). Group read receipts are not controlled by that privacy setting.

Parameters:
    - action (required): 'get' for one message's receipts, 'sent' for your recent messages with receipts.
    - message_id (get only): The message ID to check.
    - chat_jid (sent only): Chat JID to scan.
    - limit (sent only): Max messages (default 50).

Examples:
    - Check who read a message:
        \`whats-proxy do message-status '{"action":"get","message_id":"3EB0AF..."}'\`
        → {"message_id":"3EB0AF...","receipts":[{"reader":"237...@s.whatsapp.net","type":"read","at":1788260100}]}
    - Check your sent messages with read status:
        \`whats-proxy do message-status '{"action":"sent","chat_jid":"237675836168@s.whatsapp.net"}'\`
        → {"chat_jid":"237675836168@s.whatsapp.net","total":5,"messages":[{"id":"3EB0...","text":"Hello","read_count":1,"receipts":[...]}]}`,
  },
  {
    meta: {
      action: "chat-read-batch",
      category: "chats",
      description:
        "Fetch messages from multiple chats in one call. Pass JIDs directly. No limits, no truncation — full data returned.",
      arguments: [
        { name: "jids", description: "Array of chat JIDs or phone numbers.", required: true },
        { name: "limit_per_chat", description: "Max messages per chat (default: no limit).", required: false },
        { name: "since", description: "Unix timestamp: only messages after this time.", required: false },
        { name: "until", description: "Unix timestamp: only messages before this time.", required: false },
        { name: "include_types", description: "Only include these message types.", required: false },
        { name: "exclude_types", description: "Exclude these message types.", required: false },
      ],
      example: { jids: ["33612345678", "120363000000000@g.us"] },
      returns: "{ total_chats, total_messages, chats }",
    },
    handler: async (
      { jids, limit_per_chat, since, until, include_types, exclude_types },
      { store },
    ) => {
      if (!Array.isArray(jids) || jids.length === 0) {
        return errResult("'jids' is required — a non-empty array of chat JIDs.");
      }

      const resolvedJids = jids.map((j) => {
        const s = String(j).trim();
        return s.includes("@") ? s : `${s}@s.whatsapp.net`;
      });

      const lim = Number(limit_per_chat) || 99999;
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
        const formatted = messages.map(formatMessage).filter((m: any): m is NonNullable<typeof m> => Boolean(m));

        const chat = store.getChat(jid);
        const contact = store.getContact(jid);

        chats.push({
          jid,
          name: chat?.name || chat?.subject || contact?.name || contact?.notify || jid,
          is_group: isGroupJid(jid),
          count: formatted.length,
          messages: formatted,
        });
        totalMessages += formatted.length;
      }

      return okResult({
        total_chats: chats.length,
        total_messages: totalMessages,
        chats,
      });
    },
    schema: chatReadBatchSchema,
    docstring: `Fetch messages from multiple chats in one call. Full data, no truncation.

Parameters:
    - jids (required): Array of chat JIDs or phone numbers.
    - limit_per_chat (optional): Max messages per chat (default: no limit).
    - since / until (optional): Time range filter.
    - include_types / exclude_types (optional): Type filters.

Examples:
    - Batch read two chats:
        \`whats-proxy do chat-read-batch '{"jids":["33612345678","120363000000000@g.us"]}'\`
    - Batch read with time filter:
        \`whats-proxy do chat-read-batch '{"jids":["33612345678"],"since":1788000000}'\``,
  },
] satisfies ActionDef[];
