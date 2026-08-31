/**
 * whats-proxy — In-memory Store (TypeScript port of whats-mcp `store.js`).
 *
 * Captures Baileys events to maintain a searchable cache of chats, contacts,
 * messages, group metadata, contact tags, watchlists, and a lazily built
 * analytics index. Persists to a JSON snapshot and restores on load.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatMessage, isGroupJid } from "./helpers";

const ANALYTICS_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "des", "du", "en", "est",
  "et", "for", "how", "il", "in", "is", "je", "la", "le", "les", "mais", "of", "on",
  "or", "ou", "pour", "que", "qui", "the", "to", "tu", "un", "une", "vous", "with",
]);

export interface StoreOptions {
  max_messages_per_chat?: number;
  max_chats?: number;
  onChange?: () => void;
}

// Minimal structural types (Baileys internals are deeply nested — kept loose).
export type AnyMsg = Record<string, any>;
export type AnyChat = Record<string, any>;
export type AnyContact = Record<string, any>;
export type AnyGroupMeta = Record<string, any>;

interface MessageFilters {
  since?: number;
  until?: number;
  types?: string[];
  excludeTypes?: string[];
}

export class Store {
  maxMessagesPerChat: number;
  maxChats: number;
  onChange: (() => void) | null;

  chats = new Map<string, AnyChat>();
  contacts = new Map<string, AnyContact>();
  messages = new Map<string, AnyMsg[]>();
  groupMeta = new Map<string, AnyGroupMeta>();
  messageIndex = new Map<string, AnyMsg>();
  contactTags = new Map<string, string[]>();
  watchlists = new Map<string, string[]>();
  /** LID ↔ PN mappings: LID JID → { pn, name } */
  lidPnMap = new Map<string, { pn: string; name?: string }>();

  private analyticsCache: any = null;

  constructor(opts: StoreOptions = {}) {
    this.maxMessagesPerChat = opts.max_messages_per_chat || 500;
    this.maxChats = opts.max_chats || 1000;
    this.onChange = typeof opts.onChange === "function" ? opts.onChange : null;
  }

  // ── Chat operations ──────────────────────────────────────────────────────

  upsertChats(chats: AnyChat[]) {
    for (const chat of chats) {
      const existing = this.chats.get(chat.id) || {};
      this.chats.set(chat.id, { ...existing, ...chat });
    }
    this._trimChats();
    this._notifyChanged();
  }

  updateChats(updates: AnyChat[]) {
    for (const update of updates) {
      const existing = this.chats.get(update.id);
      if (existing) Object.assign(existing, update);
    }
    this._notifyChanged();
  }

  deleteChats(ids: string[]) {
    for (const id of ids) {
      this.chats.delete(id);
      this.messages.delete(id);
    }
    this._notifyChanged();
  }

  getChat(jid: string): AnyChat | null {
    return this.chats.get(jid) || null;
  }

  listChats(limit = 50, offset = 0): AnyChat[] {
    const all = Array.from(this.chats.values());
    all.sort((a, b) => {
      const ta = Number(a.conversationTimestamp || 0);
      const tb = Number(b.conversationTimestamp || 0);
      return tb - ta;
    });
    return all.slice(offset, offset + limit);
  }

  // ── Contact operations ───────────────────────────────────────────────────

  upsertContacts(contacts: AnyContact[]) {
    for (const contact of contacts) {
      const jid = contact.id;
      if (!jid) continue;
      const existing = this.contacts.get(jid) || {};
      this.contacts.set(jid, { ...existing, ...contact });
    }
    this._notifyChanged();
  }

  updateContacts(updates: AnyContact[]) {
    for (const update of updates) {
      const jid = update.id;
      if (!jid) continue;
      const existing = this.contacts.get(jid);
      if (existing) Object.assign(existing, update);
    }
    this._notifyChanged();
  }

  getContact(jid: string): AnyContact | null {
    return this.contacts.get(jid) || null;
  }

  listContacts(options: { name?: string; tag?: string; has_tags?: boolean } = {}): AnyContact[] {
    let contacts = Array.from(this.contacts.values());
    if (options.name) {
      const lower = options.name.toLowerCase();
      contacts = contacts.filter((c) => {
        const name = (c.name || c.notify || c.verifiedName || c.short || "").toLowerCase();
        return name.includes(lower);
      });
    }
    if (options.tag) {
      const taggedJids = new Set(this.listByTag(options.tag));
      contacts = contacts.filter((c) => taggedJids.has(c.id));
    }
    if (options.has_tags !== undefined) {
      contacts = options.has_tags
        ? contacts.filter((c) => (this.contactTags.get(c.id) || []).length > 0)
        : contacts.filter((c) => (this.contactTags.get(c.id) || []).length === 0);
    }
    return contacts;
  }

  // ── Contact tags ─────────────────────────────────────────────────────────

  setContactTags(jid: string, tags: string[]) {
    this.contactTags.set(jid, [...new Set(tags)]);
    this._notifyChanged();
  }

  addContactTags(jid: string, tags: string[]) {
    const existing = this.contactTags.get(jid) || [];
    this.contactTags.set(jid, [...new Set([...existing, ...tags])]);
    this._notifyChanged();
  }

  removeContactTags(jid: string, tags: string[]) {
    const existing = this.contactTags.get(jid) || [];
    const filtered = existing.filter((t) => !tags.includes(t));
    if (filtered.length > 0) this.contactTags.set(jid, filtered);
    else this.contactTags.delete(jid);
    this._notifyChanged();
  }

  getContactTags(jid: string): string[] {
    return this.contactTags.get(jid) || [];
  }

  listByTag(tag: string): string[] {
    const results: string[] = [];
    for (const [jid, tags] of this.contactTags) {
      if (tags.includes(tag)) results.push(jid);
    }
    return results;
  }

  getAllTags(): string[] {
    const tags = new Set<string>();
    for (const tagList of this.contactTags.values()) {
      for (const t of tagList) tags.add(t);
    }
    return Array.from(tags).sort();
  }

  // ── Watchlist operations ──────────────────────────────────────────────────

  setWatchlist(name: string, jids: string[]) {
    this.watchlists.set(name, [...new Set(jids)]);
    this._notifyChanged();
  }

  addToWatchlist(name: string, jids: string[]) {
    const existing = this.watchlists.get(name) || [];
    this.watchlists.set(name, [...new Set([...existing, ...jids])]);
    this._notifyChanged();
  }

  removeFromWatchlist(name: string, jids: string[]) {
    const existing = this.watchlists.get(name) || [];
    const jidSet = new Set(jids);
    const filtered = existing.filter((j) => !jidSet.has(j));
    if (filtered.length > 0) this.watchlists.set(name, filtered);
    else this.watchlists.delete(name);
    this._notifyChanged();
  }

  deleteWatchlist(name: string): boolean {
    const existed = this.watchlists.has(name);
    this.watchlists.delete(name);
    if (existed) this._notifyChanged();
    return existed;
  }

  getWatchlist(name: string): string[] | null {
    return this.watchlists.get(name) || null;
  }

  listWatchlists(): Record<string, string[]> {
    return Object.fromEntries(this.watchlists);
  }

  /** Resolve a watchlist name → JID array. Store first, then config fallback. */
  resolveWatchlist(name: string, configWatchlists: Record<string, string[]> = {}): string[] | null {
    return this.watchlists.get(name) || configWatchlists[name] || null;
  }

  /** One-time bootstrap: import config watchlists missing from the store. */
  importWatchlistsFromConfig(configWatchlists: Record<string, string[]> = {}): number {
    let imported = 0;
    for (const [name, jids] of Object.entries(configWatchlists)) {
      if (Array.isArray(jids) && !this.watchlists.has(name)) {
        this.watchlists.set(name, [...new Set(jids)]);
        imported++;
      }
    }
    if (imported > 0) this._notifyChanged();
    return imported;
  }

  // ── Message operations ───────────────────────────────────────────────────

  upsertMessages(messages: AnyMsg[]) {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid) continue;

      this._touchChatFromMessage(msg);

      if (!this.messages.has(jid)) this.messages.set(jid, []);
      const arr = this.messages.get(jid)!;

      const existing = arr.findIndex((m) => m.key?.id === msg.key?.id);
      if (existing >= 0) arr[existing] = msg;
      else arr.push(msg);

      if (msg.key?.id) this.messageIndex.set(msg.key.id, msg);

      arr.sort((a, b) => {
        const ta = Number(a.messageTimestamp || 0);
        const tb = Number(b.messageTimestamp || 0);
        if (ta !== tb) return ta - tb;
        return String(a.key?.id || "").localeCompare(String(b.key?.id || ""));
      });

      if (arr.length > this.maxMessagesPerChat) {
        const removed = arr.splice(0, arr.length - this.maxMessagesPerChat);
        for (const r of removed) {
          if (r.key?.id) this.messageIndex.delete(r.key.id);
        }
      }
    }
    this._notifyChanged();
  }

  deleteMessages(keys: { remoteJid: string; id: string }[]) {
    for (const key of keys) {
      const arr = this.messages.get(key.remoteJid);
      if (arr) {
        const idx = arr.findIndex((m) => m.key?.id === key.id);
        if (idx >= 0) arr.splice(idx, 1);
      }
      this.messageIndex.delete(key.id);
    }
    this._notifyChanged();
  }

  getMessages(jid: string, limit = 50, before_id?: string, options: MessageFilters = {}): AnyMsg[] {
    const arr = this.messages.get(jid) || [];
    let result = [...arr];

    result.sort((a, b) => {
      const ta = Number(a.messageTimestamp || 0);
      const tb = Number(b.messageTimestamp || 0);
      return tb - ta;
    });

    if (before_id) {
      const idx = result.findIndex((m) => m.key?.id === before_id);
      if (idx >= 0) result = result.slice(idx + 1);
    }

    result = this._applyMessageFilters(result, options);
    return result.slice(0, limit);
  }

  countMessages(jid: string): number {
    return (this.messages.get(jid) || []).length;
  }

  getOldestMessage(jid: string): AnyMsg | null {
    const arr = this.messages.get(jid) || [];
    if (arr.length === 0) return null;
    return (
      [...arr].sort((a, b) => {
        const ta = Number(a.messageTimestamp || 0);
        const tb = Number(b.messageTimestamp || 0);
        return ta - tb;
      })[0] || null
    );
  }

  getMessage(id: string): AnyMsg | null {
    return this.messageIndex.get(id) || null;
  }

  searchMessages(
    query: string,
    jid: string | string[] | null,
    limit = 20,
    options: MessageFilters = {},
  ): ReturnType<typeof formatMessage>[] {
    const lower = query.toLowerCase();
    const results: ReturnType<typeof formatMessage>[] = [];

    let chatJids: string[];
    if (Array.isArray(jid)) chatJids = jid;
    else if (jid) chatJids = [jid];
    else chatJids = Array.from(this.messages.keys());

    for (const chatJid of chatJids) {
      let msgs = this.messages.get(chatJid) || [];
      msgs = this._applyMessageFilters(msgs, options);
      for (const msg of msgs) {
        if (results.length >= limit) break;
        const formatted = formatMessage(msg);
        if (formatted && formatted.text.toLowerCase().includes(lower)) {
          results.push(formatted);
        }
      }
      if (results.length >= limit) break;
    }

    return results;
  }

  // ── Group metadata cache ─────────────────────────────────────────────────

  setGroupMeta(jid: string, meta: AnyGroupMeta) {
    this.groupMeta.set(jid, meta);
    if (Array.isArray(meta?.participants) && meta.participants.length > 0) {
      this.upsertContacts(
        meta.participants
          .filter((p: AnyContact) => p?.id)
          .map((p: AnyContact) => ({ id: p.id, admin: p.admin || null })),
      );
    }
    const chat = this.chats.get(jid) || { id: jid };
    this.chats.set(jid, {
      ...chat,
      id: jid,
      name: meta?.subject || chat.name,
      subject: meta?.subject || chat.subject,
      conversationTimestamp:
        Number(chat.conversationTimestamp || 0) ||
        Number(meta?.subjectTime || 0) ||
        Number(meta?.creation || 0) ||
        undefined,
    });
    this._trimChats();
    this._notifyChanged();
  }

  getGroupMeta(jid: string): AnyGroupMeta | null {
    return this.groupMeta.get(jid) || null;
  }

  // ── LID resolution ────────────────────────────────────────────────────────

  /** Resolve a LID JID to its phone number. Returns null if no mapping. */
  resolveLidToPhone(lid: string): string | null {
    return this.lidPnMap.get(lid)?.pn || null;
  }

  /** Resolve a contact JID to a display name. Tries contact name → chat name → LID mapping. */
  resolveContactName(jid: string): string | null {
    // 1. Direct contact lookup
    const contact = this.contacts.get(jid);
    const contactName = contact?.name || contact?.notify || contact?.verifiedName;
    if (contactName) return contactName;

    // 2. Chat name lookup (pushName from last message)
    const chat = this.chats.get(jid);
    const chatName = chat?.name || chat?.pushName;
    if (chatName) return chatName;

    // 3. LID → PN → contact name
    if (jid.endsWith("@lid")) {
      const mapping = this.lidPnMap.get(jid);
      if (mapping?.pn) {
        const pnContact = this.contacts.get(mapping.pn);
        const pnName = pnContact?.name || pnContact?.notify || mapping.name;
        if (pnName) return pnName;
        const pnChat = this.chats.get(mapping.pn);
        if (pnChat?.name) return pnChat.name;
      }
    }

    return null;
  }

  // ── History sync ─────────────────────────────────────────────────────────

  /** Handle the `messaging-history.set` event. */
  handleHistorySync({ chats, contacts, messages, lidPnMappings }: {
    chats?: AnyChat[];
    contacts?: AnyContact[];
    messages?: AnyMsg[];
    lidPnMappings?: { lid: string; pn: string }[];
  }) {
    if (chats) this.upsertChats(chats);
    if (contacts) {
      this.upsertContacts(contacts);
      // Extract LID→PN mappings from contacts that have both lid and phoneNumber
      for (const c of contacts) {
        if (c.lid && c.phoneNumber) {
          const existing = this.lidPnMap.get(c.lid);
          this.lidPnMap.set(c.lid, {
            pn: c.phoneNumber,
            name: c.name || c.notify || existing?.name || undefined,
          });
        }
        // Also store name from history sync contacts
        if (c.name && c.id) {
          const existing = this.contacts.get(c.id);
          if (existing && !existing.name) {
            existing.name = c.name;
          }
        }
      }
    }
    // Process LID↔PN mappings from the history sync payload
    if (lidPnMappings && Array.isArray(lidPnMappings)) {
      for (const mapping of lidPnMappings) {
        if (mapping.lid && mapping.pn) {
          const existing = this.lidPnMap.get(mapping.lid);
          this.lidPnMap.set(mapping.lid, { pn: mapping.pn, name: existing?.name });
        }
      }
    }
    if (messages) {
      const flat = messages.map((m) => m.message || m).filter(Boolean);
      this.upsertMessages(flat);
    }
    this._notifyChanged();
  }

  // ── Snapshot persistence ─────────────────────────────────────────────────

  saveSnapshot(filePath: string): boolean {
    try {
      const snapshot = {
        chats: Array.from(this.chats.values()),
        contacts: Array.from(this.contacts.values()),
        messages: Array.from(this.messages.entries()),
        groupMeta: Array.from(this.groupMeta.entries()),
        contactTags: Object.fromEntries(this.contactTags),
        watchlists: Object.fromEntries(this.watchlists),
        lidPnMap: Object.fromEntries(this.lidPnMap),
      };
      writeFileSync(filePath, JSON.stringify(snapshot), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  loadSnapshot(filePath: string): boolean {
    if (!existsSync(filePath)) return false;

    const snapshot = JSON.parse(readFileSync(filePath, "utf-8"));

    this.chats = new Map((snapshot.chats || []).map((chat: AnyChat) => [chat.id, chat]));
    this.contacts = new Map((snapshot.contacts || []).map((c: AnyContact) => [c.id, c]));
    this.messages = new Map<string, AnyMsg[]>(snapshot.messages || []);
    this.groupMeta = new Map(snapshot.groupMeta || []);
    this.contactTags = new Map(Object.entries(snapshot.contactTags || {}));
    this.watchlists = new Map(Object.entries(snapshot.watchlists || {}));
    this.lidPnMap = new Map(Object.entries(snapshot.lidPnMap || {}));
    this.messageIndex = new Map();

    for (const msgList of this.messages.values()) {
      msgList.sort((a, b) => {
        const ta = Number(a.messageTimestamp || 0);
        const tb = Number(b.messageTimestamp || 0);
        if (ta !== tb) return ta - tb;
        return String(a.key?.id || "").localeCompare(String(b.key?.id || ""));
      });
      for (const msg of msgList) {
        if (msg?.key?.id) this.messageIndex.set(msg.key.id, msg);
      }
    }

    this._trimChats();
    for (const [jid, arr] of this.messages.entries()) {
      if (arr.length > this.maxMessagesPerChat) {
        this.messages.set(jid, arr.slice(-this.maxMessagesPerChat));
      }
    }

    return true;
  }

  // ── Analytics ───────────────────────────────────────────────────────────

  getAnalyticsOverview(options: {
    top_chats?: number;
    top_tokens?: number;
    top_senders?: number;
    days?: number;
  } = {}) {
    const analytics = this._getAnalyticsCache();
    const topChats = Math.min(options.top_chats || 10, 100);
    const topTokens = Math.min(options.top_tokens || 20, 100);
    const topSenders = Math.min(options.top_senders || 10, 100);
    const days = Math.min(options.days || 30, 365);

    return {
      totals: analytics.totals,
      indexed_chats: analytics.chatSummaries.length,
      indexed_messages: analytics.totals.messages,
      active_days: analytics.dailyActivity.length,
      top_chats: analytics.chatSummaries.slice(0, topChats),
      top_tokens: analytics.topTokens.slice(0, topTokens),
      top_senders: analytics.topSenders.slice(0, topSenders),
      message_types: analytics.messageTypes,
      hourly_activity: analytics.hourlyActivity,
      daily_activity: analytics.dailyActivity.slice(-days),
    };
  }

  listAnalyticsTopChats(options: { limit?: number; sort_by?: string } = {}) {
    const analytics = this._getAnalyticsCache();
    const limit = Math.min(options.limit || 20, 200);
    const sortBy = options.sort_by || "message_count";
    const chats = [...analytics.chatSummaries];
    const sorters: Record<string, (a: any, b: any) => number> = {
      message_count: (a, b) =>
        (b.content_message_count - a.content_message_count) ||
        (b.message_count - a.message_count) ||
        (b.last_activity || 0) - (a.last_activity || 0),
      last_activity: (a, b) => (b.last_activity || 0) - (a.last_activity || 0),
      active_days: (a, b) =>
        (b.active_days - a.active_days) ||
        (b.content_message_count - a.content_message_count) ||
        (b.message_count - a.message_count),
      participants: (a, b) =>
        (b.participant_count - a.participant_count) ||
        (b.content_message_count - a.content_message_count) ||
        (b.message_count - a.message_count),
    };
    chats.sort(sorters[sortBy] || sorters.message_count);
    return chats.slice(0, limit);
  }

  getChatAnalytics(jid: string, options: {
    top_tokens?: number;
    top_senders?: number;
    days?: number;
    recent_messages?: number;
  } = {}) {
    const analytics = this._getAnalyticsCache();
    const chat = analytics.chatByJid.get(jid);
    if (!chat) return null;

    const topTokens = Math.min(options.top_tokens || 15, 100);
    const topSenders = Math.min(options.top_senders || 10, 100);
    const timelineDays = Math.min(options.days || 30, 365);

    return {
      ...chat,
      top_tokens: chat.top_tokens.slice(0, topTokens),
      top_senders: chat.top_senders.slice(0, topSenders),
      recent_messages: chat.recent_messages.slice(0, Math.min(options.recent_messages || 5, 20)),
      daily_activity: chat.daily_activity.slice(-timelineDays),
    };
  }

  getActivityTimeline(options: { jid?: string; days?: number } = {}) {
    const analytics = this._getAnalyticsCache();
    const days = Math.min(options.days || 30, 365);

    if (options.jid) {
      const chat = analytics.chatByJid.get(options.jid);
      if (!chat) return null;
      return {
        jid: options.jid,
        days,
        total_messages: chat.message_count,
        buckets: chat.daily_activity.slice(-days),
      };
    }

    return {
      days,
      total_messages: analytics.totals.messages,
      buckets: analytics.dailyActivity.slice(-days),
    };
  }

  analyticsSearch(query: string, jid: string | string[] | null, limit = 20, options: { since?: number; until?: number } = {}) {
    const analytics = this._getAnalyticsCache();
    const terms = this._tokenize(query);
    const cappedLimit = Math.min(limit || 20, 200);
    const { since, until } = options;

    if (terms.length === 0) return [];

    const jidSet = jid ? new Set(Array.isArray(jid) ? jid : [jid]) : null;

    const scores = new Map<string, { jid: string; id: string; matched_terms: Set<string>; score: number }>();
    for (const term of terms) {
      const refs = analytics.tokenIndex.get(term) || [];
      for (const ref of refs) {
        if (jidSet && !jidSet.has(ref.jid)) continue;
        const existing = scores.get(ref.id) || {
          jid: ref.jid,
          id: ref.id,
          matched_terms: new Set<string>(),
          score: 0,
        };
        existing.matched_terms.add(term);
        existing.score += ref.weight;
        scores.set(ref.id, existing);
      }
    }

    const ranked: Record<string, unknown>[] = [];
    for (const entry of scores.values()) {
      const msg = this.getMessage(entry.id);
      const formatted = formatMessage(msg);
      if (!formatted) continue;
      const ts = Number(formatted.timestamp || 0);
      if (since != null && ts < since) continue;
      if (until != null && ts > until) continue;
      const text = formatted.text.toLowerCase();
      const phraseBoost = text.includes(query.toLowerCase()) ? 2 : 0;
      const timestampBoost = formatted.timestamp ? Number(formatted.timestamp) / 1e10 : 0;
      ranked.push({
        ...formatted,
        score: Number((entry.score + phraseBoost + timestampBoost).toFixed(6)),
        matched_terms: Array.from(entry.matched_terms).sort(),
      });
    }

    ranked.sort((a: any, b: any) => (b.score - a.score) || ((b.timestamp || 0) - (a.timestamp || 0)));
    return ranked.slice(0, cappedLimit);
  }

  // ── Bind to Baileys events ───────────────────────────────────────────────

  /** Bind all relevant Baileys socket events to this store. */
  bind(sock: any) {
    sock.ev.on("messaging-history.set", (data: any) => this.handleHistorySync(data));
    sock.ev.on("chats.upsert", (chats: AnyChat[]) => this.upsertChats(chats));
    sock.ev.on("chats.update", (updates: AnyChat[]) => this.updateChats(updates));
    sock.ev.on("chats.delete", (ids: string[]) => this.deleteChats(ids));
    sock.ev.on("contacts.upsert", (contacts: AnyContact[]) => this.upsertContacts(contacts));
    sock.ev.on("contacts.update", (updates: AnyContact[]) => this.updateContacts(updates));
    sock.ev.on("messages.upsert", ({ messages }: { messages: AnyMsg[] }) => {
      this.upsertMessages(messages);
      // Capture pushName from incoming messages to resolve contact names
      for (const msg of messages) {
        if (msg.pushName && msg.key) {
          const jid = msg.key.remoteJid;
          if (jid) {
            const contact = this.contacts.get(jid);
            if (contact && !contact.notify) {
              contact.notify = msg.pushName;
            }
            // Also try LID → PN resolution
            if (jid.endsWith("@lid")) {
              const pn = this.lidPnMap.get(jid)?.pn;
              if (pn) {
                const pnContact = this.contacts.get(pn);
                if (pnContact && !pnContact.notify) {
                  pnContact.notify = msg.pushName;
                }
              }
            }
          }
        }
      }
    });
    sock.ev.on("messages.delete", (info: { keys?: { remoteJid: string; id: string }[] }) => {
      if (info.keys) this.deleteMessages(info.keys);
    });
    sock.ev.on("groups.upsert", (groups: AnyGroupMeta[]) => {
      for (const g of groups) this.setGroupMeta(g.id, g);
    });
    sock.ev.on("groups.update", (updates: AnyGroupMeta[]) => {
      for (const u of updates) {
        const existing = this.getGroupMeta(u.id) || {};
        this.setGroupMeta(u.id, { ...existing, ...u });
      }
    });
    // Capture LID↔PN mappings from Baileys
    sock.ev.on("lid-mapping.update", ({ lid, pn }: { lid: string; pn: string }) => {
      if (lid && pn) {
        const existing = this.lidPnMap.get(lid);
        this.lidPnMap.set(lid, { pn, name: existing?.name });
        this._notifyChanged();
      }
    });
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  stats() {
    let totalMessages = 0;
    for (const msgs of this.messages.values()) totalMessages += msgs.length;
    return {
      chats: this.chats.size,
      contacts: this.contacts.size,
      messages: totalMessages,
      groups: this.groupMeta.size,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _applyMessageFilters(messages: AnyMsg[], options: MessageFilters = {}): AnyMsg[] {
    const { since, until, types, excludeTypes } = options;
    let result = messages;

    if (since != null) result = result.filter((m) => Number(m.messageTimestamp || 0) >= since);
    if (until != null) result = result.filter((m) => Number(m.messageTimestamp || 0) <= until);
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      result = result.filter((m) => {
        const formatted = formatMessage(m);
        return formatted && typeSet.has(formatted.type);
      });
    }
    if (excludeTypes && excludeTypes.length > 0) {
      const excludeSet = new Set(excludeTypes);
      result = result.filter((m) => {
        const formatted = formatMessage(m);
        return formatted && !excludeSet.has(formatted.type);
      });
    }
    return result;
  }

  private _trimChats() {
    if (this.chats.size <= this.maxChats) return;
    const sorted = Array.from(this.chats.entries()).sort(([, a], [, b]) => {
      return Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0);
    });
    const toRemove = sorted.slice(this.maxChats);
    for (const [jid] of toRemove) this.chats.delete(jid);
  }

  private _notifyChanged() {
    this.analyticsCache = null;
    if (this.onChange) this.onChange();
  }

  private _touchChatFromMessage(msg: AnyMsg) {
    const jid = msg.key?.remoteJid;
    if (!jid) return;

    const existing = this.chats.get(jid) || { id: jid };
    const formatted = formatMessage(msg);
    const timestamp = msg.messageTimestamp
      ? Number(msg.messageTimestamp)
      : Number(existing.conversationTimestamp || 0);

    this.chats.set(jid, {
      ...existing,
      id: jid,
      conversationTimestamp: timestamp || existing.conversationTimestamp,
      name:
        existing.name ||
        existing.subject ||
        msg.pushName ||
        formatted?.push_name ||
        existing.name,
    });

    this._trimChats();
  }

  private _getAnalyticsCache() {
    if (this.analyticsCache) return this.analyticsCache;

    const tokenIndex = new Map<string, { jid: string; id: string; weight: number }[]>();
    const globalTokenCounts = new Map<string, number>();
    const globalSenderCounts = new Map<string, number>();
    const globalTypeCounts = new Map<string, number>();
    const globalDailyActivity = new Map<string, number>();
    const hourlyActivity = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    const chatByJid = new Map<string, any>();
    const allChatIds = new Set<string>([
      ...this.chats.keys(),
      ...this.messages.keys(),
      ...this.groupMeta.keys(),
    ]);

    for (const jid of allChatIds) chatByJid.set(jid, this._createEmptyChatAnalytics(jid));

    for (const [jid, msgs] of this.messages.entries()) {
      const chat = chatByJid.get(jid) || this._createEmptyChatAnalytics(jid);
      for (const msg of msgs) {
        const formatted = formatMessage(msg);
        if (!formatted) continue;

        const timestamp = Number(formatted.timestamp || msg.messageTimestamp || 0) || 0;
        chat.message_count += 1;
        if (formatted.from_me) chat.from_me_count += 1;
        else chat.external_count += 1;

        if (timestamp) {
          chat.first_activity = chat.first_activity === null ? timestamp : Math.min(chat.first_activity, timestamp);
          chat.last_activity = Math.max(chat.last_activity || 0, timestamp);
          const dayKey = this._toDayKey(timestamp);
          chat.daily_counts.set(dayKey, (chat.daily_counts.get(dayKey) || 0) + 1);
          globalDailyActivity.set(dayKey, (globalDailyActivity.get(dayKey) || 0) + 1);
          hourlyActivity[this._toHour(timestamp)]!.count += 1;
        }

        const type = formatted.type || "unknown";
        chat.type_counts.set(type, (chat.type_counts.get(type) || 0) + 1);
        globalTypeCounts.set(type, (globalTypeCounts.get(type) || 0) + 1);

        const sender = this._getMessageSender(msg);
        if (sender) {
          chat.sender_counts.set(sender, (chat.sender_counts.get(sender) || 0) + 1);
          globalSenderCounts.set(sender, (globalSenderCounts.get(sender) || 0) + 1);
        }

        const tokens = this._shouldIndexMessageText(formatted)
          ? this._tokenize(formatted.text)
          : [];
        if (tokens.length > 0) chat.content_message_count += 1;
        const uniqueTokens = new Set(tokens);
        for (const token of tokens) {
          chat.token_counts.set(token, (chat.token_counts.get(token) || 0) + 1);
          globalTokenCounts.set(token, (globalTokenCounts.get(token) || 0) + 1);
        }
        for (const token of uniqueTokens) {
          if (!tokenIndex.has(token)) tokenIndex.set(token, []);
          tokenIndex.get(token)!.push({
            jid,
            id: formatted.id as string,
            weight: chat.token_counts.get(token) || 1,
          });
        }
      }
      chatByJid.set(jid, chat);
    }

    for (const [jid, chat] of chatByJid.entries()) {
      const rawChat = this.getChat(jid) || {};
      const groupMeta = this.getGroupMeta(jid);
      chat.name = rawChat.name || rawChat.subject || groupMeta?.subject || chat.name;
      chat.is_group = isGroupJid(jid);
      chat.participant_count = groupMeta?.participants?.length || 0;
      chat.active_days = chat.daily_counts.size;
      chat.last_activity = chat.last_activity || Number(rawChat.conversationTimestamp || groupMeta?.subjectTime || groupMeta?.creation || 0) || null;
      chat.top_tokens = this._rankCountMap(chat.token_counts, 10);
      chat.top_senders = this._rankCountMap(chat.sender_counts, 10, "jid");
      chat.type_breakdown = this._rankCountMap(chat.type_counts, 10, "type");
      chat.daily_activity = this._mapToSeries(chat.daily_counts, "date");
      chat.recent_messages = this.getMessages(jid, 5).map((msg) => formatMessage(msg)).filter(Boolean);
      delete chat.token_counts;
      delete chat.sender_counts;
      delete chat.type_counts;
      delete chat.daily_counts;
    }

    const chatSummaries = Array.from(chatByJid.values()).sort((a, b) => {
      return (
        (b.content_message_count - a.content_message_count) ||
        (b.message_count - a.message_count) ||
        ((b.last_activity || 0) - (a.last_activity || 0))
      );
    });

    this.analyticsCache = {
      totals: this.stats(),
      chatByJid,
      chatSummaries,
      topTokens: this._rankCountMap(globalTokenCounts, 25),
      topSenders: this._rankCountMap(globalSenderCounts, 25, "jid"),
      messageTypes: this._rankCountMap(globalTypeCounts, 25, "type"),
      hourlyActivity,
      dailyActivity: this._mapToSeries(globalDailyActivity, "date"),
      tokenIndex,
    };

    return this.analyticsCache;
  }

  private _createEmptyChatAnalytics(jid: string) {
    const rawChat = this.getChat(jid) || {};
    return {
      jid,
      name: rawChat.name || rawChat.subject || jid,
      is_group: isGroupJid(jid),
      participant_count: 0,
      message_count: 0,
      content_message_count: 0,
      from_me_count: 0,
      external_count: 0,
      active_days: 0,
      first_activity: null,
      last_activity: null,
      top_tokens: [] as unknown[],
      top_senders: [] as unknown[],
      type_breakdown: [] as unknown[],
      daily_activity: [] as unknown[],
      recent_messages: [] as unknown[],
      token_counts: new Map<string, number>(),
      sender_counts: new Map<string, number>(),
      type_counts: new Map<string, number>(),
      daily_counts: new Map<string, number>(),
    };
  }

  private _rankCountMap(map: Map<string, number>, limit: number, keyName = "token") {
    return Array.from(map.entries())
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key, count]) => ({ [keyName]: key, count }));
  }

  private _mapToSeries(map: Map<string, number>, keyName: string) {
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ [keyName]: key, count }));
  }

  private _getMessageSender(msg: AnyMsg): string | null {
    if (msg?.key?.fromMe) return "me";
    return msg?.key?.participant || msg?.key?.remoteJid || null;
  }

  private _toDayKey(timestamp: number): string {
    return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
  }

  private _toHour(timestamp: number): number {
    return new Date(Number(timestamp) * 1000).getHours();
  }

  private _tokenize(text: string): string[] {
    return (
      String(text || "")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter(
          (token) => token.length >= 2 && !ANALYTICS_STOP_WORDS.has(token) && /\D/.test(token),
        ) || []
    );
  }

  private _shouldIndexMessageText(message: { text?: string; type?: string }): boolean {
    const text = String(message?.text || "").trim();
    if (!text) return false;
    if (/^\[[^\]]+\]$/.test(text)) return false;
    return !["protocol", "unknown", "senderKeyDistribution"].includes(message?.type || "");
  }
}
