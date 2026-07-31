/**
 * whats-proxy — unit tests: helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  phoneToJid,
  groupJid,
  newsletterJid,
  jidToPhone,
  isGroupJid,
  isNewsletterJid,
  STATUS_BROADCAST,
  okResult,
  errResult,
  formatMessage,
  formatChat,
} from "../src/whats_proxy/helpers.ts";

describe("JID helpers", () => {
  test("phoneToJid converts phone to @s.whatsapp.net", () => {
    expect(phoneToJid("33612345678")).toBe("33612345678@s.whatsapp.net");
    expect(phoneToJid(33612345678)).toBe("33612345678@s.whatsapp.net");
  });

  test("groupJid converts to @g.us", () => {
    expect(groupJid("120363000000000")).toBe("120363000000000@g.us");
  });

  test("newsletterJid converts to @newsletter", () => {
    expect(newsletterJid("120363000000000")).toBe("120363000000000@newsletter");
  });

  test("jidToPhone strips the domain", () => {
    expect(jidToPhone("33612345678@s.whatsapp.net")).toBe("33612345678");
  });

  test("isGroupJid / isNewsletterJid", () => {
    expect(isGroupJid("120363000000000@g.us")).toBe(true);
    expect(isGroupJid("33612345678@s.whatsapp.net")).toBe(false);
    expect(isNewsletterJid("120363000000000@newsletter")).toBe(true);
    expect(isNewsletterJid("120363000000000@g.us")).toBe(false);
  });

  test("STATUS_BROADCAST constant", () => {
    expect(STATUS_BROADCAST).toBe("status@broadcast");
  });
});

describe("result helpers", () => {
  test("okResult builds meta+data envelope", () => {
    const r = okResult({ a: 1 });
    expect(r.meta.status).toBe("ok");
    expect(r.meta.comment).toBe("");
    expect(r.meta.edited).toBe(false);
    expect(r.data).toEqual({ a: 1 });
  });

  test("errResult builds error envelope with message", () => {
    const r = errResult("boom");
    expect(r.meta.status).toBe("error");
    expect(r.meta.comment).toBe("boom");
    expect(r.data.error).toBe("boom");
  });
});

describe("formatMessage", () => {
  test("text message", () => {
    const msg = {
      key: { id: "1", remoteJid: "3361@s.whatsapp.net", fromMe: false },
      message: { conversation: "Hello" },
      messageTimestamp: 1700000000,
      pushName: "Bob",
    };
    const f = formatMessage(msg);
    expect(f!.type).toBe("text");
    expect(f!.text).toBe("Hello");
    expect(f!.from_me).toBe(false);
    expect(f!.sender).toBe("3361@s.whatsapp.net");
    expect(f!.timestamp).toBe(1700000000);
  });

  test("image message falls back to caption", () => {
    const msg = {
      key: { id: "2", remoteJid: "3361@s.whatsapp.net", fromMe: true },
      message: { imageMessage: { caption: "pic!" } },
      messageTimestamp: 1700000001,
    };
    const f = formatMessage(msg);
    expect(f!.type).toBe("image");
    expect(f!.text).toBe("pic!");
    expect(f!.from_me).toBe(true);
  });

  test("deleted message via protocolMessage", () => {
    const msg = {
      key: { id: "3", remoteJid: "3361@s.whatsapp.net", fromMe: false },
      message: { protocolMessage: { type: 0 } },
      messageTimestamp: 1700000002,
    };
    const f = formatMessage(msg);
    expect(f!.type).toBe("deleted");
  });

  test("null message → null", () => {
    expect(formatMessage(null)).toBeNull();
    expect(formatMessage(undefined)).toBeNull();
  });
});

describe("formatChat", () => {
  test("formats chat fields", () => {
    const chat = {
      id: "3361@s.whatsapp.net",
      name: "Bob",
      unreadCount: 3,
      lastMessage: { key: { id: "9" }, message: { conversation: "hi" } },
    };
    const f = formatChat(chat);
    expect(f.jid).toBe("3361@s.whatsapp.net");
    expect(f.name).toBe("Bob");
    expect(f.unread_count).toBe(3);
  });
});
