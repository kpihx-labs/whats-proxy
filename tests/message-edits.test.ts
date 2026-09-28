/**
 * whats-proxy — unit tests: MESSAGE_EDIT fold (write path) + resolve (read path).
 *
 * Covers: text edits, caption edits, chained latest wins, out of order
 * injection, missing original synthesis, groups, FTS reindex, visible
 * counts and ordering with original timestamp kept, and the zero migration
 * read path fix for DBs written before folding.
 */

import { describe, expect, test } from "bun:test";

import { Store } from "../src/whats_proxy/store.ts";
import { formatMessage } from "../src/whats_proxy/helpers.ts";

const JID = "3361@s.whatsapp.net";
const GROUP = "120363000000000@g.us";
const LID_JID = "159334780645568@lid";
const PN_JID = "33698983555@s.whatsapp.net";

function makeText(id: string, jid: string, ts: number, text: string, fromMe = false) {
  return {
    key: { id, remoteJid: jid, fromMe },
    message: { extendedTextMessage: { text }, messageContextInfo: {} },
    messageTimestamp: ts,
  };
}

function makeImage(id: string, jid: string, ts: number, caption: string, fromMe = false) {
  return {
    key: { id, remoteJid: jid, fromMe },
    message: { imageMessage: { caption, mimetype: "image/jpeg" }, messageContextInfo: {} },
    messageTimestamp: ts,
  };
}

function makeEdit(
  editId: string,
  chatJid: string,
  ts: number,
  targetId: string,
  editedMessage: Record<string, unknown>,
  opts: { type?: unknown; targetJid?: string; fromMe?: boolean } = {},
) {
  return {
    key: { id: editId, remoteJid: chatJid, fromMe: opts.fromMe ?? false },
    message: {
      protocolMessage: {
        key: { remoteJid: opts.targetJid ?? chatJid, fromMe: true, id: targetId },
        type: opts.type ?? "MESSAGE_EDIT",
        editedMessage,
      },
      messageContextInfo: {},
    },
    messageTimestamp: ts,
  };
}

describe("message edits: text fold", () => {
  test("edit folds into original, stub hidden, edited metadata set", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("ORIG1", JID, 1000, "hello world")]);
    store.upsertMessages([
      makeEdit("EDIT1", JID, 1010, "ORIG1", { extendedTextMessage: { text: "hello edited world" } }),
    ]);

    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toBe("hello edited world");
    expect((msgs[0] as Record<string, unknown>).edited).toBe(true);
    expect((msgs[0] as Record<string, unknown>).editedAt).toBe(1010);
    expect((msgs[0] as Record<string, unknown>).editId).toBe("EDIT1");
    // Original timestamp kept for ordering.
    expect(msgs[0]?.messageTimestamp).toBe(1000);

    // Visible count excludes the stub; forensic count includes it.
    expect(store.countMessages(JID)).toBe(1);
    expect(store.countMessages(JID, true)).toBe(2);

    // Opt-in forensics shows the raw stub.
    const withProto = store.getMessages(JID, 50, undefined, { includeProtocol: true });
    expect(withProto.length).toBe(2);
    expect(formatMessage(withProto.find((m) => m.key?.id === "EDIT1"))?.type).toBe("edited");
  });

  test("numeric proto type 14 is detected as an edit", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("ORIG9", JID, 1000, "before")]);
    store.upsertMessages([
      makeEdit("EDIT9", JID, 1010, "ORIG9", { conversation: "after" }, { type: 14 }),
    ]);
    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toBe("after");
  });
});

describe("message edits: captions and chains", () => {
  test("caption edit folds, image type kept", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeImage("IMG1", JID, 1000, "old caption")]);
    store.upsertMessages([
      makeEdit("EDITC1", JID, 1010, "IMG1", {
        imageMessage: { caption: "new caption", mimetype: "image/jpeg" },
      }),
    ]);
    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    const fmt = formatMessage(msgs[0]);
    expect(fmt?.type).toBe("image");
    expect(fmt?.text).toBe("new caption");
    expect(fmt?.edited).toBe(true);
  });

  test("chained edits: latest wins, late older edit ignored", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("ORIG2", JID, 1000, "v0")]);
    store.upsertMessages([
      makeEdit("EDIT2A", JID, 1010, "ORIG2", { conversation: "v1" }),
      makeEdit("EDIT2B", JID, 1020, "ORIG2", { conversation: "v2" }),
    ]);
    expect(formatMessage(store.getMessages(JID, 50)[0])?.text).toBe("v2");
    // An older edit arriving late must not downgrade the target.
    store.upsertMessages([
      makeEdit("EDIT2C", JID, 1005, "ORIG2", { conversation: "stale" }),
    ]);
    expect(formatMessage(store.getMessages(JID, 50)[0])?.text).toBe("v2");
  });
});

