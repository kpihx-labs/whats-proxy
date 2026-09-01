/**
 * whats-proxy — Overview actions (2).
 *
 * whatsup       — full 7-day overview, no truncation
 * find-messages — regex-based search across the store
 *
 * Philosophy: no hardcoded heuristics, no watchlists in the backend.
 * The AI agent builds the regex; the backend applies it fast.
 */

import type { ActionDef } from "./types.ts";
import { whatsupSchema, findMessagesSchema } from "./schemas.ts";
import { isGroupJid, okResult, errResult, formatMessage } from "../helpers.ts";

export default [
  {
    meta: {
      action: "whatsup",
      category: "overview",
      description:
        "FULL 7-DAY WHATSAPP OVERVIEW — ALL messages, no truncation, no watchlists. Split into two time bands (recent_24h and older_7d). Groups: incoming only. Individual: needs_reply (last incoming unanswered) + others.",
      arguments: [
        { name: "since", description: "Override start Unix timestamp. Default: now - 7 days.", required: false },
        { name: "until", description: "Override end Unix timestamp. Default: now.", required: false },
      ],
      example: {},
      returns: "{ date, period, groups, individual, summary }",
    },
    handler: async ({ since, until }, { store }) => {
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;
      const sevenDaysAgo = now - 7 * 86400;

      const effectiveSince = since !== undefined ? Number(since) : sevenDaysAgo;
      const effectiveUntil = until !== undefined ? Number(until) : now;

      const allJids = new Set<string>(store.messages.keys());

      const fmt = (msg: Record<string, unknown>) => {
        const f = formatMessage(msg);
        if (!f) return null;
        return {
          id: f.id,
          timestamp: f.timestamp,
          timestamp_human: f.timestamp
            ? new Date(f.timestamp * 1000).toLocaleString("fr-FR", {
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: false,
              })
            : null,
          from_me: f.from_me,
          sender: f.sender,
          sender_name: f.push_name || null,
          text: f.text,
          type: f.type,
        };
      };

      type FmtMsg = NonNullable<ReturnType<typeof fmt>>;
      const ascTime = (a: FmtMsg, b: FmtMsg) => (a.timestamp || 0) - (b.timestamp || 0);

      const groupRecent: { jid: string; name: string; messages: any[] }[] = [];
      const groupOlder: { jid: string; name: string; messages: any[] }[] = [];
      const indRecent: { needs_reply: any[]; others: any[] } = { needs_reply: [], others: [] };
      const indOlder: { needs_reply: any[]; others: any[] } = { needs_reply: [], others: [] };

      const filterOpts = { since: effectiveSince, until: effectiveUntil, excludeTypes: ["protocol", "reaction"] };
      let totalMessages = 0;
      let totalChats = 0;

      for (const jid of allJids) {
        if (jid === "status@broadcast") continue;
        const isGroup = isGroupJid(jid);
        const chat = store.getChat(jid);
        const contact = store.getContact(jid);
        const chatName = chat?.name || chat?.subject || contact?.name || contact?.notify || jid;

        const rawMsgs = store.getMessages(jid, 99999, undefined, filterOpts);
        if (rawMsgs.length === 0) continue;
        totalChats++;

        if (isGroup) {
          const incoming = rawMsgs.filter((m) => m.key?.fromMe === false);
          const recent24 = incoming.filter((m) => (m.messageTimestamp || 0) >= oneDayAgo).map(fmt).filter(Boolean) as FmtMsg[];
          const older7d = incoming.filter((m) => (m.messageTimestamp || 0) < oneDayAgo).map(fmt).filter(Boolean) as FmtMsg[];
          recent24.sort(ascTime);
          older7d.sort(ascTime);
          totalMessages += recent24.length + older7d.length;
          if (recent24.length > 0) groupRecent.push({ jid, name: chatName, messages: recent24 });
          if (older7d.length > 0) groupOlder.push({ jid, name: chatName, messages: older7d });
        } else {
          const formatted = rawMsgs.map(fmt).filter(Boolean) as FmtMsg[];
          const lastOverall = formatted[0];
          const needsReply = lastOverall && !lastOverall.from_me;

          const recentMsgs = formatted.filter((m) => (m.timestamp || 0) >= oneDayAgo);
          const olderMsgs = formatted.filter((m) => (m.timestamp || 0) < oneDayAgo);
          totalMessages += formatted.length;

          const buildChatEntry = (msgs: any[]) => ({ jid, name: chatName, messages: msgs.sort(ascTime) });
          const buildNeedsReplyEntry = (msgs: any[]) => ({ jid, name: chatName, last_message: lastOverall || null, messages: msgs.sort(ascTime) });

          if (needsReply && recentMsgs.length > 0) indRecent.needs_reply.push(buildNeedsReplyEntry(recentMsgs));
          else if (recentMsgs.length > 0) indRecent.others.push(buildChatEntry(recentMsgs));
          if (needsReply && olderMsgs.length > 0) indOlder.needs_reply.push(buildNeedsReplyEntry(olderMsgs));
          else if (olderMsgs.length > 0) indOlder.others.push(buildChatEntry(olderMsgs));
        }
      }

      const sortByLastMsgDesc = (arr: { messages: any[] }[]) =>
        arr.sort((a, b) => (b.messages[b.messages.length - 1]?.timestamp || 0) - (a.messages[a.messages.length - 1]?.timestamp || 0));
      sortByLastMsgDesc(groupRecent);
      sortByLastMsgDesc(groupOlder);
      const sortIndiv = (arr: { last_message?: any; messages: any[] }[]) =>
        arr.sort((a, b) => (b.messages[b.messages.length - 1]?.timestamp || 0) - (a.messages[a.messages.length - 1]?.timestamp || 0));
      sortIndiv(indRecent.needs_reply);
      sortIndiv(indRecent.others);
      sortIndiv(indOlder.needs_reply);
      sortIndiv(indOlder.others);

      return okResult({
        date: new Date().toLocaleDateString("fr-FR"),
        period: { since: effectiveSince, until: effectiveUntil,
          from: new Date(effectiveSince * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
          to: new Date(effectiveUntil * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) },
        groups: { recent_24h: groupRecent, older_7d: groupOlder },
        individual: { recent_24h: indRecent, older_7d: indOlder },
        summary: { total_chats: totalChats, total_messages: totalMessages,
          groups_recent: groupRecent.length, groups_older: groupOlder.length,
          individual_needs_reply_24h: indRecent.needs_reply.length,
          individual_needs_reply_7d: indOlder.needs_reply.length,
          individual_others_24h: indRecent.others.length,
          individual_others_7d: indOlder.others.length },
      });
    },
    schema: whatsupSchema,
    docstring: `FULL 7-DAY WHATSAPP OVERVIEW — ALL messages, no truncation.

Parameters:
    - since (optional): Override start Unix timestamp. Default: now - 7 days.
    - until (optional): Override end Unix timestamp. Default: now.

Structure:
    groups.recent_24h / groups.older_7d: group chats, incoming messages only, chronological.
    individual.recent_24h / individual.older_7d: needs_reply (last incoming unanswered) + others.

Examples:
    - Full 7-day overview:
        \`whats-proxy do whatsup '{}'\`
    - Override time range:
        \`whats-proxy do whatsup '{"since":1788000000}'\``,
  },
  {
    meta: {
      action: "find-messages",
      category: "overview",
      description:
        "REGEX-BASED MESSAGE SEARCH — the AI agent passes a regex pattern; the backend applies it to all messages in the store. No hardcoded heuristics, no keyword expansion. For full history beyond the store, use qmd query on the autosave JSON.",
      arguments: [
        { name: "query", description: "Regex pattern to match against message text (JavaScript regex syntax).", required: true },
        { name: "since", description: "Optional: only include messages after this Unix timestamp.", required: false },
        { name: "until", description: "Optional: only include messages before this Unix timestamp.", required: false },
        { name: "limit", description: "Max total results (default: no limit).", required: false },
      ],
      example: { query: "(?i)stage|alternance|internship" },
      returns: "{ query, total_messages, total_chats, chats }",
    },
    handler: async ({ query, since, until, limit }, { store }) => {
      if (!query || !String(query).trim()) {
        return errResult("Parameter 'query' is required.");
      }

      let regex: RegExp;
      try {
        regex = new RegExp(String(query), "i");
      } catch (e) {
        return errResult(`Invalid regex: ${(e as Error).message}`);
      }

      const opts = {
        since: since !== undefined ? Number(since) : undefined,
        until: until !== undefined ? Number(until) : undefined,
      };

      const capped = Number(limit) || 99999;

      const allJids = new Set<string>(store.messages.keys());
      const chatResults: any[] = [];
      let totalMessages = 0;

      for (const jid of allJids) {
        if (jid === "status@broadcast") continue;

        const rawMsgs = store.getMessages(jid, 99999, undefined, opts);
        if (rawMsgs.length === 0) continue;

        const chat = store.getChat(jid);
        const contact = store.getContact(jid);
        const chatName = chat?.name || chat?.subject || contact?.name || contact?.notify || jid;

        const matched: any[] = [];
        for (const msg of rawMsgs) {
          const formatted = formatMessage(msg);
          if (!formatted) continue;
          const text = formatted.text || "";
          if (regex.test(text)) {
            matched.push({
              id: formatted.id,
              timestamp: formatted.timestamp,
              timestamp_human: formatted.timestamp
                ? new Date(formatted.timestamp * 1000).toLocaleString("fr-FR", {
                    day: "2-digit", month: "2-digit", year: "numeric",
                    hour: "2-digit", minute: "2-digit", hour12: false,
                  })
                : null,
              from_me: formatted.from_me,
              sender: formatted.sender,
              sender_name: formatted.push_name || null,
              text: formatted.text,
              type: formatted.type,
              matched: text.match(regex)?.[0] || null,
            });
            totalMessages++;
            if (matched.length >= capped) break;
          }
        }
        if (matched.length > 0) {
          chatResults.push({
            jid, name: chatName,
            is_group: isGroupJid(jid),
            messages: matched,
          });
        }
      }

      chatResults.sort((a, b) => b.messages.length - a.messages.length);

      return okResult({
        query: String(query),
        total_messages: totalMessages,
        total_chats: chatResults.length,
        chats: chatResults,
      });
    },
    schema: findMessagesSchema,
    docstring: `REGEX-BASED MESSAGE SEARCH — the AI agent passes a regex pattern, the backend applies it.

Parameters:
    - query (required): JavaScript regex pattern to match against message text.
    - since (optional): Unix timestamp — only search after this time.
    - until (optional): Unix timestamp — only search before this time.
    - limit (optional): Max total results (default: no limit).

The agent is responsible for building the regex. Examples:
    - Search for stage/internship:
        \`whats-proxy do find-messages '{"query":"(?i)stage|alternance|internship"}'\`
    - Search for urgent messages:
        \`whats-proxy do find-messages '{"query":"(?i)urgent|asap|urgent|au plus vite"}'\`
    - Search with time range:
        \`whats-proxy do find-messages '{"query":"(?i)offre|emploi|job","since":1788000000}'\`
    - For full history beyond the store: save with -o, then qmd query the JSON.`,
  },
] satisfies ActionDef[];
