/**
 * whats-proxy — Chat actions (5).
 *
 * chat-list, chat-read, chat-manage, chat-star, chat-disappearing.
 *
 * Faithful port of whats-mcp `chats.js`.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { chatListSchema, chatReadSchema, chatManageSchema, chatStarSchema, chatDisappearingSchema } from "./schemas.ts";
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
        "Get recent messages from a specific chat. Messages come from the local store and can trigger an on-demand history fetch for older messages. Use before_id for pagination toward older messages.",
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

      return okResult({
        jid: chatJid,
        count: messages.length,
        messages: messages.map(formatMessage).filter(Boolean),
        history_sync: historySync,
      });
    },
    schema: chatReadSchema,
    docstring: `Get recent messages from a specific chat. Messages come from the local store and can trigger an on-demand history fetch for older messages.

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

      let lastMessages: { id: string; remoteJid: string; fromMe: boolean }[] | undefined;
      if (action === "mark_read" || action === "mark_unread") {
        const msgs = store.getMessages(chatJid, 1);
        if (msgs.length > 0) {
          lastMessages = [{ id: msgs[0]!.key.id, remoteJid: chatJid, fromMe: msgs[0]!.key.fromMe }];
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
] satisfies ActionDef[];