describe("message edits: ordering hazards", () => {
  test("edit before original: original insert keeps newest content", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([
      makeEdit("EDIT3", JID, 1010, "ORIG3", { conversation: "edited first" }),
    ]);
    // Synthesized row keeps content visible even before the original lands.
    expect(formatMessage(store.getMessages(JID, 50)[0])?.text).toBe("edited first");
    store.upsertMessages([makeText("ORIG3", JID, 1000, "stale original")]);
    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toBe("edited first");
    expect((msgs[0] as Record<string, unknown>).edited).toBe(true);
  });

  test("edit of missing original synthesizes a visible row, never loses content", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([
      makeEdit("EDIT4", JID, 1010, "GHOST", { conversation: "ghost content" }),
    ]);
    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.key?.id).toBe("GHOST");
    expect(formatMessage(msgs[0])?.text).toBe("ghost content");
    expect((msgs[0] as Record<string, unknown>).edited).toBe(true);
  });

  test("LID/PN mismatch: edit names a different JID form than the stored chat", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("ORIGLID", LID_JID, 1000, "salut sylvain")]);
    store.upsertMessages([
      makeEdit("EDITLID", LID_JID, 1010, "ORIGLID",
        { extendedTextMessage: { text: "salut sylvain, voici le lien https://example.com/x" } },
        { targetJid: PN_JID }),
    ]);
    const msgs = store.getMessages(LID_JID, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toContain("https://example.com/x");
  });
});

describe("message edits: groups, FTS, ordering", () => {
  test("group edit folds like a 1:1 edit", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("GORIG", GROUP, 1000, "sprint lundi")]);
    store.upsertMessages([
      makeEdit("GEDIT", GROUP, 1010, "GORIG", { conversation: "sprint jeudi" }),
    ]);
    const msgs = store.getMessages(GROUP, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toBe("sprint jeudi");
    expect(store.countMessages(GROUP)).toBe(1);
  });

  test("FTS reindexed: new text found, old text gone, stub text not indexed", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([makeText("FORIG", JID, 1000, "alpha bravo")]);
    store.upsertMessages([
      makeEdit("FEDIT", JID, 1010, "FORIG", { conversation: "charlie delta" }),
    ]);
    expect(store.searchMessages("charlie", JID, 10).length).toBe(1);
    expect(store.searchMessages("alpha", JID, 10).length).toBe(0);
    expect(store.searchMessages("message edited", null, 10).length).toBe(0);
    const hits = store.searchMessages("charlie", JID, 10);
    expect(hits[0]?.edited).toBe(true);
  });

  test("order follows original timestamp after folding", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    store.upsertMessages([
      makeText("O1", JID, 1000, "first"),
      makeText("O2", JID, 2000, "second"),
    ]);
    store.upsertMessages([
      makeEdit("EO1", JID, 3000, "O1", { conversation: "first edited" }),
    ]);
    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(2);
    // Newest first by original timestamp: O2 (2000) before O1 (1000).
    expect(msgs[0]?.key?.id).toBe("O2");
    expect(msgs[1]?.key?.id).toBe("O1");
    expect(formatMessage(msgs[1])?.text).toBe("first edited");
  });
});

describe("message edits: zero migration read path", () => {
  test("pre fold rows resolve via backfill without touching stored data", () => {
    const store = new Store({ max_messages_per_chat: 100, max_chats: 10 });
    const orig = makeText("POW", JID, 1000, "original wording");
    const edit = makeEdit("POWE", JID, 1010, "POW", { conversation: "patched wording" });
    // Bypass the fold to simulate a DB written before this fix.
    store.rawSql(`INSERT INTO messages (remoteJid, msgId, data, timestamp, fromMe, text) VALUES (?, ?, ?, ?, ?, ?)`, [
      JID, "POW", JSON.stringify(orig), 1000, 0, "original wording",
    ]);
    store.rawSql(`INSERT INTO messages (remoteJid, msgId, data, timestamp, fromMe, text) VALUES (?, ?, ?, ?, ?, ?)`, [
      JID, "POWE", JSON.stringify(edit), 1010, 0, "[message edited]",
    ]);

    const msgs = store.getMessages(JID, 50);
    expect(msgs.length).toBe(1);
    expect(formatMessage(msgs[0])?.text).toBe("patched wording");
    expect((msgs[0] as Record<string, unknown>).edited).toBe(true);
    expect(store.countMessages(JID)).toBe(1);
  });
});
