/**
 * whats-proxy — Helpers.
 *
 * Faithful TypeScript port of whats-mcp `src/helpers.js`: JID formatting,
 * output envelope builders, media resolution, and message/chat formatting.
 * The output helpers return the `{ meta, data }` envelope (tick-proxy standard)
 * instead of the MCP `{ content, isError }` shape.
 */

import { existsSync, readFileSync } from "node:fs";
import { WhatsProxyError } from "./exceptions";
import type { Output, OutputMeta } from "./types";

// ── JID helpers ──────────────────────────────────────────────────────────────

/** Normalise a phone number to a WhatsApp personal JID. */
export function phoneToJid(phone: string | number): string {
  const str = String(phone);
  // Already a JID (contains @) → pass through — preserves group/newsletter JIDs.
  if (str.includes("@")) return str;
  // Strip +, spaces, dashes, parens from plain phone numbers.
  const clean = str.replace(/[+\s\-()]/g, "");
  return `${clean}@s.whatsapp.net`;
}

/** Normalise a group JID (append @g.us if missing). */
export function groupJid(jid: string): string {
  if (jid.includes("@g.us")) return jid;
  return `${jid}@g.us`;
}

/** Normalise a newsletter/channel JID (append @newsletter if missing). */
export function newsletterJid(jid: string): string {
  if (jid.includes("@newsletter")) return jid;
  return `${jid}@newsletter`;
}

/** Extract the raw number from a JID. */
export function jidToPhone(jid: string): string {
  return (jid || "").split("@")[0]!.split(":")[0]!;
}

/** Check if JID is a group. */
export function isGroupJid(jid: string): boolean {
  return (jid || "").endsWith("@g.us");
}

/** Check if JID is a newsletter/channel. */
export function isNewsletterJid(jid: string): boolean {
  return (jid || "").includes("@newsletter");
}

/** Status broadcast JID (excluded from overviews). */
export const STATUS_BROADCAST = "status@broadcast";

// ── Output envelope helpers ──────────────────────────────────────────────────

/** Build a success envelope: `{ meta: { status:"ok", ... }, data }`. */
export function okResult(
  data: Record<string, unknown>,
  overrides: Partial<OutputMeta> = {},
): Output {
  return {
    meta: { status: "ok", comment: "", edited: false, ...overrides },
    data,
  };
}

/** Build an error envelope: status "error" + message, data carries details. */
export function errResult(
  message: string,
  extra: Record<string, unknown> = {},
): Output {
  return {
    meta: { status: "error", comment: message, edited: false },
    data: { error: message, ...extra },
  };
}

// ── Media helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a media source — supports:
 * - `data:<mime>;base64,...` (data URI)
 * - raw base64 (heuristic: 100+ chars of base64 alphabet)
 * - `http(s)://url` (Baileys downloads it)
 * - `file:///absolute/path`
 * - local file path
 *
 * Returns a Buffer (for paths/base64) or `{ url }` (for URLs) — exactly the
 * shapes Baileys `WAMediaUpload` accepts.
 */
export function resolveMedia(source: string): Buffer | { url: string } {
  if (!source) throw new WhatsProxyError("Media source is required.", "MEDIA_REQUIRED");

  // Data URI
  if (source.startsWith("data:")) {
    const match = source.match(/^data:[^;]+;base64,(.+)$/);
    if (match) return Buffer.from(match[1]!, "base64");
    throw new WhatsProxyError("Invalid base64 data URI.", "MEDIA_INVALID");
  }

  // Raw base64 (no data: prefix, heuristic)
  if (/^[A-Za-z0-9+/=]{100,}$/.test(source)) {
    return Buffer.from(source, "base64");
  }

  // URL
  if (/^https?:\/\//.test(source)) {
    return { url: source };
  }

  // file:// protocol
  if (source.startsWith("file://")) {
    const filePath = source.replace("file://", "");
    return readFileSync(filePath);
  }

  // Local file path
  if (existsSync(source)) {
    return readFileSync(source);
  }

  throw new WhatsProxyError(`Cannot resolve media source: ${source}`, "MEDIA_UNRESOLVED");
}

