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
  },
] satisfies ActionDef[];
