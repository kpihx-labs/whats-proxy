/**
 * whats-proxy — unit tests: store.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  test("saveSnapshot + loadSnapshot round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-store-"));
    try {
      const store = new Store();
      const jid = "3361@s.whatsapp.net";
      store.upsertMessages([makeMsg("1", jid, 100, "hello")]);
      store.upsertChats([{ id: jid, name: "Bob" }]);
      const file = join(dir, "store.json");
      expect(store.saveSnapshot(file)).toBe(true);

      const restored = new Store();
      expect(restored.loadSnapshot(file)).toBe(true);
      expect(restored.countMessages(jid)).toBe(1);
      expect(restored.getChat(jid)?.name).toBe("Bob");
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
