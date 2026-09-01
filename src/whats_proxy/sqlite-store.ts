/**
 * whats-proxy — SQLite-backed Store (replaces Map-based JSON persistence).
 *
 * Uses SQLite with WAL mode for concurrent reads + crash safety.
 * Complex objects (chats, contacts, messages, groups) are JSON-serialized in
 * a `data` TEXT column — indexed columns are extracted for fast queries.
 * FTS5 powers full-text message search.
 *
 * The external interface is identical to the original Map-based Store.
 * JSON snapshot persistence becomes a no-op: the SQLite file IS the snapshot.
 *
 * Runtime adapter: better-sqlite3 on Node.js, bun:sqlite on Bun.
 * Both share the same synchronous SQLite API surface.
 */

// Runtime-compatible SQLite import: bun:sqlite on Bun, better-sqlite3 on Node.js.
// biome-ignore lint/suspicious/noExplicitAny: runtime adapter
let SqliteDb: any;
// biome-ignore lint/suspicious/noExplicitAny: runtime adapter
let sqliteModule: any;
try {
  // Bun runtime
  sqliteModule = await import("bun:sqlite");
  SqliteDb = sqliteModule.Database;
} catch {
  // Node.js runtime
  sqliteModule = await import("better-sqlite3");
  SqliteDb = sqliteModule.default;
}
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMessage, phoneToJid } from "./helpers";

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

interface SearchOptions {
  since?: number;
  until?: number;
  types?: string[];
  excludeTypes?: string[];
}

// ── Schema ─────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dir, "db", "schema.sql"), "utf-8");

// ── Map-like wrapper for groupMeta / lidPnMap backward compat ──────────────