// ── Message/chat formatting (port of helpers.js formatMessage/formatChat) ──

export interface FormattedMessage {
  id: string | null | undefined;
  from: string | null | undefined;
  from_me: boolean;
  participant: string | null | undefined;
  /** Resolved sender JID: participant (group) or remoteJid (DM). */
  sender: string | null | undefined;
  timestamp: number | undefined;
  type: string;
  text: string;
  push_name: string | null | undefined;
}

/** Format a raw WAMessage for display. */
export function formatMessage(msg: Record<string, unknown> | null | undefined): FormattedMessage | null {
  if (!msg) return null;
  const key = (msg.key || {}) as Record<string, unknown>;
  const content = (msg.message || {}) as Record<string, any>;

  let type = "unknown";
  let text = "";
  if (content.conversation) {
    type = "text";
    text = content.conversation;
  } else if (content.extendedTextMessage) {
    type = "text";
    text = content.extendedTextMessage.text || "";
  } else if (content.imageMessage) {
    type = "image";
    text = content.imageMessage.caption || "[image]";
  } else if (content.videoMessage) {
    type = "video";
    text = content.videoMessage.caption || "[video]";
  } else if (content.audioMessage) {
    type = content.audioMessage.ptt ? "voice_note" : "audio";
    text = "[audio]";
  } else if (content.documentMessage) {
    type = "document";
    text = content.documentMessage.fileName || "[document]";
  } else if (content.documentWithCaptionMessage) {
    const inner = content.documentWithCaptionMessage?.message?.documentMessage;
    type = "document";
    text = inner?.fileName || "[document]";
  } else if (content.stickerMessage) {
    type = "sticker";
    text = "[sticker]";
  } else if (content.locationMessage) {
    type = "location";
    const loc = content.locationMessage;
    text = `[location: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`;
  } else if (content.contactMessage || content.contactsArrayMessage) {
    type = "contact";
    text = "[contact card]";
  } else if (content.reactionMessage) {
    type = "reaction";
    text = content.reactionMessage.text || "";
  } else if (content.pollCreationMessage || content.pollCreationMessageV3) {
    type = "poll";
    const poll = content.pollCreationMessage || content.pollCreationMessageV3;
    text = poll.name || "[poll]";
  } else if (content.protocolMessage) {
    const proto = content.protocolMessage;
    if (proto.type === 0 || proto.type === "REVOKE") {
      type = "deleted";
      text = "[message deleted]";
    } else if (proto.editedMessage) {
      type = "edited";
      text = "[message edited]";
    } else {
      type = "protocol";
      text = "[system message]";
    }
  } else {
    // Fallback: name the type after the first message key.
    const keys = Object.keys(content);
    if (keys.length > 0) {
      type = keys[0]!.replace("Message", "");
      text = `[${type}]`;
    }
  }

  const ts = msg.messageTimestamp
    ? typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp)
    : undefined;

  return {
    id: key.id as string | undefined,
    from: key.remoteJid as string | undefined,
    from_me: Boolean(key.fromMe),
    participant: key.participant as string | undefined,
    sender: (key.participant as string | undefined) || (key.remoteJid as string | undefined),
    timestamp: ts || undefined,
    type,
    text,
    push_name: (msg.pushName as string) || undefined,
  };
}

export interface FormattedChat {
  jid: string;
  name: string;
  unread_count: number;
  is_group: boolean;
  is_newsletter: boolean;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  timestamp: number | undefined;
}

/** Format a chat object for display. */
export function formatChat(chat: Record<string, any>): FormattedChat {
  return {
    jid: chat.id,
    name: chat.name || chat.subject || jidToPhone(chat.id),
    unread_count: chat.unreadCount || 0,
    is_group: isGroupJid(chat.id),
    is_newsletter: isNewsletterJid(chat.id),
    archived: chat.archived || false,
    pinned: Boolean(chat.pinned),
    muted: Boolean(chat.mute),
    timestamp: chat.conversationTimestamp
      ? Number(chat.conversationTimestamp)
      : undefined,
  };
}
