/**
 * whats-proxy — unit tests: store.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/whats_proxy/store.ts";

function makeMsg(id: string, jid: string, ts: number, text: string, fromMe = false) {
  return {
    key: { id, remoteJid: jid, fromMe },
    message: { conversation: text },
    messageTimestamp: ts,
  };
}

describe("Store messages", () => {
  test("upsert + getMessages (newest first)", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    const jid = "3361@s.whatsapp.net";
    store.upsertMessages([makeMsg("1", jid, 100, "a"), makeMsg("2", jid, 200, "b")]);
    const msgs = store.getMessages(jid);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.key.id).toBe("2"); // newest first
    expect(msgs[1]!.key.id).toBe("1");
  });

  test("message filters: since / until / types / excludeTypes", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    const jid = "3361@s.whatsapp.net";
    store.upsertMessages([
      makeMsg("1", jid, 100, "a"),
      makeMsg("2", jid, 200, "b"),
      {
        key: { id: "3", remoteJid: jid, fromMe: false },
        message: { reactionMessage: { text: "👍" } },
        messageTimestamp: 300,
      },
    ]);
    expect(store.getMessages(jid, 10, undefined, { since: 150 }).length).toBe(2);
    expect(store.getMessages(jid, 10, undefined, { until: 150 }).length).toBe(1);
    expect(store.getMessages(jid, 10, undefined, { types: ["text"] }).length).toBe(2);
    expect(store.getMessages(jid, 10, undefined, { excludeTypes: ["reaction"] }).length).toBe(2);
  });

  test("max_messages_per_chat enforced", () => {
    const store = new Store({ max_messages_per_chat: 3, max_chats: 10 });
    const jid = "3361@s.whatsapp.net";
    for (let i = 0; i < 10; i++) store.upsertMessages([makeMsg(String(i), jid, i, "m")]);
    expect(store.countMessages(jid)).toBe(3);
  });

  test("searchMessages finds text", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    const jid = "3361@s.whatsapp.net";
    store.upsertMessages([makeMsg("1", jid, 100, "hello world")]);
    const hits = store.searchMessages("hello", jid, 10);
    expect(hits.length).toBe(1);
    expect(store.searchMessages("nope", jid, 10).length).toBe(0);
  });
});

describe("Store chats/contacts/analytics", () => {
  test("upsertChats + getChat", () => {
    const store = new Store();
    store.upsertChats([{ id: "3361@s.whatsapp.net", name: "Bob" }]);
    const chat = store.getChat("3361@s.whatsapp.net");
    expect(chat?.name).toBe("Bob");
  });

  test("upsertContacts + getContact", () => {
    const store = new Store();
    store.upsertContacts([{ id: "3362@s.whatsapp.net", name: "Alice" }]);
    const c = store.getContact("3362@s.whatsapp.net");
    expect(c?.name).toBe("Alice");
  });

  test("analytics overview counts", () => {
    const store = new Store();
    const jid = "3361@s.whatsapp.net";
    store.upsertMessages([makeMsg("1", jid, 100, "a"), makeMsg("2", jid, 200, "b")]);
    const ov = store.getAnalyticsOverview({});
    expect(ov.totals.messages).toBe(2);
    expect(ov.totals.chats).toBe(1);
  });

  test("getAnalyticsOverview daily activity respects days", () => {
    const store = new Store();
    const jid = "3361@s.whatsapp.net";
    store.upsertMessages([makeMsg("1", jid, 100, "a"), makeMsg("2", jid, 200, "b")]);
    const ov = store.getAnalyticsOverview({ days: 1 });
    expect(ov.totals.messages).toBe(2);
    expect(Array.isArray(ov.daily_activity)).toBe(true);
  });
});

describe("Store persistence", () => {
  test("saveSnapshot + loadSnapshot round-trip (SQLite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
    try {
      // Simulate daemon flow: create store, open DB, add data
      const store = new Store();
      const dbPath = join(dir, "store.db");
      // loadSnapshot creates the DB file if it doesn't exist (returns false = fresh DB)
      store.loadSnapshot(dbPath);
      const jid = "3361@s.whatsapp.net";
      store.upsertMessages([makeMsg("1", jid, 100, "hello")]);
      store.upsertChats([{ id: jid, name: "Bob" }]);
      // saveSnapshot is a no-op for SQLite — data persists automatically
      expect(store.saveSnapshot(dbPath)).toBe(true);

      // Create a second store and load from the DB file
      const restored = new Store();
      expect(restored.loadSnapshot(dbPath)).toBe(true);
      expect(restored.countMessages(jid)).toBe(1);
      expect(restored.getChat(jid)?.name).toBe("Bob");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadSnapshot migrates from store.json to store.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-store-migrate-"));
    try {
      // Simulate an old store.json snapshot
      const snapshot = {
        chats: [{ id: "3361@s.whatsapp.net", name: "Bob" }],
        contacts: [],
        messages: [["3361@s.whatsapp.net", [makeMsg("1", "3361@s.whatsapp.net", 100, "hello")]]],
        groupMeta: [],
        contactTags: {},
        watchlists: {},
        lidPnMap: {},
      };
      const jsonPath = join(dir, "store.json");
      writeFileSync(jsonPath, JSON.stringify(snapshot), "utf-8");

      // loadSnapshot should detect the JSON, create SQLite, and migrate
      const restored = new Store();
      expect(restored.loadSnapshot(jsonPath)).toBe(true);
      expect(restored.countMessages("3361@s.whatsapp.net")).toBe(1);
      expect(restored.getChat("3361@s.whatsapp.net")?.name).toBe("Bob");
      // Old JSON file should be deleted
      expect(existsSync(jsonPath)).toBe(false);
      // New DB file should exist
      expect(existsSync(join(dir, "store.db"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Watchlists", () => {
  test("resolveWatchlist + import from config", () => {
    const store = new Store();
    const imported = store.importWatchlistsFromConfig({
      family: ["3361", "3362"],
    });
    expect(imported).toBe(1);
    const jids = store.resolveWatchlist("family");
    expect(jids).toEqual(["3361", "3362"]);
    expect(store.resolveWatchlist("missing")).toBeNull();
  });
});