class DbMap<V> {
  readonly [Symbol.toStringTag] = "DbMap";
  // biome-ignore lint/suspicious/noExplicitAny: runtime adapter — Statement type differs between bun:sqlite and better-sqlite3
  private db: any;
  private stmts: {
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    get: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    set: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    delete: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    has: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    size: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    all: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    clear: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    keys: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    values: any;
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    entries: any;
  };
  private serialize: (v: V) => string;
  private deserialize: (s: string) => V;
  private table: string;
  private keyCol: string;
  private valCol: string;
  private onChange: (() => void) | null;

  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: runtime adapter
    db: any,
    table: string,
    keyCol: string,
    valCol: string,
    serialize: (v: V) => string,
    deserialize: (s: string) => V,
    onChange: (() => void) | null,
  ) {
    this.db = db;
    this.table = table;
    this.keyCol = keyCol;
    this.valCol = valCol;
    this.serialize = serialize;
    this.deserialize = deserialize;
    this.onChange = onChange;
    this.stmts = {
      get: db.prepare(`SELECT ${valCol} FROM ${table} WHERE ${keyCol} = ?`),
      set: db.prepare(`INSERT OR REPLACE INTO ${table} (${keyCol}, ${valCol}) VALUES (?, ?)`),
      delete: db.prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`),
      has: db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ? LIMIT 1`),
      size: db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`),
      all: db.prepare(`SELECT ${keyCol}, ${valCol} FROM ${table}`),
      clear: db.prepare(`DELETE FROM ${table}`),
      keys: db.prepare(`SELECT ${keyCol} FROM ${table}`),
      values: db.prepare(`SELECT ${valCol} FROM ${table}`),
      entries: db.prepare(`SELECT ${keyCol}, ${valCol} FROM ${table}`),
    };
  }

  get size(): number {
    return (this.stmts.size.get() as { cnt: number }).cnt;
  }

  get(key: string): V | undefined {
    const row = this.stmts.get.get(key) as Record<string, string> | undefined;
    return row ? this.deserialize(row[this.valCol]!) : undefined;
  }

  set(key: string, value: V): this {
    this.stmts.set.run(key, this.serialize(value));
    this.onChange?.();
    return this;
  }

  delete(key: string): boolean {
    const info = this.stmts.delete.run(key);
    if (info.changes > 0) {
      this.onChange?.();
      return true;
    }
    return false;
  }

  has(key: string): boolean {
    return this.stmts.has.get(key) !== undefined;
  }

  forEach(callbackfn: (value: V, key: string, map: DbMap<V>) => void, thisArg?: any): void {
    for (const row of this.stmts.all.all()) {
      const r = row as Record<string, string>;
      callbackfn.call(thisArg, this.deserialize(r[this.valCol]!), r[this.keyCol]!, this);
    }
  }

  clear(): void {
    this.stmts.clear.run();
    this.onChange?.();
  }

  *entries(): IterableIterator<[string, V]> {
    for (const row of this.stmts.entries.all()) {
      const r = row as Record<string, string>;
      yield [r[this.keyCol]!, this.deserialize(r[this.valCol]!)];
    }
  }

  *keys(): IterableIterator<string> {
    for (const row of this.stmts.keys.all()) {
      yield (row as Record<string, string>)[this.keyCol]!;
    }
  }

  *values(): IterableIterator<V> {
    for (const row of this.stmts.values.all()) {
      yield this.deserialize((row as Record<string, string>)[this.valCol]!);
    }
  }

  *[Symbol.iterator](): IterableIterator<[string, V]> {
    yield* this.entries();
  }
}

// ── Store ──────────────────────────────────────────────────────────────────

export class SQLiteStore {
  maxMessagesPerChat: number;
  maxChats: number;
  onChange: (() => void) | null;

  groupMeta: DbMap<AnyGroupMeta>;
  lidPnMap: DbMap<{ pn: string; name?: string }>;

  /** Backward-compat: provides `messages.keys()` for actions that iterate all JIDs. */
  messages = {
    keys: (): IterableIterator<string> => {
      const rows = this.db.prepare(`SELECT DISTINCT remoteJid FROM messages`).all() as { remoteJid: string }[];
      return rows.map((r) => r.remoteJid)[Symbol.iterator]();
    },
  } as unknown as Map<string, AnyMsg[]>;

  // biome-ignore lint/suspicious/noExplicitAny: runtime adapter — SQLite DB type differs between runtimes
  private db: any;

  private stmts: Record<string, any>;

  constructor(opts: StoreOptions = {}) {
    this.maxMessagesPerChat = opts.max_messages_per_chat || 500;
    this.maxChats = opts.max_chats || 1000;
    this.onChange = typeof opts.onChange === "function" ? opts.onChange : null;

    // DB path is set later via loadSnapshot or initDB
    this.db = new SqliteDb(":memory:");
    this._initPragmas();

    this.db.exec(SCHEMA_SQL);

    // Initialize Map-like properties backed by DB
    this.groupMeta = new DbMap<AnyGroupMeta>(
      this.db, "group_meta", "id", "data",
      (v) => JSON.stringify(v),
      (s) => JSON.parse(s),
      this.onChange,
    );

    this.lidPnMap = new DbMap<{ pn: string; name?: string }>(
      this.db, "lid_mappings", "lid", "data",
      (v) => JSON.stringify(v),
      (s) => JSON.parse(s),
      this.onChange,
    );

    this.stmts = this._prepareStatements();
  }

  /** Switch from in-memory to a file-backed DB. */
  private openDB(dbPath: string): void {
    if (!this.db.filename || this.db.filename === ":memory:") {
      this.db.close();
    }
    this.db = new SqliteDb(dbPath);
    this._initPragmas();
    this.db.exec(SCHEMA_SQL);

    // Re-initialize Map-like properties on the new DB
    this.groupMeta = new DbMap<AnyGroupMeta>(
      this.db, "group_meta", "id", "data",
      (v) => JSON.stringify(v),
      (s) => JSON.parse(s),
      this.onChange,
    );

    this.lidPnMap = new DbMap<{ pn: string; name?: string }>(
      this.db, "lid_mappings", "lid", "data",
      (v) => JSON.stringify(v),
      (s) => JSON.parse(s),
      this.onChange,
    );

    this.stmts = this._prepareStatements();
  }

  /** Set WAL mode and performance pragmas. Works on both bun:sqlite and better-sqlite3. */
  private _initPragmas() {
    // bun:sqlite doesn't have db.pragma(); better-sqlite3 does.
    // db.exec("PRAGMA ...") works on both.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = -64000");
  }

  private _prepareStatements() {
    const db = this.db;
    return {
      upsertChat: db.prepare(`INSERT OR REPLACE INTO chats (id, data, name, pushName, conversationTimestamp, unreadCount, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      getChat: db.prepare(`SELECT data FROM chats WHERE id = ?`),
      deleteChats: db.prepare(`DELETE FROM chats WHERE id = ?`),
      listChats: db.prepare(`SELECT data FROM chats ORDER BY conversationTimestamp DESC LIMIT ? OFFSET ?`),
      countChats: db.prepare(`SELECT COUNT(*) as cnt FROM chats`),
      upsertContact: db.prepare(`INSERT OR REPLACE INTO contacts (id, data, name, notify, phoneNumber, lid) VALUES (?, ?, ?, ?, ?, ?)`),
      getContact: db.prepare(`SELECT data FROM contacts WHERE id = ?`),
      listContacts: db.prepare(`SELECT data FROM contacts`),
      listContactsByName: db.prepare(`SELECT data FROM contacts WHERE name LIKE ? COLLATE NOCASE`),
      upsertMessage: db.prepare(`INSERT OR REPLACE INTO messages (remoteJid, msgId, data, timestamp, fromMe, text) VALUES (?, ?, ?, ?, ?, ?)`),
      upsertMessageFts: db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`),
      deleteMessages: db.prepare(`DELETE FROM messages WHERE remoteJid = ? AND msgId = ?`),
      deleteMessageFts: db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`),
      getMessage: db.prepare(`SELECT data FROM messages WHERE msgId = ?`),
      getOldestMessage: db.prepare(`SELECT data FROM messages WHERE remoteJid = ? ORDER BY timestamp ASC, msgId ASC LIMIT 1`),
      countMessagesByJid: db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE remoteJid = ?`),
      countAllMessages: db.prepare(`SELECT COUNT(*) as cnt FROM messages`),
      searchMessagesFts: db.prepare(`SELECT rowid, data FROM messages WHERE remoteJid IN (SELECT remoteJid FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)) ORDER BY timestamp DESC LIMIT ?`),
      deleteMessageFtsAll: db.prepare(`DELETE FROM messages_fts`),
    };
  }

  // ── Schema column extraction helpers ──────────────────────────────────────

  private _chatColumns(chat: AnyChat): [string, string, string | null, string | null, number, number, number] {
    const ts = Number(chat.conversationTimestamp || 0);
    return [
      chat.id,
      JSON.stringify(chat),
      chat.name || null,
      chat.pushName || null,
      ts,
      Number(chat.unreadCount || 0),
      Math.max(ts, Number(chat.updatedAt || 0)),
    ];
  }

  private _contactColumns(c: AnyContact): [string, string, string, string, string, string] {
    return [
      c.id,
      JSON.stringify(c),
      c.name || null,
      c.notify || null,
      c.phoneNumber || null,
      c.lid || null,
    ];
  }

  private _messageColumns(msg: AnyMsg): [string, string, string, number, number, string | null] {
    const jid = msg.key?.remoteJid || "";
    const id = msg.key?.id || "";
    const ts = Number(msg.messageTimestamp || 0);
    const fromMe = msg.key?.fromMe ? 1 : 0;
    const formatted = formatMessage(msg);
    const text = formatted?.text || null;
    return [jid, id, JSON.stringify(msg), ts, fromMe, text];
  }

  // ── Chat operations ──────────────────────────────────────────────────────

  upsertChats(chats: AnyChat[]) {
    const txn = this.db.transaction((chats: AnyChat[]) => {
      for (const chat of chats) {
        const existing = this._readChatRaw(chat.id);
        const merged = existing ? { ...existing, ...chat } : chat;
        this.stmts.upsertChat.run(...this._chatColumns(merged));
      }
    });
    txn(chats);
    this._trimChats();
    this._notifyChanged();
  }

  updateChats(updates: AnyChat[]) {
    const txn = this.db.transaction((updates: AnyChat[]) => {
      for (const update of updates) {
        const existing = this._readChatRaw(update.id);
        if (existing) {
          const merged = { ...existing, ...update };
          this.stmts.upsertChat.run(...this._chatColumns(merged));
        }
      }
    });
    txn(updates);
    this._notifyChanged();
  }

  deleteChats(ids: string[]) {
    const txn = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmts.deleteChats.run(id);
        this.db.prepare(`DELETE FROM messages WHERE remoteJid = ?`).run(id);
      }
    });
    txn(ids);
    this._notifyChanged();
  }

  getChat(jid: string): AnyChat | null {
    const row = this.stmts.getChat.get(jid) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  listChats(limit = 50, offset = 0): AnyChat[] {
    const rows = this.stmts.listChats.all(limit, offset) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  // ── Contact operations ───────────────────────────────────────────────────

  upsertContacts(contacts: AnyContact[]) {
    const txn = this.db.transaction((contacts: AnyContact[]) => {
      for (const contact of contacts) {
        const jid = contact.id;
        if (!jid) continue;
        const existing = this._readContactRaw(jid);
        const merged = existing ? { ...existing, ...contact } : contact;
        this.stmts.upsertContact.run(...this._contactColumns(merged));
      }
    });
    txn(contacts);
    this._notifyChanged();
  }

  updateContacts(updates: AnyContact[]) {
    const txn = this.db.transaction((updates: AnyContact[]) => {
      for (const update of updates) {
        const jid = update.id;
        if (!jid) continue;
        const existing = this._readContactRaw(jid);
        if (existing) {
          const merged = { ...existing, ...update };
          this.stmts.upsertContact.run(...this._contactColumns(merged));
        }
      }
    });
    txn(updates);
    this._notifyChanged();
  }

  getContact(jid: string): AnyContact | null {
    const row = this.stmts.getContact.get(jid) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  listContacts(options: { name?: string; tag?: string; has_tags?: boolean } = {}): AnyContact[] {
    let rows: { data: string }[];
    if (options.name) {
      const pattern = `%${options.name.toLowerCase()}%`;
      rows = this.stmts.listContactsByName.all(pattern) as { data: string }[];
    } else {
      rows = this.stmts.listContacts.all() as { data: string }[];
    }

    let contacts = rows.map((r) => JSON.parse(r.data) as AnyContact);

    if (options.name && !rows.length) {
      // Fallback: filter in JS when LIKE didn't match (covers notify/verifiedName/short fields)
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
        ? contacts.filter((c) => this.getContactTags(c.id).length > 0)
        : contacts.filter((c) => this.getContactTags(c.id).length === 0);
    }
    return contacts;
  }

  // ── Contact tags ─────────────────────────────────────────────────────────

  setContactTags(jid: string, tags: string[]) {
    const uniqueTags = [...new Set(tags)];
    const txn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM contact_tags WHERE jid = ?`).run(jid);
      const ins = this.db.prepare(`INSERT INTO contact_tags (jid, tag) VALUES (?, ?)`);
      for (const tag of uniqueTags) ins.run(jid, tag);
    });
    txn();
    this._notifyChanged();
  }

  addContactTags(jid: string, tags: string[]) {
    const existing = new Set(this.getContactTags(jid));
    for (const t of tags) existing.add(t);
    this.setContactTags(jid, Array.from(existing));
  }

  removeContactTags(jid: string, tags: string[]) {
    const toRemove = new Set(tags);
    const filtered = this.getContactTags(jid).filter((t) => !toRemove.has(t));
    if (filtered.length > 0) this.setContactTags(jid, filtered);
    else {
      this.db.prepare(`DELETE FROM contact_tags WHERE jid = ?`).run(jid);
      this._notifyChanged();
    }
  }

  getContactTags(jid: string): string[] {
    const rows = this.db.prepare(`SELECT tag FROM contact_tags WHERE jid = ?`).all(jid) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  listByTag(tag: string): string[] {
    const rows = this.db.prepare(`SELECT jid FROM contact_tags WHERE tag = ?`).all(tag) as { jid: string }[];
    return rows.map((r) => r.jid);
  }

  getAllTags(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT tag FROM contact_tags ORDER BY tag`).all() as { tag: string }[];
    return rows.map((r) => r.tag);
  }


  upsertMessages(messages: AnyMsg[]) {
    const txn = this.db.transaction((messages: AnyMsg[]) => {
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;

        this._touchChatFromMessage(msg);

        const cols = this._messageColumns(msg);
        const info = this.stmts.upsertMessage.run(...cols);

        // Handle FTS: if this was an INSERT (new row), add to FTS.
        // For UPDATE (replace), we need to delete old FTS entry first.
        if (info.changes > 0) {
          // Get the rowid for FTS
          const row = this.db.prepare(`SELECT rowid FROM messages WHERE remoteJid = ? AND msgId = ?`).get(jid, msg.key?.id) as { rowid: number } | undefined;
          if (row) {
            // For REPLACE: the old FTS entry is now orphaned — clean it
            if (info.lastInsertRowid !== row.rowid) {
              try { this.stmts.deleteMessageFts.run(row.rowid); } catch { /* FTS entry may not exist */ }
            }
            const text = cols[5] || "";
            if (text) {
              try {
                this.db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`).run(row.rowid, text);
              } catch {
                // FTS entry may already exist from a previous insert — update it
                try {
                  this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(row.rowid);
                  this.db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`).run(row.rowid, text);
                } catch { /* non-critical */ }
              }
            }
          }
        }
      }

      // Enforce max messages per chat (prune oldest)
      const chatJids = new Set(messages.map((m) => m.key?.remoteJid).filter(Boolean));
      for (const jid of chatJids) {
        const count = (this.stmts.countMessagesByJid.get(jid) as { cnt: number }).cnt;
        if (count > this.maxMessagesPerChat) {
          const excess = count - this.maxMessagesPerChat;
          const toDelete = this.db.prepare(
            `SELECT rowid, msgId FROM messages WHERE remoteJid = ? ORDER BY timestamp ASC, msgId ASC LIMIT ?`,
          ).all(jid, excess) as { rowid: number; msgId: string }[];
          for (const d of toDelete) {
            try { this.stmts.deleteMessageFts.run(d.rowid); } catch { /* FTS may not have entry */ }
            this.db.prepare(`DELETE FROM messages WHERE rowid = ?`).run(d.rowid);
          }
        }
      }
    });
    txn(messages);
    this._notifyChanged();
  }

  deleteMessages(keys: { remoteJid: string; id: string }[]) {
    const txn = this.db.transaction((keys: { remoteJid: string; id: string }[]) => {
      for (const key of keys) {
        const row = this.db.prepare(`SELECT rowid FROM messages WHERE remoteJid = ? AND msgId = ?`).get(key.remoteJid, key.id) as { rowid: number } | undefined;
        if (row) {
          try { this.stmts.deleteMessageFts.run(row.rowid); } catch { /* FTS may not have entry */ }
          this.stmts.deleteMessages.run(key.remoteJid, key.id);
        }
      }
    });
    txn(keys);
    this._notifyChanged();
  }

  getMessages(jid: string, limit = 50, before_id?: string, options: MessageFilters = {}): AnyMsg[] {
    let query = `SELECT data, timestamp, msgId FROM messages WHERE remoteJid = ?`;
    const params: any[] = [jid];

    if (before_id) {
      // Find timestamp of the cursor message
      const cursor = this.db.prepare(`SELECT timestamp FROM messages WHERE msgId = ? AND remoteJid = ?`).get(before_id, jid) as { timestamp: number } | undefined;
      if (cursor) {
        query += ` AND (timestamp < ? OR (timestamp = ? AND msgId < ?))`;
        params.push(cursor.timestamp, cursor.timestamp, before_id);
      }
    }

    if (options.since != null) {
      query += ` AND timestamp >= ?`;
      params.push(options.since);
    }
    if (options.until != null) {
      query += ` AND timestamp <= ?`;
      params.push(options.until);
    }

    query += ` ORDER BY timestamp DESC, msgId DESC`;
    // Fetch extra rows to account for type filtering
    const fetchLimit = (options.types && options.types.length > 0) || (options.excludeTypes && options.excludeTypes.length > 0)
      ? limit * 5
      : limit;
    query += ` LIMIT ?`;
    params.push(fetchLimit);

    const rows = this.db.prepare(query).all(...params) as { data: string }[];
    let result = rows.map((r) => JSON.parse(r.data) as AnyMsg);

    // Apply type filters in JS (requires formatMessage)
    if (options.types && options.types.length > 0) {
      const typeSet = new Set(options.types);
      result = result.filter((m) => {
        const formatted = formatMessage(m);
        return formatted && typeSet.has(formatted.type);
      });
    }
    if (options.excludeTypes && options.excludeTypes.length > 0) {
      const excludeSet = new Set(options.excludeTypes);
      result = result.filter((m) => {
        const formatted = formatMessage(m);
        return formatted && !excludeSet.has(formatted.type);
      });
    }

    return result.slice(0, limit);
  }

  countMessages(jid: string): number {
    return (this.stmts.countMessagesByJid.get(jid) as { cnt: number }).cnt;
  }

  getOldestMessage(jid: string): AnyMsg | null {
    const row = this.stmts.getOldestMessage.get(jid) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  getMessage(id: string): AnyMsg | null {
    const row = this.stmts.getMessage.get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  searchMessages(
    query: string,
    jid: string | string[] | null,
    limit = 20,
    options: SearchOptions = {},
  ): ReturnType<typeof formatMessage>[] {
    const lower = query.toLowerCase();
    const results: ReturnType<typeof formatMessage>[] = [];
    const cappedLimit = Math.min(limit || 20, 200);

    let chatJids: string[];
    if (Array.isArray(jid)) chatJids = jid;
    else if (jid) chatJids = [jid];
    else {
      // All distinct JIDs that have messages
      const rows = this.db.prepare(`SELECT DISTINCT remoteJid FROM messages`).all() as { remoteJid: string }[];
      chatJids = rows.map((r) => r.remoteJid);
    }

    for (const chatJid of chatJids) {
      if (results.length >= cappedLimit) break;

      // Fetch messages for this chat with timestamp filters
      let querySql = `SELECT data, timestamp FROM messages WHERE remoteJid = ?`;
      const params: any[] = [chatJid];

      if (options.since != null) {
        querySql += ` AND timestamp >= ?`;
        params.push(options.since);
      }
      if (options.until != null) {
        querySql += ` AND timestamp <= ?`;
        params.push(options.until);
      }

      querySql += ` ORDER BY timestamp DESC`;
      // Fetch extra for type filtering
      const fetchLimit = (options.types && options.types.length > 0) || (options.excludeTypes && options.excludeTypes.length > 0)
        ? cappedLimit * 5
        : cappedLimit * 2;
      querySql += ` LIMIT ?`;
      params.push(fetchLimit);

      const rows = this.db.prepare(querySql).all(...params) as { data: string }[];
      let msgs = rows.map((r) => JSON.parse(r.data) as AnyMsg);

      // Apply type filters
      if (options.types && options.types.length > 0) {
        const typeSet = new Set(options.types);
        msgs = msgs.filter((m) => {
          const formatted = formatMessage(m);
          return formatted && typeSet.has(formatted.type);
        });
      }
      if (options.excludeTypes && options.excludeTypes.length > 0) {
        const excludeSet = new Set(options.excludeTypes);
        msgs = msgs.filter((m) => {
          const formatted = formatMessage(m);
          return formatted && !excludeSet.has(formatted.type);
        });
      }

      for (const msg of msgs) {
        if (results.length >= cappedLimit) break;
        const formatted = formatMessage(msg);
        if (formatted && formatted.text.toLowerCase().includes(lower)) {
          results.push(formatted);
        }
      }
    }

    return results;
  }

  // ── Receipt operations ───────────────────────────────────────────────────

  /** Store a message receipt (read/delivered/played). */
  addReceipt(msgJid: string, chatJid: string, readerJid: string, receiptType: string, timestamp: number) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO message_receipts (msg_jid, chat_jid, reader_jid, receipt_type, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run(msgJid, chatJid, readerJid, receiptType, timestamp);
  }

  /** Get all receipts for a specific message. */
  getReceipts(msgJid: string) {
    return this.db.prepare(
      "SELECT * FROM message_receipts WHERE msg_jid = ? ORDER BY timestamp ASC",
    ).all(msgJid);
  }

  /** Get receipts for all messages in a chat (for a time range). Returns Map<msgJid, receipts[]>. */
  getChatReceipts(chatJid: string, since?: number) {
    const query = since
      ? "SELECT * FROM message_receipts WHERE chat_jid = ? AND timestamp >= ? ORDER BY msg_jid, timestamp"
      : "SELECT * FROM message_receipts WHERE chat_jid = ? ORDER BY msg_jid, timestamp";
    const rows = since
      ? this.db.prepare(query).all(chatJid, since)
      : this.db.prepare(query).all(chatJid);
    const map = new Map<string, any[]>();
    for (const row of rows as any[]) {
      if (!map.has(row.msg_jid)) map.set(row.msg_jid, []);
      map.get(row.msg_jid)!.push(row);
    }
    return map;
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

    const existing = this._readChatRaw(jid) || { id: jid };
    this.stmts.upsertChat.run(
      jid,
      JSON.stringify({
        ...existing,
        id: jid,
        name: meta?.subject || existing.name,
        subject: meta?.subject || existing.subject,
        conversationTimestamp:
          Number(existing.conversationTimestamp || 0) ||
          Number(meta?.subjectTime || 0) ||
          Number(meta?.creation || 0) ||
          undefined,
      }),
      meta?.subject || existing.name || null,
      existing.pushName || null,
      Number(existing.conversationTimestamp || 0) || Number(meta?.subjectTime || 0) || Number(meta?.creation || 0) || 0,
      Number(existing.unreadCount || 0),
      Math.max(Number(existing.conversationTimestamp || 0), Number(meta?.subjectTime || 0), Number(meta?.creation || 0)) || 0,
    );
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
    // Normalize a bare phone number to a full JID before lookup — the store
    // is keyed by full JIDs (`33612345678@s.whatsapp.net`), not plain numbers.
    const normalized = phoneToJid(jid);

    // 1. Direct contact lookup
    const contact = this.getContact(normalized);
    const contactName = contact?.name || contact?.notify || contact?.verifiedName;
    if (contactName) return contactName;

    // 2. Chat name lookup (pushName from last message)
    const chat = this.getChat(normalized);
    const chatName = chat?.name || chat?.pushName;
    if (chatName) return chatName;

    // 3. LID → PN → contact name
    if (normalized.endsWith("@lid")) {
      const mapping = this.lidPnMap.get(normalized);
      if (mapping?.pn) {
        const pnContact = this.getContact(mapping.pn);
        const pnName = pnContact?.name || pnContact?.notify || mapping.name;
        if (pnName) return pnName;
        const pnChat = this.getChat(mapping.pn);
        if (pnChat?.name) return pnChat.name;
      }
    }

    return null;
  }

  /** Resolve a raw JID (LID, phone, or full JID) to a display string.
   *  Returns "number (name)" when a name is found, or the raw JID as-is. */
  resolveJid(raw: string): string {
    if (!raw) return "";
    const name = this.resolveContactName(raw);
    return name ? `${raw} (${name})` : raw;
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
          const existing = this.getContact(c.id);
          if (existing && !existing.name) {
            existing.name = c.name;
            this.stmts.upsertContact.run(...this._contactColumns(existing));
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

  /** SQLite file IS the snapshot — no-op. */
  saveSnapshot(_filePath: string): boolean {
    return true;
  }

  /**
   * Open (or migrate) the SQLite DB.
   *
   * Migration: if no `store.db` exists but `store.json` does, read the JSON,
   * create SQLite, insert all data, delete old JSON. Zero-downtime migration.
   */
  loadSnapshot(filePath: string): boolean {
    // Derive DB path from the JSON path (store.json → store.db)
    const dbPath = filePath.endsWith(".json")
      ? filePath.slice(0, -5) + ".db"
      : filePath;

    // If DB already exists, just open it
    if (existsSync(dbPath)) {
      this.openDB(dbPath);
      return true;
    }

    // Migration: check for old JSON file
    if (existsSync(filePath)) {
      try {
        this.openDB(dbPath);

        const snapshot = JSON.parse(readFileSync(filePath, "utf-8"));

        // Import chats
        if (snapshot.chats) {
          const ins = this.db.prepare(`INSERT OR IGNORE INTO chats (id, data, name, pushName, conversationTimestamp, unreadCount, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
          const txn = this.db.transaction(() => {
            for (const chat of snapshot.chats) {
              ins.run(...this._chatColumns(chat));
            }
          });
          txn();
        }

        // Import contacts
        if (snapshot.contacts) {
          const ins = this.db.prepare(`INSERT OR IGNORE INTO contacts (id, data, name, notify, phoneNumber, lid) VALUES (?, ?, ?, ?, ?, ?)`);
          const txn = this.db.transaction(() => {
            for (const c of snapshot.contacts) {
              ins.run(...this._contactColumns(c));
            }
          });
          txn();
        }

        // Import messages (snapshot.messages = [jid, AnyMsg[]] pairs)
        if (snapshot.messages) {
          const txn = this.db.transaction(() => {
            for (const [jid, msgs] of snapshot.messages) {
              for (const msg of msgs) {
                const cols = this._messageColumns(msg);
                this.stmts.upsertMessage.run(...cols);
                // Add to FTS
                const row = this.db.prepare(`SELECT rowid FROM messages WHERE remoteJid = ? AND msgId = ?`).get(cols[0], cols[1]) as { rowid: number } | undefined;
                if (row && cols[5]) {
                  try {
                    this.db.prepare(`INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`).run(row.rowid, cols[5]);
                  } catch { /* FTS may already exist */ }
                }
              }
            }
          });
          txn();
        }

        // Import group meta
        if (snapshot.groupMeta) {
          const ins = this.db.prepare(`INSERT OR IGNORE INTO group_meta (id, data) VALUES (?, ?)`);
          const txn = this.db.transaction(() => {
            for (const [jid, meta] of snapshot.groupMeta) {
              ins.run(jid, JSON.stringify(meta));
            }
          });
          txn();
        }

        // Import contact tags
        if (snapshot.contactTags) {
          const txn = this.db.transaction(() => {
            const ins = this.db.prepare(`INSERT OR IGNORE INTO contact_tags (jid, tag) VALUES (?, ?)`);
            for (const [jid, tags] of Object.entries(snapshot.contactTags)) {
              for (const tag of tags as string[]) {
                ins.run(jid, tag);
              }
            }
          });
          txn();
        }

        // Import LID mappings
        if (snapshot.lidPnMap) {
          const txn = this.db.transaction(() => {
            const ins = this.db.prepare(`INSERT OR IGNORE INTO lid_mappings (lid, pn, name) VALUES (?, ?, ?)`);
            for (const [lid, mapping] of Object.entries(snapshot.lidPnMap)) {
              const m = mapping as { pn: string; name?: string };
              ins.run(lid, m.pn, m.name || null);
            }
          });
          txn();
        }

        // Delete old JSON file
        try { unlinkSync(filePath); } catch { /* best effort */ }

        return true;
      } catch {
        // Migration failed — still open the DB (empty)
        this.openDB(dbPath);
        return false;
      }
    }

    // No existing data — create fresh DB
    this.openDB(dbPath);
    return false;
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
            const contact = this.getContact(jid);
            if (contact && !contact.notify) {
              contact.notify = msg.pushName;
              this.stmts.upsertContact.run(...this._contactColumns(contact));
            }
            // Also try LID → PN resolution
            if (jid.endsWith("@lid")) {
              const pn = this.lidPnMap.get(jid)?.pn;
              if (pn) {
                const pnContact = this.getContact(pn);
                if (pnContact && !pnContact.notify) {
                  pnContact.notify = msg.pushName;
                  this.stmts.upsertContact.run(...this._contactColumns(pnContact));
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
    const chatCount = (this.stmts.countChats.get() as { cnt: number }).cnt;
    const contactCount = (this.db.prepare(`SELECT COUNT(*) as cnt FROM contacts`).get() as { cnt: number }).cnt;
    const messageCount = (this.stmts.countAllMessages.get() as { cnt: number }).cnt;
    const groupCount = this.groupMeta.size;
    return {
      chats: chatCount,
      contacts: contactCount,
      messages: messageCount,
      groups: groupCount,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _readChatRaw(jid: string): AnyChat | null {
    const row = this.stmts.getChat.get(jid) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  private _readContactRaw(jid: string): AnyContact | null {
    const row = this.stmts.getContact.get(jid) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  private _touchChatFromMessage(msg: AnyMsg) {
    const jid = msg.key?.remoteJid;
    if (!jid) return;

    const existing = this._readChatRaw(jid) || { id: jid };
    const formatted = formatMessage(msg);
    const timestamp = msg.messageTimestamp
      ? Number(msg.messageTimestamp)
      : Number(existing.conversationTimestamp || 0);

    const merged: AnyChat = {
      ...existing,
      id: jid,
      conversationTimestamp: timestamp || existing.conversationTimestamp,
      name:
        existing.name ||
        existing.subject ||
        msg.pushName ||
        formatted?.push_name ||
        existing.name,
    };

    this.stmts.upsertChat.run(...this._chatColumns(merged));
    this._trimChats();
  }

  private _trimChats() {
    const count = (this.stmts.countChats.get() as { cnt: number }).cnt;
    if (count <= this.maxChats) return;
    const excess = count - this.maxChats;
    const toDelete = this.db.prepare(
      `SELECT id FROM chats ORDER BY conversationTimestamp ASC LIMIT ?`,
    ).all(excess) as { id: string }[];
    const txn = this.db.transaction(() => {
      for (const row of toDelete) {
        this.stmts.deleteChats.run(row.id);
        this.db.prepare(`DELETE FROM messages WHERE remoteJid = ?`).run(row.id);
      }
    });
    txn();
  }

  private _notifyChanged() {
    if (this.onChange) this.onChange();
  }
}
