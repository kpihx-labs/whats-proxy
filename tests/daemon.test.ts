import { describe, expect, test } from "bun:test";
import { proto } from "@whiskeysockets/baileys";

import { persistDirectMessageStatuses } from "../src/whats_proxy/daemon.ts";

describe("persistDirectMessageStatuses", () => {
  test("persists delivery, read, and played statuses for outgoing direct messages", () => {
    const receipts: unknown[][] = [];
    const store = { addReceipt: (...args: unknown[]) => receipts.push(args) };
    const jid = "157716198781074@lid";

    persistDirectMessageStatuses([
      { key: { id: "delivery", remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK, messageTimestamp: 100 } },
      { key: { id: "read", remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ, messageTimestamp: 200 } },
      { key: { id: "played", remoteJid: jid, fromMe: true }, update: { status: proto.WebMessageInfo.Status.PLAYED, messageTimestamp: 300 } },
    ], store);

    expect(receipts).toEqual([
      ["delivery", jid, jid, "delivered", 100],
      ["read", jid, jid, "read", 200],
      ["played", jid, jid, "played", 300],
    ]);
  });

  test("ignores incoming, group, status, and unrecognized updates", () => {
    const receipts: unknown[][] = [];
    const store = { addReceipt: (...args: unknown[]) => receipts.push(args) };

    persistDirectMessageStatuses([
      { key: { id: "incoming", remoteJid: "a@lid", fromMe: false }, update: { status: proto.WebMessageInfo.Status.READ } },
      { key: { id: "group", remoteJid: "123@g.us", fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } },
      { key: { id: "status", remoteJid: "status@broadcast", fromMe: true }, update: { status: proto.WebMessageInfo.Status.READ } },
      { key: { id: "server", remoteJid: "a@lid", fromMe: true }, update: { status: proto.WebMessageInfo.Status.SERVER_ACK } },
    ], store);

    expect(receipts).toEqual([]);
  });
});
