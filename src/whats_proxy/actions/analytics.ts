/**
 * whats-proxy — Analytics actions (5).
 *
 * analytics-overview, analytics-top-chats, analytics-chat-insights,
 * analytics-timeline, analytics-search.
 *
 * Faithful port of whats-mcp `analytics.js`.
 */

import type { ActionDef } from "./types.ts";
import { analyticsOverviewSchema, analyticsTopChatsSchema, analyticsChatInsightsSchema, analyticsTimelineSchema, analyticsSearchSchema } from "./schemas.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "analytics-overview",
      category: "analytics",
      description:
        "Return a local analytics summary built from the cached WhatsApp store. Includes totals, top chats, top tokens, top senders, and activity trends.",
      arguments: [
        { name: "top_chats", description: "Number of top chats to include. Default 10.", required: false },
        { name: "top_tokens", description: "Number of top tokens to include. Default 20.", required: false },
        { name: "top_senders", description: "Number of top senders to include. Default 10.", required: false },
        { name: "days", description: "Number of daily activity buckets to include. Default 30.", required: false },
      ],
      example: { top_chats: 10, days: 30 },
      returns: "{ totals, top_chats, top_tokens, top_senders, trends }",
    },
    handler: async (args, { store }) => okResult(store.getAnalyticsOverview(args)),
    schema: analyticsOverviewSchema,
    docstring: `Return a local analytics summary built from the cached WhatsApp store. Includes totals, top chats, top tokens, top senders, and activity trends.

Parameters:
    - top_chats (optional): Number of top chats to include. Default 10.
    - top_tokens (optional): Number of top tokens to include. Default 20.
    - top_senders (optional): Number of top senders to include. Default 10.
    - days (optional): Number of daily activity buckets to include. Default 30.

Examples:
    - Get full overview:
        \`whats-proxy do analytics-overview '{}'\`
        → {"totals":{"messages":12500,"chats":85,"senders":42},"top_chats":[{"jid":"120363000000000@g.us","name":"X24 Project","messages":850}],"top_tokens":[{"token":"meeting","count":120}],"top_senders":[{"jid":"33612345678","name":"Alice","count":320}]}
    - Overview with custom limits:
        \`whats-proxy do analytics-overview '{"top_chats":5,"days":7}'\`
        → {"totals":{"messages":320,"chats":15,"senders":12},"top_chats":[{"jid":"33612345678","name":"Alice","messages":85}],"top_tokens":[{"token":"sprint","count":45}]}
    - Overview focused on senders:
        \`whats-proxy do analytics-overview '{"top_senders":20,"top_chats":3}'\`
        → {"totals":{"messages":12500,"chats":85,"senders":42},"top_senders":[{"jid":"33612345678","name":"Alice","count":320},{"jid":"33600000000","name":"Bob","count":280}]}`,
  },
  {
    meta: {
      action: "analytics-top-chats",
      category: "analytics",
      description:
        "Rank chats using the local analytics index. Can sort by message count, last activity, active days, or participant count.",
      arguments: [
        { name: "limit", description: "Maximum number of chats to return. Default 20.", required: false },
        { name: "sort_by", description: "Sort criterion: message_count | last_activity | active_days | participants.", required: false },
      ],
      example: { limit: 20, sort_by: "message_count" },
      returns: "{ count, chats }",
    },
    handler: async ({ limit, sort_by }, { store }) => okResult({
      count: Math.min(Number(limit) || 20, 200),
      chats: store.listAnalyticsTopChats({ limit: limit as number | undefined, sort_by: sort_by as string | undefined }),
    }),
    schema: analyticsTopChatsSchema,
    docstring: `Rank chats using the local analytics index. Can sort by message count, last activity, active days, or participant count.

Parameters:
    - limit (optional): Maximum number of chats to return. Default 20.
    - sort_by (optional): Sort criterion: message_count | last_activity | active_days | participants.

Examples:
    - Top chats by message count:
        \`whats-proxy do analytics-top-chats '{"sort_by":"message_count","limit":10}'\`
        → {"count":10,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project","message_count":850,"active_days":45},{"jid":"33612345678","name":"Alice","message_count":320,"active_days":30}]}
    - Top chats by last activity:
        \`whats-proxy do analytics-top-chats '{"sort_by":"last_activity","limit":5}'\`
        → {"count":5,"chats":[{"jid":"33600000000","name":"Bob","last_activity":1756614000,"message_count":150}]}
    - Top chats by participants:
        \`whats-proxy do analytics-top-chats '{"sort_by":"participants","limit":10}'\`
        → {"count":10,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project","participants":25,"message_count":850}]}`,
  },
  {
    meta: {
      action: "analytics-chat-insights",
      category: "analytics",
      description:
        "Return detailed local analytics for one chat, including top tokens, senders, activity, and recent messages.",
      arguments: [
        { name: "jid", description: "Chat JID or phone number.", required: true },
        { name: "top_tokens", description: "Maximum number of top tokens to include. Default 15.", required: false },
        { name: "top_senders", description: "Maximum number of top senders to include. Default 10.", required: false },
        { name: "days", description: "Number of daily activity buckets to include. Default 30.", required: false },
        { name: "recent_messages", description: "Number of recent messages to include. Default 5.", required: false },
      ],
      example: { jid: "33612345678", top_tokens: 15 },
      returns: "{ jid, totals, top_tokens, top_senders, activity, recent_messages }",
    },
    handler: async ({ jid, ...options }, { store }) => {
      const chatJid = phoneToJid(String(jid));
      const result = store.getChatAnalytics(chatJid, options)
        || store.getChatAnalytics(String(jid), options);
      if (!result) {
        return errResult(`No analytics available for chat ${jid}.`);
      }
      return okResult(result);
    },
    schema: analyticsChatInsightsSchema,
    docstring: `Return detailed local analytics for one chat, including top tokens, senders, activity, and recent messages.

Parameters:
    - jid (required): Chat JID or phone number.
    - top_tokens (optional): Maximum number of top tokens to include. Default 15.
    - top_senders (optional): Maximum number of top senders to include. Default 10.
    - days (optional): Number of daily activity buckets to include. Default 30.
    - recent_messages (optional): Number of recent messages to include. Default 5.

Examples:
    - Get chat insights:
        \`whats-proxy do analytics-chat-insights '{"jid":"33612345678"}'\`
        → {"jid":"33612345678@s.whatsapp.net","totals":{"messages":320,"senders":2},"top_tokens":[{"token":"meeting","count":45}],"top_senders":[{"jid":"33612345678","count":200}],"activity":[{"date":"2026-08-30","count":12}]}
    - Insights with custom limits:
        \`whats-proxy do analytics-chat-insights '{"jid":"120363000000000@g.us","top_tokens":5,"top_senders":3}'\`
        → {"jid":"120363000000000@g.us","totals":{"messages":850,"senders":12},"top_tokens":[{"token":"sprint","count":120}],"top_senders":[{"jid":"33612345678","count":320}]}
    - No analytics available:
        \`whats-proxy do analytics-chat-insights '{"jid":"33699999999"}'\`
        → {"meta":{"status":"error","comment":"No analytics available for chat 33699999999.","edited":false},"data":{"error":"No analytics available for chat 33699999999."}}`,
  },
  {
    meta: {
      action: "analytics-timeline",
      category: "analytics",
      description:
        "Return a daily activity timeline from the local analytics index, globally or for one chat.",
      arguments: [
        { name: "jid", description: "Optional chat JID or phone number.", required: false },
        { name: "days", description: "Number of days to include. Default 30.", required: false },
      ],
      example: { days: 30 },
      returns: "{ days, entries }",
    },
    handler: async ({ jid, days }, { store }) => {
      const result = store.getActivityTimeline({
        jid: jid ? phoneToJid(String(jid)) : undefined,
        days: days !== undefined ? Number(days) : undefined,
      }) || (jid ? store.getActivityTimeline({ jid: String(jid), days: days !== undefined ? Number(days) : undefined }) : null);
      if (!result) {
        return errResult(`No timeline available for chat ${jid}.`);
      }
      return okResult(result);
    },
    schema: analyticsTimelineSchema,
    docstring: `Return a daily activity timeline from the local analytics index, globally or for one chat.

Parameters:
    - jid (optional): Chat JID or phone number.
    - days (optional): Number of days to include. Default 30.

Examples:
    - Global activity timeline:
        \`whats-proxy do analytics-timeline '{"days":7}'\`
        → {"days":7,"entries":[{"date":"2026-08-30","count":120},{"date":"2026-08-29","count":95},{"date":"2026-08-28","count":110}]}
    - Chat-specific timeline:
        \`whats-proxy do analytics-timeline '{"jid":"33612345678","days":14}'\`
        → {"days":14,"entries":[{"date":"2026-08-30","count":15},{"date":"2026-08-29","count":8}]}
    - Full month overview:
        \`whats-proxy do analytics-timeline '{"days":30}'\`
        → {"days":30,"entries":[{"date":"2026-08-30","count":120},{"date":"2026-08-29","count":95}]}`,
  },
  {
    meta: {
      action: "analytics-search",
      category: "analytics",
      description:
        "Run a ranked search over the local analytics index using token matches, phrase matches, and recency. Supports time range and multi-JID filtering.",
      arguments: [
        { name: "query", description: "Search query.", required: true },
        { name: "jid", description: "Optional chat JID or phone number.", required: false },
        { name: "jids", description: "Optional: search across multiple chat JIDs. Takes precedence over jid.", required: false },
        { name: "limit", description: "Maximum number of results. Default 20.", required: false },
        { name: "since", description: "Unix timestamp: only include messages at or after this time.", required: false },
        { name: "until", description: "Unix timestamp: only include messages at or before this time.", required: false },
      ],
      example: { query: "stage" },
      examples: [
        { description: "Global token search", payload: { query: "stage", limit: 20 } },
        { description: "One-chat phrase search", payload: { query: "project review", jid: "33612345678", limit: 10 } },
        { description: "Multi-chat time-bounded search", payload: { query: "deadline", jids: ["33612345678", "120363000000000@g.us"], since: 1786550400, limit: 50 } },
      ],
      returns: "{ query, count, messages }",
    },
    handler: async ({ query, jid, jids, limit, since, until }, { store }) => {
      let chatJids: string | string[] | undefined;
      if (Array.isArray(jids) && jids.length > 0) {
        chatJids = jids.map((j) => phoneToJid(String(j)));
      } else if (jid) {
        chatJids = phoneToJid(String(jid));
      }
      const opts = {
        since: since !== undefined ? Number(since) : undefined,
        until: until !== undefined ? Number(until) : undefined,
      };
      const messages = store.analyticsSearch(String(query), chatJids ?? null, limit as number | undefined, opts);
      return okResult({
        query,
        count: messages.length,
        messages,
      });
    },
    schema: analyticsSearchSchema,
    docstring: `Run a ranked search over the local analytics index using token matches, phrase matches, and recency.

Parameters:
    - query (required): Search query.
    - jid (optional): Chat JID or phone number.
    - jids (optional): Search across multiple chat JIDs. Takes precedence over jid.
    - limit (optional): Maximum number of results. Default 20.
    - since (optional): Unix timestamp: only include messages at or after this time.
    - until (optional): Unix timestamp: only include messages at or before this time.

Examples:
    - Global search for "stage":
        \`whats-proxy do analytics-search '{"query":"stage","limit":20}'\`
        → {"query":"stage","count":15,"messages":[{"id":"MSG001","jid":"33612345678","text":"Stage chez DxO confirmé","score":0.95,"timestamp":1756614000}]}
    - Search in one chat:
        \`whats-proxy do analytics-search '{"query":"project review","jid":"33612345678","limit":10}'\`
        → {"query":"project review","count":5,"messages":[{"id":"MSG002","jid":"33612345678","text":"Project review scheduled for Friday","score":0.88,"timestamp":1756610000}]}
    - Time-bounded multi-chat search:
        \`whats-proxy do analytics-search '{"query":"deadline","jids":["33612345678","120363000000000@g.us"],"since":1786550400,"limit":50}'\`
        → {"query":"deadline","count":8,"messages":[{"id":"MSG003","jid":"120363000000000@g.us","text":"Deadline moved to next week","score":0.82,"timestamp":1786600000}]}`,
  },
] satisfies ActionDef[];
