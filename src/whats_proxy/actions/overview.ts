/**
 * whats-proxy — Overview & smart search actions (2).
 *
 * whatsup       — full daily overview, watchlist-prioritized, unanswered threads
 * find-messages — smart semantic search with keyword expansion
 *
 * Faithful port of whats-mcp `overview.js` (TOPIC_EXPANSIONS preserved).
 */

import type { ActionDef } from "./types.ts";
import { whatsupSchema, findMessagesSchema } from "./schemas.ts";
import { phoneToJid, isGroupJid, okResult, errResult, formatMessage } from "../helpers.ts";

// ── Topic expansion map (French + English) ───────────────────────────────────
//
// For each topic, lists keywords to expand the user's query into.
// "ia" → also searches for "llm", "gpt", "machine learning", etc.
// Partial matches are intentional (e.g. "opportunit" catches opportunité/opportunités).

const TOPIC_EXPANSIONS: Record<string, string[]> = {
  ia: [
    "ia", "intelligence artificielle", "ai", "machine learning", "llm", "gpt",
    "chatgpt", "neural", "deep learning", "ml", "nlp", "modele", "modèle",
    "mistral", "gemini", "openai", "anthropic", "claude", "transformer",
    "rag", "embedding", "dataset", "data science",
  ],
  stage: [
    "stage", "internship", "alternance", "apprentissage", "stagiaire",
  ],
  offre: [
    "offre", "opportunit", "recrutement", "embauche", "poste", "job",
    "emploi", "cdi", "cdd", "freelance", "mission", "contrat",
  ],
  badminton: [
    "badminton", "binet bad", "tournoi bad", "match bad", "entraîn",
    "raquette", "volant", "terrain bad",
  ],
  sport: [
    "sport", "match", "tournoi", "training", "gym", "running", "course",
    "séance", "terrain",
  ],
  reunion: [
    "réunion", "reunion", "meeting", "présentiel", "visio", "conf",
    "appel", "call", "zoom", "rdv", "rendez-vous", "rencontre",
  ],
  urgence: [
    "urgent", "urgence", "asap", "rapidement", "help", "aide",
    "besoin", "au plus vite", "dès que",
  ],
  evenement: [
    "event", "événement", "soirée", "sortie", "fête", "party",
    "voyage", "trip", "hackathon", "datathon", "conférence",
    "séminaire", "workshop",
  ],
  action: [
    "action à", "peux-tu", "pourras-tu", "peux tu", "merci de",
    "il faut", "n'oublie pas", "to do", "todo", "rappel",
    "reminder", "deadline", "échéance", "date limite", "à faire",
    "pense à",
  ],
  logement: [
    "logement", "appart", "appartement", "coloc", "colocation",
    "loyer", "chambre", "résidence", "hébergement", "housing", "rent",
  ],
  bourse: [
    "bourse", "scholarship", "financement", "aide financière",
    "subvention", "grant", "fellowship",
  ],
  annonce: [
    "annonce", "annoncé", "communiqué", "info", "rappel",
    "important", "attention", "note",
  ],
};

/** Expand a user query to related keywords. Returns [original, ...expanded] (deduped, lowercase). */
function _expandQuery(query: string): string[] {
  const lower = query.toLowerCase().trim();
  const keywords = new Set<string>([lower]);

  for (const [topic, expansions] of Object.entries(TOPIC_EXPANSIONS)) {
    const matched =
      lower.includes(topic) ||
      expansions.some((e) => lower.includes(e));
    if (matched) {
      for (const e of expansions) keywords.add(e);
    }
  }

  return Array.from(keywords);
}

/** Collect all JIDs from all watchlists (store + config fallback). */
function _allWatchlistJids(store: any, config: any) {
  const storeWLs = store.listWatchlists();
  const configWLs = config?.watchlists || {};
  const merged = { ...configWLs, ...storeWLs };
  const jidSet = new Set<string>();
  for (const jids of Object.values(merged) as string[][]) {
    for (const jid of jids) jidSet.add(phoneToJid(jid));
  }
  return { jidSet, merged };
}

