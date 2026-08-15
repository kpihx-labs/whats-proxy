/**
 * whats-proxy — Messaging actions (14).
 *
 * send-text, send-image, send-video, send-audio, send-document, send-sticker,
 * send-location, send-contact, send-reaction, send-poll, edit-message,
 * delete-message, forward-message, batch-send-text.
 *
 * Faithful port of whats-mcp `messaging.js`.
 */

import type { ActionDef } from "./types.ts";
import { phoneToJid, resolveMedia, okResult, errResult } from "../helpers.ts";
import type { AnyMsg } from "../store.ts";

function _buildSendOpts(args: Record<string, unknown>, store: { getMessage(id: string): AnyMsg | null }) {
  const opts: Record<string, unknown> = {};
  if (args.quoted_id) {
    const quoted = store.getMessage(String(args.quoted_id));
    if (quoted) opts.quoted = quoted;
  }
  if (Array.isArray(args.mentions)) {
    opts.mentions = args.mentions;
  }
  return opts;
}

function _fmtSent(result: any, jid: string) {
  return okResult({
    status: "sent",
    jid,
    message_id: result?.key?.id || null,
    timestamp: result?.messageTimestamp
      ? Number(result.messageTimestamp)
      : Math.floor(Date.now() / 1000),
  });
}

