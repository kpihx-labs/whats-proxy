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
        "DAILY WHATSAPP OVERVIEW — call when the user asks 'what's up', 'quoi de neuf', 'résume ma journée WhatsApp', 'qu'est-ce que j'ai manqué', 'donne-moi un résumé', or any similar request about today's WhatsApp activity. Returns a complete structured overview from midnight today to now: (1) watchlist chats first with all today's messages; (2) other active chats; (3) needs-reply chats where the last message is incoming.",
      arguments: [
        { name: "since", description: "Start Unix timestamp. Default: midnight today.", required: false },
        { name: "until", description: "End Unix timestamp. Default: now.", required: false },
        { name: "watchlists", description: "Only show these watchlists (default: all).", required: false },
        { name: "limit_per_chat", description: "Max messages per chat (default: 50, max: 200).", required: false },
      ],
      example: {},
      returns: "{ date, period, summary, watchlist_chats, other_chats, needs_reply }",
    },
    handler: async ({ since, until, watchlists: wlFilter, limit_per_chat }, { store, config }) => {
      const now = Math.floor(Date.now() / 1000);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const effectiveSince = since !== undefined ? Number(since) : Math.floor(todayStart.getTime() / 1000);
      const effectiveUntil = until !== undefined ? Number(until) : now;
      const lim = Math.min(Number(limit_per_chat) || 50, 200);

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

      const filterOpts = {
        since: effectiveSince,
        until: effectiveUntil,
        excludeTypes: ["protocol", "reaction"],
      };

      const watchlistChats: any[] = [];
      const otherChats: any[] = [];
      const needsReplyChats: any[] = [];

      const allJids = new Set<string>(store.messages.keys());
      for (const jid of watchlistJidSet) allJids.add(jid);

      for (const jid of allJids) {
        if (jid === "status@broadcast") continue;

        const messages = store.getMessages(jid, lim, undefined, filterOpts);
        const formatted = messages.map(formatMessage).filter(Boolean);
        if (formatted.length === 0) continue;

        const chat = store.getChat(jid);
        const contact = store.getContact(jid);
        const chatName =
          chat?.name || chat?.subject || contact?.name || contact?.notify || jid;

        const recent = store.getMessages(jid, 3, undefined, { excludeTypes: ["protocol", "reaction"] });
        const recentFormatted = recent.map(formatMessage).filter(Boolean);
        const lastMsg = recentFormatted[0]; // newest first
        const needsReply = !!lastMsg && !lastMsg.from_me;

        const chatData: Record<string, unknown> = {
          jid,
          name: chatName,
          is_group: isGroupJid(jid),
          unread: chat?.unreadCount || 0,
          message_count: formatted.length,
          needs_reply: needsReply,
          last_message_time: formatted[0]?.timestamp || null,
          messages: formatted,
        };

        if (watchlistJidSet.has(jid)) {
          chatData.watchlists = jidToWatchlists.get(jid);
          watchlistChats.push(chatData);
        } else {
          otherChats.push(chatData);
        }

        if (needsReply) {
          needsReplyChats.push({
            jid,
            name: chatName,
            is_group: isGroupJid(jid),
            in_watchlist: watchlistJidSet.has(jid),
            last_message: lastMsg,
          });
        }
      }

      const byTime = (a: any, b: any) => (b.last_message_time || 0) - (a.last_message_time || 0);
      watchlistChats.sort(byTime);
      otherChats.sort(byTime);
      needsReplyChats.sort((a: any, b: any) => {
        if (a.in_watchlist !== b.in_watchlist) return b.in_watchlist ? 1 : -1;
        return (b.last_message?.timestamp || 0) - (a.last_message?.timestamp || 0);
      });

      const totalMessages =
        watchlistChats.reduce((s: number, c: any) => s + c.message_count, 0) +
        otherChats.reduce((s: number, c: any) => s + c.message_count, 0);

      return okResult({
        date: new Date().toLocaleDateString("fr-FR"),
        period: {
          since: effectiveSince,
          until: effectiveUntil,
          from: new Date(Number(effectiveSince) * 1000).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          to: new Date(Number(effectiveUntil) * 1000).toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        summary: {
          total_active_chats: watchlistChats.length + otherChats.length,
          watchlist_chats: watchlistChats.length,
          other_chats: otherChats.length,
          total_messages: totalMessages,
          needs_reply_count: needsReplyChats.length,
        },
        watchlist_chats: watchlistChats,
        other_chats: otherChats,
        needs_reply: needsReplyChats,
      });
    },
    schema: whatsupSchema,
    docstring: `DAILY WHATSAPP OVERVIEW — returns a complete structured overview from midnight today to now.

Parameters:
    - since (optional): Start Unix timestamp. Default: midnight today.
    - until (optional): End Unix timestamp. Default: now.
    - watchlists (optional): Only show these watchlists (default: all).
    - limit_per_chat (optional): Max messages per chat (default: 50, max: 200).

Examples:
    - Get today's overview:
        \`whats-proxy do whatsup '{}'\`
        → {"date":"30/08/2026","period":{"since":1756550400,"until":1756614000},"summary":{"total_active_chats":12,"watchlist_chats":3,"other_chats":9,"total_messages":156,"needs_reply_count":4},"watchlist_chats":[{"jid":"120363000000000@g.us","name":"X24 Project","message_count":45,"needs_reply":true}],"other_chats":[],"needs_reply":[{"jid":"33612345678","name":"Alice","last_message":{"text":"Are you available?","from_me":false}}]}
    - Overview for a specific watchlist:
        \`whats-proxy do whatsup '{"watchlists":["work"]}'\`
        → {"date":"30/08/2026","summary":{"total_active_chats":5,"watchlist_chats":2,"other_chats":3,"total_messages":89,"needs_reply_count":1}}
    - Overview with custom time range:
        \`whats-proxy do whatsup '{"since":1756580000,"until":1756614000}'\`
        → {"date":"30/08/2026","period":{"since":1756580000,"until":1756614000},"summary":{"total_active_chats":8,"watchlist_chats":2,"other_chats":6,"total_messages":67,"needs_reply_count":2}}`,
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