export default [
  {
    meta: {
      action: "whatsup",
      category: "overview",
      description:
        "FULL 7-DAY WHATSAPP OVERVIEW — call when the user asks 'what's up', 'quoi de neuf', 'résume ma journée WhatsApp', 'qu'est-ce que j'ai manqué', 'donne-moi un résumé', or any similar request about WhatsApp activity. Returns ALL messages from the last 7 days, split into two time bands (recent_24h and older_7d). Group chats show only incoming messages (fromMe === false). Individual chats show all messages, split into 'needs_reply' (last incoming message unanswered) and 'others' sub-groups. No message limits — complete data returned.",
      arguments: [
        { name: "since", description: "Override start Unix timestamp. Default: now - 7 days.", required: false },
        { name: "until", description: "Override end Unix timestamp. Default: now.", required: false },
        { name: "watchlists", description: "Only show these watchlists (default: all).", required: false },
        { name: "limit_per_chat", description: "Ignored — no limits applied.", required: false },
      ],
      example: {},
      returns: "{ date, period, groups: { recent_24h, older_7d }, individual: { recent_24h: { needs_reply, others }, older_7d: { needs_reply, others } }, summary }",
    },
    handler: async ({ since, until, watchlists: wlFilter, limit_per_chat: _limitIgnored }, { store, config }) => {
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;
      const sevenDaysAgo = now - 7 * 86400;

      const effectiveSince = since !== undefined ? Number(since) : sevenDaysAgo;
      const effectiveUntil = until !== undefined ? Number(until) : now;

      // Watchlist resolution
      const storeWLs = store.listWatchlists();
      const configWLs = config?.watchlists || {};
      const allWLs = { ...configWLs, ...storeWLs };

      const activeWLs =
        Array.isArray(wlFilter) && wlFilter.length > 0
          ? Object.fromEntries(Object.entries(allWLs).filter(([n]) => (wlFilter as string[]).includes(n)))
          : allWLs;

      const jidToWatchlists = new Map<string, string[]>();
      for (const [wlName, jids] of Object.entries(activeWLs) as [string, string[]][]) {
        for (const rawJid of jids) {
          const jid = phoneToJid(rawJid);
          if (!jidToWatchlists.has(jid)) jidToWatchlists.set(jid, []);
          jidToWatchlists.get(jid)!.push(wlName);
        }
      }
      const watchlistJidSet = new Set(jidToWatchlists.keys());

      // All JIDs with messages
      const allJids = new Set<string>(store.messages.keys());
      for (const jid of watchlistJidSet) allJids.add(jid);

      // Helper: format a message and add timestamp_human
      const fmt = (msg: Record<string, unknown>) => {
        const f = formatMessage(msg);
        if (!f) return null;
        return {
          id: f.id,
          timestamp: f.timestamp,
          timestamp_human: f.timestamp
            ? new Date(f.timestamp * 1000).toLocaleString("fr-FR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : null,
          from_me: f.from_me,
          sender: f.sender,
          sender_name: f.push_name || null,
          text: f.text,
          type: f.type,
        };
      };

      // Type for formatted messages
      type FmtMsg = NonNullable<ReturnType<typeof fmt>>;

      // Sort messages oldest-first
      const ascTime = (a: FmtMsg, b: FmtMsg) =>
        (a.timestamp || 0) - (b.timestamp || 0);

      // Result containers
      const groupRecent: { jid: string; name: string; messages: any[] }[] = [];
      const groupOlder: { jid: string; name: string; messages: any[] }[] = [];

      const indRecent: { needs_reply: any[]; others: any[] } = { needs_reply: [], others: [] };
      const indOlder: { needs_reply: any[]; others: any[] } = { needs_reply: [], others: [] };

      const filterOpts = {
        since: effectiveSince,
        until: effectiveUntil,
        excludeTypes: ["protocol", "reaction"],
      };

      let totalMessages = 0;
      let totalChats = 0;

      for (const jid of allJids) {
        if (jid === "status@broadcast") continue;

        const isGroup = isGroupJid(jid);
        const chat = store.getChat(jid);
        const contact = store.getContact(jid);
        const chatName = chat?.name || chat?.subject || contact?.name || contact?.notify || jid;

        // Fetch ALL messages (no limit)
        const rawMsgs = store.getMessages(jid, 99999, undefined, filterOpts);
        if (rawMsgs.length === 0) continue;

        totalChats++;

        if (isGroup) {
          // Groups: only incoming messages (fromMe === false)
          const incoming = rawMsgs.filter((m) => m.key?.fromMe === false);
          const recent24 = incoming
            .filter((m) => (m.messageTimestamp || 0) >= oneDayAgo)
            .map(fmt)
            .filter(Boolean) as FmtMsg[];
          const older7d = incoming
            .filter((m) => (m.messageTimestamp || 0) < oneDayAgo)
            .map(fmt)
            .filter(Boolean) as FmtMsg[];
          recent24.sort(ascTime);
          older7d.sort(ascTime);

          totalMessages += recent24.length + older7d.length;

          if (recent24.length > 0) {
            groupRecent.push({ jid, name: chatName, messages: recent24 });
          }
          if (older7d.length > 0) {
            groupOlder.push({ jid, name: chatName, messages: older7d });
          }
        } else {
          // Individual: all messages (sent + received)
          const formatted = rawMsgs.map(fmt).filter(Boolean) as FmtMsg[];

          // Determine needs_reply: last message in chat (newest) where fromMe === false
          // Messages are fetched DESC, so rawMsgs[0] is newest
          const lastIncoming = formatted.find((m) => m.from_me === false);
          const lastOverall = formatted[0]; // newest first (DESC order from store)
          const needsReply = lastOverall && !lastOverall.from_me;

          // Classify into bands
          const recentMsgs = formatted.filter(
            (m) => (m.timestamp || 0) >= oneDayAgo,
          );
          const olderMsgs = formatted.filter(
            (m) => (m.timestamp || 0) < oneDayAgo,
          );

          totalMessages += formatted.length;

          const buildChatEntry = (msgs: any[]) => ({
            jid,
            name: chatName,
            messages: msgs.sort(ascTime),
          });

          const buildNeedsReplyEntry = (msgs: any[]) => ({
            jid,
            name: chatName,
            last_message: lastIncoming || null,
            messages: msgs.sort(ascTime),
          });

          // recent_24h
          if (needsReply && recentMsgs.length > 0) {
            indRecent.needs_reply.push(buildNeedsReplyEntry(recentMsgs));
          } else if (recentMsgs.length > 0) {
            indRecent.others.push(buildChatEntry(recentMsgs));
          }

          // older_7d
          if (needsReply && olderMsgs.length > 0) {
            indOlder.needs_reply.push(buildNeedsReplyEntry(olderMsgs));
          } else if (olderMsgs.length > 0) {
            indOlder.others.push(buildChatEntry(olderMsgs));
          }
        }
      }

      // Sort group lists by most recent message time (desc)
      const sortByLastMsgDesc = (arr: { messages: any[] }[]) =>
        arr.sort(
          (a, b) =>
            (b.messages[b.messages.length - 1]?.timestamp || 0) -
            (a.messages[a.messages.length - 1]?.timestamp || 0),
        );
      sortByLastMsgDesc(groupRecent);
      sortByLastMsgDesc(groupOlder);

      // Sort individual sub-groups by most recent message time (desc)
      const sortIndiv = (arr: { last_message?: any; messages: any[] }[]) =>
        arr.sort(
          (a, b) =>
            (b.messages[b.messages.length - 1]?.timestamp || 0) -
            (a.messages[a.messages.length - 1]?.timestamp || 0),
        );
      sortIndiv(indRecent.needs_reply);
      sortIndiv(indRecent.others);
      sortIndiv(indOlder.needs_reply);
      sortIndiv(indOlder.others);

      return okResult({
        date: new Date().toLocaleDateString("fr-FR"),
        period: {
          since: effectiveSince,
          until: effectiveUntil,
          from: new Date(effectiveSince * 1000).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          to: new Date(effectiveUntil * 1000).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        groups: {
          recent_24h: groupRecent,
          older_7d: groupOlder,
        },
        individual: {
          recent_24h: indRecent,
          older_7d: indOlder,
        },
        summary: {
          total_chats: totalChats,
          total_messages: totalMessages,
          groups_recent: groupRecent.length,
          groups_older: groupOlder.length,
          individual_needs_reply_24h: indRecent.needs_reply.length,
          individual_needs_reply_7d: indOlder.needs_reply.length,
          individual_others_24h: indRecent.others.length,
          individual_others_7d: indOlder.others.length,
        },
      });
    },
    schema: whatsupSchema,
    docstring: `FULL 7-DAY WHATSAPP OVERVIEW — returns ALL messages from the last 7 days, split into two time bands (recent_24h, older_7d). No message limits.

Parameters:
    - since (optional): Override start Unix timestamp. Default: now - 7 days.
    - until (optional): Override end Unix timestamp. Default: now.
    - watchlists (optional): Only show these watchlists (default: all).
    - limit_per_chat (optional): Ignored — no limits applied.

Structure:
    groups.recent_24h / groups.older_7d: group chats with incoming messages (fromMe === false), chronological (oldest first).
    individual.recent_24h / individual.older_7d: split into needs_reply (last message incoming, unanswered) and others.

Examples:
    - Get full 7-day overview:
        \`whats-proxy do whatsup '{}'\`
    - Overview with watchlist filter:
        \`whats-proxy do whatsup '{"watchlists":["work"]}'\``,
  },
  {
    meta: {
      action: "find-messages",
      category: "overview",
      description:
        "SMART SEMANTIC MESSAGE SEARCH — call when the user asks about specific topics: 'y a-t-il des messages sur l'IA', 'des offres de stage', 'des attentes pour moi', 'des actions à faire', 'des events à venir', 'des urgences', 'what about jobs'. Performs intelligent multi-keyword search with automatic topic expansion: 'ia' also searches for 'machine learning', 'LLM', 'GPT', etc. Results are ALWAYS prioritized: watchlist chats first. Groups results by chat.",
      arguments: [
        { name: "query", description: "Topic or question to search for (French or English). Examples: 'IA', 'stage', 'offres emploi', 'urgence', 'events'.", required: true },
        { name: "since", description: "Optional: only include messages after this Unix timestamp.", required: false },
        { name: "until", description: "Optional: only include messages before this Unix timestamp.", required: false },
        { name: "limit", description: "Max total results (default: 80, max: 300).", required: false },
        { name: "watchlist_only", description: "If true, restrict search to watchlist chats only.", required: false },
      ],
      example: { query: "IA" },
      returns: "{ query, expanded_keywords, total_messages, total_chats, watchlist_matches, chats }",
    },
    handler: async ({ query, since, until, limit, watchlist_only }, { store, config }) => {
      if (!query || !String(query).trim()) {
        return errResult("Parameter 'query' is required.");
      }

      const capped = Math.min(Number(limit) || 80, 300);
      const opts = {
        since: since !== undefined ? Number(since) : undefined,
        until: until !== undefined ? Number(until) : undefined,
      };

      const { jidSet: watchlistJidSet } = _allWatchlistJids(store, config);

      const keywords = _expandQuery(String(query));

      // Phase 1: TF-IDF analytics search with expanded query
      const expandedQuery = keywords.join(" ");
      const analyticsResults: any[] = store.analyticsSearch(expandedQuery, null, capped, opts);

      // Phase 2: plain text fallback for original query
      const textResults: any[] = store.searchMessages(String(query), null, Math.floor(capped / 2), opts);

      // Merge: analytics first, then add text-only misses
      const seenIds = new Set<string>(analyticsResults.map((r) => r.id));
      const allResults = [...analyticsResults];
      for (const r of textResults) {
        if (!seenIds.has(r.id)) {
          allResults.push({ ...r, score: 0.3, matched_terms: [query] });
          seenIds.add(r.id);
        }
      }

      let filtered = watchlist_only
        ? allResults.filter((r) => watchlistJidSet.has(r.from))
        : allResults;

      filtered.sort((a, b) => {
        const aWL = watchlistJidSet.has(a.from) ? 1 : 0;
        const bWL = watchlistJidSet.has(b.from) ? 1 : 0;
        if (aWL !== bWL) return bWL - aWL;
        if (b.score !== a.score) return b.score - a.score;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      filtered = filtered.slice(0, capped);

      // Group by chat JID
      const byChat = new Map<string, any>();
      for (const r of filtered) {
        const chatJid = r.from; // formatMessage sets from = key.remoteJid = chat JID
        if (!byChat.has(chatJid)) {
          const chat = store.getChat(chatJid);
          const contact = store.getContact(chatJid);
          byChat.set(chatJid, {
            jid: chatJid,
            name: chat?.name || chat?.subject || contact?.name || contact?.notify || chatJid,
            is_group: isGroupJid(chatJid),
            in_watchlist: watchlistJidSet.has(chatJid),
            messages: [],
          });
        }
        byChat.get(chatJid)!.messages.push({
          id: r.id,
          timestamp: r.timestamp,
          from_me: r.from_me,
          participant: r.participant,
          push_name: r.push_name,
          type: r.type,
          text: r.text,
          matched_keywords: r.matched_terms || [query],
        });
      }

      const chatResults = Array.from(byChat.values()).sort((a, b) => {
        if (a.in_watchlist !== b.in_watchlist) return b.in_watchlist ? 1 : -1;
        return b.messages.length - a.messages.length;
      });

      return okResult({
        query,
        expanded_keywords: keywords.length > 1 ? keywords.slice(1) : [],
        total_messages: filtered.length,
        total_chats: chatResults.length,
        watchlist_matches: chatResults.filter((c) => c.in_watchlist).length,
        chats: chatResults,
      });
    },
    schema: findMessagesSchema,
    docstring: `SMART SEMANTIC MESSAGE SEARCH — intelligent multi-keyword search with automatic topic expansion.

Parameters:
    - query (required): Topic or question to search for (French or English).
    - since (optional): Only include messages after this Unix timestamp.
    - until (optional): Only include messages before this Unix timestamp.
    - limit (optional): Max total results (default: 80, max: 300).
    - watchlist_only (optional): If true, restrict search to watchlist chats only.

Examples:
    - Search for AI-related messages:
        \`whats-proxy do find-messages '{"query":"IA"}'\`
        → {"query":"IA","expanded_keywords":["ia","intelligence artificielle","ai","machine learning","llm","gpt"],"total_messages":12,"total_chats":4,"watchlist_matches":2,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project","messages":[{"id":"MSG001","text":"L'IA avance vite","matched_keywords":["ia","ai"]}]}]}
    - Search for job offers:
        \`whats-proxy do find-messages '{"query":"offres emploi","since":1786550400}'\`
        → {"query":"offres emploi","expanded_keywords":["offre","emploi","job","poste","cdi"],"total_messages":8,"total_chats":3,"watchlist_matches":1,"chats":[]}
    - Watchlist-only search:
        \`whats-proxy do find-messages '{"query":"urgence","watchlist_only":true}'\`
        → {"query":"urgence","expanded_keywords":["urgent","urgence","asap","help"],"total_messages":3,"total_chats":2,"watchlist_matches":2,"chats":[{"jid":"33612345678","name":"Alice","messages":[{"id":"MSG002","text":"Urgent: need reply ASAP","matched_keywords":["urgence","urgent"]}]}]}`,
  },
] satisfies ActionDef[];