export default [
  {
    meta: {
      action: "send-text",
      category: "messaging",
      description:
        "Send a text message to a contact or group. Supports @mentions and replying to a specific message via quoted_id. The jid can be a phone number (e.g. 33612345678) or full JID.",
      arguments: [
        { name: "jid", description: "Recipient: phone number or full JID (e.g. 33612345678@s.whatsapp.net or 120363xxx@g.us)", required: true },
        { name: "text", description: "Message text. Supports WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```code```.", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
        { name: "mentions", description: "Optional: array of JIDs to @mention.", required: false },
      ],
      example: { jid: "33612345678", text: "Hello!" },
      examples: [
        { description: "Direct contact text", payload: { jid: "33612345678", text: "Hello, are you available at 14:00?" } },
        { description: "Formatted group update", payload: { jid: "120363000000000@g.us", text: "*Sprint update*\n- Tests green\n- Review pending" } },
        { description: "Reply and mention", payload: { jid: "120363000000000@g.us", text: "@Alice, noted.", quoted_id: "ABC123", mentions: ["33600000000@s.whatsapp.net"] } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, text, quoted_id, mentions }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { text: String(text) };
      const opts = _buildSendOpts({ quoted_id, mentions }, store);
      if (mentions) content.mentions = mentions;
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-image",
      category: "messaging",
      description: "Send an image to a contact or group. Media source can be a URL (https://...), base64 data, or local file path.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Image source: URL, base64 string, or local file path.", required: true },
        { name: "caption", description: "Optional caption for the image.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/image.jpg", caption: "Look!" },
      examples: [
        { description: "Local image with caption", payload: { jid: "33612345678", source: "/home/user/Pictures/diagram.png", caption: "Architecture diagram" } },
        { description: "Remote image", payload: { jid: "120363000000000@g.us", source: "https://example.com/announcement.jpg", caption: "Announcement" } },
        { description: "Reply with an image", payload: { jid: "33612345678", source: "/home/user/Pictures/receipt.jpg", quoted_id: "ABC123" } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, caption, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { image: resolveMedia(String(source)) as any };
      if (caption) content.caption = caption;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-video",
      category: "messaging",
      description: "Send a video to a contact or group. Set gif_playback=true for a GIF, or ptv=true for a video note (circle).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Video source: URL, base64, or local path.", required: true },
        { name: "caption", description: "Optional caption.", required: false },
        { name: "gif_playback", description: "Send as GIF (auto-playing, no sound). Default false.", required: false },
        { name: "ptv", description: "Send as video note / circle message. Default false.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/video.mp4", caption: "Watch this" },
      examples: [
        { description: "Local video", payload: { jid: "33612345678", source: "/home/user/Videos/demo.mp4", caption: "Demo recording" } },
        { description: "GIF playback", payload: { jid: "120363000000000@g.us", source: "/home/user/Videos/loop.mp4", gif_playback: true } },
        { description: "Video note", payload: { jid: "33612345678", source: "/home/user/Videos/answer.mp4", ptv: true } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, caption, gif_playback, ptv, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { video: resolveMedia(String(source)) as any };
      if (caption) content.caption = caption;
      if (gif_playback) content.gifPlayback = true;
      if (ptv) content.ptv = true;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-audio",
      category: "messaging",
      description: "Send an audio file or voice note. Set ptt=true to send as a voice note (push-to-talk style).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Audio source: URL, base64, or local path.", required: true },
        { name: "ptt", description: "Send as voice note (push-to-talk). Default false.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/audio.mp3", ptt: false },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, ptt, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { audio: resolveMedia(String(source)) as any };
      if (ptt) content.ptt = true;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-document",
      category: "messaging",
      description: "Send a document/file to a contact or group. Supports any file type — specify mimetype and filename.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Document source: URL, base64, or local path.", required: true },
        { name: "filename", description: "Display filename (e.g. 'report.pdf').", required: false },
        { name: "mimetype", description: "MIME type (e.g. 'application/pdf'). Auto-detected if omitted.", required: false },
        { name: "caption", description: "Optional caption.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/report.pdf", filename: "report.pdf" },
      examples: [
        { description: "Local PDF", payload: { jid: "33612345678", source: "/home/user/Documents/report.pdf", filename: "report.pdf", mimetype: "application/pdf" } },
        { description: "Remote document", payload: { jid: "120363000000000@g.us", source: "https://example.com/agenda.pdf", filename: "agenda.pdf" } },
        { description: "Document reply", payload: { jid: "33612345678", source: "/home/user/Documents/answer.pdf", quoted_id: "ABC123" } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, filename, mimetype, caption, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = {
        document: resolveMedia(String(source)) as any,
        mimetype: String(mimetype || "application/octet-stream"),
      };
      if (filename) content.fileName = filename;
      if (caption) content.caption = caption;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-sticker",
      category: "messaging",
      description: "Send a sticker (WebP format recommended).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Sticker image source: URL, base64, or local path (WebP format).", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/sticker.webp" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content = { sticker: resolveMedia(String(source)) as any };
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-location",
      category: "messaging",
      description: "Send a GPS location pin.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "latitude", description: "Latitude (decimal degrees).", required: true },
        { name: "longitude", description: "Longitude (decimal degrees).", required: true },
        { name: "name", description: "Optional location name.", required: false },
        { name: "address", description: "Optional address text.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", latitude: 48.8566, longitude: 2.3522, name: "Paris" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, latitude, longitude, name, address, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = {
        location: {
          degreesLatitude: Number(latitude),
          degreesLongitude: Number(longitude),
        },
      };
      const loc = content.location as Record<string, unknown>;
      if (name) loc.name = name;
      if (address) loc.address = address;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-contact",
      category: "messaging",
      description: "Send one or more contact cards (vCards).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "contacts", description: "Array of { name, phone } objects to send.", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", contacts: [{ name: "Alice", phone: "33600000000" }] },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, contacts, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const list = (contacts as { name: string; phone: string }[]) || [];
      const vCards = list.map((c) => {
        const phone = String(c.phone).replace(/[^0-9+]/g, "");
        return (
          "BEGIN:VCARD\n" +
          "VERSION:3.0\n" +
          `FN:${c.name}\n` +
          `TEL;type=CELL;type=VOICE;waid=${phone.replace("+", "")}:${phone}\n` +
          "END:VCARD"
        );
      });
      const content = {
        contacts: {
          displayName: list.length === 1 ? list[0]!.name : `${list.length} contacts`,
          contacts: vCards.map((vcard) => ({ vcard })),
        },
      };
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "send-reaction",
      category: "messaging",
      description: "React to a message with an emoji. Send an empty emoji string to remove the reaction.",
      arguments: [
        { name: "jid", description: "Chat JID where the message is.", required: true },
        { name: "message_id", description: "ID of the message to react to.", required: true },
        { name: "emoji", description: "Emoji reaction (e.g. '👍', '❤️'). Empty string to remove.", required: true },
        { name: "from_me", description: "Whether the target message was sent by you. Default false.", required: false },
      ],
      example: { jid: "33612345678", message_id: "ABC123", emoji: "👍" },
      returns: "{ status, jid, message_id, emoji }",
    },
    handler: async ({ jid, message_id, emoji, from_me }, { sock }) => {
      const to = phoneToJid(String(jid));
      const content = {
        react: {
          text: String(emoji),
          key: {
            remoteJid: to,
            id: String(message_id),
            fromMe: from_me ?? false,
          },
        },
      };
      await sock.sendMessage(to, content as any);
      return okResult({
        status: emoji ? "reacted" : "reaction_removed",
        jid: to,
        message_id,
        emoji: emoji || null,
      });
    },
  },
  {
    meta: {
      action: "send-poll",
      category: "messaging",
      description: "Create a poll in a chat. By default single-select; set selectable_count > 1 for multi-select.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "question", description: "Poll question text.", required: true },
        { name: "options", description: "Array of poll option strings (2-12).", required: true },
        { name: "selectable_count", description: "How many options can be selected (default 1 = single-select).", required: false },
      ],
      example: { jid: "33612345678", question: "Lunch?", options: ["Pizza", "Sushi"] },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, question, options, selectable_count }, { sock }) => {
      const opts = Array.isArray(options) ? options.map(String) : [];
      if (opts.length < 2) {
        return errResult("A poll requires at least 2 options.");
      }
      const to = phoneToJid(String(jid));
      const content = {
        poll: {
          name: String(question),
          values: opts,
          selectableCount: selectable_count ?? 1,
        },
      };
      const result = await sock.sendMessage(to, content as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "edit-message",
      category: "messaging",
      description: "Edit a previously sent message (text only). You can only edit messages you sent.",
      arguments: [
        { name: "jid", description: "Chat JID where the message is.", required: true },
        { name: "message_id", description: "ID of the message to edit.", required: true },
        { name: "new_text", description: "New text content.", required: true },
      ],
      example: { jid: "33612345678", message_id: "ABC123", new_text: "Updated text" },
      returns: "{ status, jid, message_id }",
    },
    handler: async ({ jid, message_id, new_text }, { sock }) => {
      const to = phoneToJid(String(jid));
      const content = {
        text: String(new_text),
        edit: { remoteJid: to, id: String(message_id), fromMe: true },
      };
      await sock.sendMessage(to, content as any);
      return okResult({ status: "edited", jid: to, message_id });
    },
  },
  {
    meta: {
      action: "delete-message",
      category: "messaging",
      description: "Delete (revoke) a message. You can delete your own messages for everyone, or in groups admins can delete anyone's messages.",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_id", description: "ID of the message to delete.", required: true },
        { name: "from_me", description: "Whether you sent the message. Default true.", required: false },
        { name: "participant", description: "In groups: JID of the message sender (required if from_me=false).", required: false },
      ],
      example: { jid: "33612345678", message_id: "ABC123", from_me: true },
      returns: "{ status, jid, message_id }",
    },
    handler: async ({ jid, message_id, from_me, participant }, { sock }) => {
      const to = phoneToJid(String(jid));
      const key: Record<string, unknown> = {
        remoteJid: to,
        id: String(message_id),
        fromMe: from_me ?? true,
      };
      if (participant) key.participant = participant;
      await sock.sendMessage(to, { delete: key } as any);
      return okResult({ status: "deleted", jid: to, message_id });
    },
  },
  {
    meta: {
      action: "forward-message",
      category: "messaging",
      description: "Forward an existing message to another chat.",
      arguments: [
        { name: "to_jid", description: "Destination JID to forward to.", required: true },
        { name: "message_id", description: "ID of the message to forward.", required: true },
      ],
      example: { to_jid: "33612345678", message_id: "ABC123" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ to_jid, message_id }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) {
        return errResult(`Message ${message_id} not found in store. It must be a recent message.`);
      }
      const to = phoneToJid(String(to_jid));
      const result = await sock.sendMessage(to, { forward: msg, force: true } as any);
      return _fmtSent(result, to);
    },
  },
  {
    meta: {
      action: "batch-send-text",
      category: "messaging",
      description: "Send the same text message to multiple recipients. Returns a summary of successes and failures.",
      arguments: [
        { name: "jids", description: "Array of recipient JIDs or phone numbers.", required: true },
        { name: "text", description: "Message text to send to all recipients.", required: true },
        { name: "delay_ms", description: "Delay in ms between sends to avoid rate-limiting. Default 1000.", required: false },
      ],
      example: { jids: ["33612345678", "33600000000"], text: "Hi all!" },
      examples: [
        { description: "Two contacts", payload: { jids: ["33612345678", "33600000000"], text: "Meeting starts in ten minutes." } },
        { description: "Contacts and a group", payload: { jids: ["33612345678", "120363000000000@g.us"], text: "The document is ready." } },
        { description: "Rate-limited broadcast", payload: { jids: ["33612345678", "33600000000"], text: "*Reminder*\nPlease confirm attendance.", delay_ms: 1500 } },
      ],
      returns: "{ total, sent, failed, results }",
    },
    handler: async ({ jids, text, delay_ms }, { sock }) => {
      const list = Array.isArray(jids) ? jids.map(String) : [];
      if (list.length === 0) {
        return errResult("At least one recipient is required.");
      }
      const delay = delay_ms !== undefined ? Number(delay_ms) : 1000;
      const results: Record<string, unknown>[] = [];
      for (const jid of list) {
        const to = phoneToJid(jid);
        try {
          const r: any = await sock.sendMessage(to, { text: String(text) } as any);
          results.push({ jid: to, status: "sent", message_id: r?.key?.id || null });
        } catch (err) {
          results.push({ jid: to, status: "failed", error: (err as Error).message });
        }
        const idx = list.indexOf(jid);
        if (delay > 0 && idx < list.length - 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      const sent = results.filter((r) => r.status === "sent").length;
      const failed = results.filter((r) => r.status === "failed").length;
      return okResult({ total: list.length, sent, failed, results });
    },
  },
] satisfies ActionDef[];
