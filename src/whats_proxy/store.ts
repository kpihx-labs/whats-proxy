/**
 * whats-proxy — Store facade.
 *
 * The implementation has been replaced by SQLiteStore (better-sqlite3).
 * This file re-exports the SQLite store class under the original `Store` name
 * so that all existing imports (`import { Store } from "./store.ts"`) continue
 * to work without changes.
 */

export { SQLiteStore as Store } from "./sqlite-store.ts";
export type { StoreOptions, AnyMsg, AnyChat, AnyContact, AnyGroupMeta } from "./sqlite-store.ts";
